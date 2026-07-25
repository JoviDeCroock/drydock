import { describe, expect, test } from "vitest";
import {
  createPyPiReleaseCandidateReview,
  inferPyPiArtifactKind,
  isAllowedPyPiArtifactUrl,
  normalizePyPiProjectName,
  parsePyPiReleaseManifest,
  pickPyPiBaselineRelease,
  pypiAdapter,
  preparePyPiArtifact,
  selectPyPiReleaseArtifacts,
} from "../server/lib/adapters/pypi";
import { createPackageDiff } from "../server/lib/review";

function file(path, textSample, extra = {}) {
  return {
    path,
    size: textSample.length,
    sha256: `sha-${path}`,
    flags: [],
    textSample,
    ...extra,
  };
}

const adapterCtx = { env: {}, executionCtx: {}, db: {}, session: { userId: "user_1" } };

// Network-free PyPI broker. Tests inject the project metadata and a map of
// artifact-url -> parsed files so the adapter download path can be exercised
// without touching pypi.org or the sandbox loader.
function stubBroker({ metadata = null, downloads = {} } = {}) {
  const calls = [];
  return {
    calls,
    broker: {
      async fetchProjectMetadata() {
        return metadata;
      },
      async downloadPublicArtifact(artifact) {
        calls.push(artifact);
        const files = downloads[artifact.url];
        if (!files) throw new Error(`unexpected download for ${artifact.url}`);
        return { files, packageJson: null };
      },
      dispose() {},
    },
  };
}

function wheelArtifactFiles(version) {
  return [
    file(
      `demo_package-${version}.dist-info/METADATA`,
      `Metadata-Version: 2.3\nName: demo-package\nVersion: ${version}\n`,
    ),
    file(
      `demo_package-${version}.dist-info/WHEEL`,
      "Wheel-Version: 1.0\nRoot-Is-Purelib: true\nTag: py3-none-any\n",
      { sha256: "sha-wheel-metadata" },
    ),
    file(`demo_package-${version}.dist-info/RECORD`, "demo_package/__init__.py,,\n", {
      sha256: "sha-wheel-record",
    }),
    file("demo_package/__init__.py", "VALUE = 1\n", { sha256: "sha-init-shared" }),
  ];
}

describe("PyPI release manifests", () => {
  test("validates PyPI manifest shape and artifact kinds", () => {
    const manifest = parsePyPiReleaseManifest({
      schema: "drydock.release-artifacts.v1",
      ecosystem: "pypi",
      package: "Demo_Package",
      version: "1.2.0",
      artifacts: [
        {
          path: "dist/demo_package-1.2.0-py3-none-any.whl",
          sha256: "a".repeat(64),
          url: "https://example.com/artifacts/demo_package-1.2.0-py3-none-any.whl",
        },
        {
          path: "dist/demo_package-1.2.0.tar.gz",
          sha256: "b".repeat(64),
        },
      ],
    });

    expect(normalizePyPiProjectName(manifest.package)).toBe("demo-package");
    expect(manifest.artifacts.map((artifact) => artifact.kind)).toEqual(["wheel", "sdist"]);
    expect(inferPyPiArtifactKind("demo-1.0.0.zip")).toBeNull();
  });

  test("rejects unsafe manifest artifact paths", () => {
    expect(() =>
      parsePyPiReleaseManifest({
        schema: "drydock.release-artifacts.v1",
        ecosystem: "pypi",
        package: "demo",
        version: "1.0.0",
        artifacts: [{ path: "../demo-1.0.0.whl", sha256: "a".repeat(64) }],
      }),
    ).toThrow(/path is not safe/);
  });
});

describe("PyPI artifact summaries and review", () => {
  test("strips the common sdist root and reads PKG-INFO metadata", () => {
    const prepared = preparePyPiArtifact({
      path: "dist/demo_package-1.2.0.tar.gz",
      files: [
        file(
          "demo_package-1.2.0/PKG-INFO",
          "Metadata-Version: 2.3\nName: demo-package\nVersion: 1.2.0\n",
        ),
        file("demo_package-1.2.0/demo_package/__init__.py", "VALUE = 1\n"),
      ],
    });

    expect(prepared.files.map((entry) => entry.path)).toEqual([
      "PKG-INFO",
      "demo_package/__init__.py",
    ]);
    expect(prepared.summary).toMatchObject({
      kind: "sdist",
      metadataPath: "PKG-INFO",
      name: "demo-package",
      version: "1.2.0",
    });
  });

  test("keeps per-artifact rule evidence on every platform wheel", () => {
    // `pthExecution` fires once per artifact and reads its severity, evidence,
    // and line from the file body. Compacting a byte-identical `.pth` down to
    // one copy would leave the siblings reporting medium / ".pth file included
    // in wheel" for content that does contain an import line.
    const platforms = ["macosx_11_0_arm64", "manylinux_x86_64", "win_amd64"];
    const paths = platforms.map(
      (platform) => `dist/demo_package-1.2.0-cp312-cp312-${platform}.whl`,
    );
    const wheelFiles = (platform) => [
      file(
        "demo_package-1.2.0.dist-info/METADATA",
        "Metadata-Version: 2.3\nName: demo-package\nVersion: 1.2.0\n",
      ),
      file(
        "demo_package-1.2.0.dist-info/WHEEL",
        `Wheel-Version: 1.0\nRoot-Is-Purelib: false\nTag: cp312-cp312-${platform}\n`,
      ),
      file("demo_package-1.2.0.dist-info/RECORD", "demo_package/__init__.py,,\n"),
      file("sitecustomize.pth", "import demo_package.bootstrap\n"),
    ];
    const review = createPyPiReleaseCandidateReview({
      manifest: parsePyPiReleaseManifest({
        schema: "drydock.release-artifacts.v1",
        ecosystem: "pypi",
        package: "demo-package",
        version: "1.2.0",
        artifacts: paths.map((path, index) => ({ path, sha256: `${index}a`.repeat(32) })),
      }),
      artifacts: paths.map((path, index) => ({ path, files: wheelFiles(platforms[index]) })),
    });

    const pth = review.ruleFindings.filter((finding) => finding.ruleId === "pypi.pth-execution");
    expect(pth.map((finding) => finding.file)).toEqual(
      paths.map((path) => `${path}/sitecustomize.pth`),
    );
    expect(pth.map((finding) => finding.severity)).toEqual(["high", "high", "high"]);
    expect(new Set(pth.map((finding) => finding.evidence))).toEqual(
      new Set([".pth file contains an import line"]),
    );
  });

  test("creates deterministic PyPI findings for wheel startup hooks and setup.py install commands", () => {
    const manifest = parsePyPiReleaseManifest({
      schema: "drydock.release-artifacts.v1",
      ecosystem: "pypi",
      package: "demo-package",
      version: "1.2.0",
      artifacts: [
        { path: "dist/demo_package-1.2.0-py3-none-any.whl", sha256: "a".repeat(64) },
        { path: "dist/demo_package-1.2.0.tar.gz", sha256: "b".repeat(64) },
      ],
    });
    const review = createPyPiReleaseCandidateReview({
      manifest,
      artifacts: [
        {
          path: "dist/demo_package-1.2.0-py3-none-any.whl",
          files: [
            file(
              "demo_package-1.2.0.dist-info/METADATA",
              "Metadata-Version: 2.3\nName: demo-package\nVersion: 1.2.0\nRequires-Dist: requests>=2\n",
            ),
            file(
              "demo_package-1.2.0.dist-info/WHEEL",
              "Wheel-Version: 1.0\nRoot-Is-Purelib: true\nTag: py3-none-any\n",
            ),
            file("demo_package-1.2.0.dist-info/RECORD", "demo_package/__init__.py,,\n"),
            file("sitecustomize.pth", "import demo_package.bootstrap\n"),
          ],
        },
        {
          path: "dist/demo_package-1.2.0.tar.gz",
          files: [
            file(
              "demo_package-1.2.0/PKG-INFO",
              "Metadata-Version: 2.3\nName: demo-package\nVersion: 1.2.0\n",
            ),
            file(
              "demo_package-1.2.0/setup.py",
              "from setuptools.command.install import install\nsetup(cmdclass={'install': install})\n",
            ),
          ],
        },
      ],
    });

    expect(review.package).toEqual({ name: "demo-package", version: "1.2.0" });
    expect(review.risk).toBe("high");
    expect(review.ruleFindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "high",
          ruleId: "pypi.pth-execution",
          file: "dist/demo_package-1.2.0-py3-none-any.whl/sitecustomize.pth",
        }),
        expect.objectContaining({
          severity: "high",
          ruleId: "pypi.setup-install-command",
          file: "dist/demo_package-1.2.0.tar.gz/setup.py",
        }),
      ]),
    );
  });

  test("summarizeDetails surfaces reviewed wheel/sdist digests as a provenance block", async () => {
    const input = pypiAdapter.parseInput({
      manifest: {
        schema: "drydock.release-artifacts.v1",
        ecosystem: "pypi",
        package: "demo-package",
        version: "1.2.0",
        artifacts: [
          { path: "dist/demo_package-1.2.0-py3-none-any.whl", sha256: "a".repeat(64) },
          { path: "dist/demo_package-1.2.0.tar.gz", sha256: "b".repeat(64) },
        ],
      },
      artifacts: [
        { path: "dist/demo_package-1.2.0-py3-none-any.whl", files: wheelArtifactFiles("1.2.0") },
        {
          path: "dist/demo_package-1.2.0.tar.gz",
          files: [
            file(
              "demo_package-1.2.0/PKG-INFO",
              "Metadata-Version: 2.3\nName: demo-package\nVersion: 1.2.0\n",
            ),
          ],
        },
      ],
    });
    const staged = await pypiAdapter.acquireStaged(adapterCtx, input, stubBroker().broker);
    // Provenance binds the report to the digests the gate recomputed from the
    // immutable bytes, mirroring the npm gate. The kind is content-derived so the
    // publish job can verify each wheel/sdist independently.
    expect(pypiAdapter.summarizeDetails(staged.details).provenance).toEqual({
      ecosystem: "pypi",
      mode: "workflow_gate",
      artifacts: [
        { path: "dist/demo_package-1.2.0-py3-none-any.whl", kind: "wheel", sha256: "a".repeat(64) },
        { path: "dist/demo_package-1.2.0.tar.gz", kind: "sdist", sha256: "b".repeat(64) },
      ],
    });
  });

  test("surfaces content-skipped tar entries as findings instead of dropping them", () => {
    const manifest = parsePyPiReleaseManifest({
      schema: "drydock.release-artifacts.v1",
      ecosystem: "pypi",
      package: "demo-package",
      version: "1.2.0",
      artifacts: [{ path: "dist/demo_package-1.2.0.tar.gz", sha256: "b".repeat(64) }],
    });

    const review = createPyPiReleaseCandidateReview({
      manifest,
      artifacts: [
        {
          path: "dist/demo_package-1.2.0.tar.gz",
          files: [
            file(
              "demo_package-1.2.0/PKG-INFO",
              "Metadata-Version: 2.3\nName: demo-package\nVersion: 1.2.0\n",
            ),
            {
              path: "demo_package-1.2.0/big.so",
              size: 50_000_000,
              sha256: "",
              flags: ["content-skipped"],
            },
          ],
          suspiciousEntries: [
            {
              kind: "content-skipped",
              path: "demo_package-1.2.0/big.so",
              detail:
                "file body (50000000 bytes) exceeds the 26214400-byte per-file inspection limit",
            },
          ],
        },
      ],
    });

    // The sdist archive root is stripped from the evidence path, matching the
    // prepared file list ("big.so"), so the finding pins to a real file.
    expect(review.ruleFindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "tar.suspicious-entry",
          severity: "medium",
          file: "dist/demo_package-1.2.0.tar.gz/big.so",
        }),
      ]),
    );
  });

  test("drops ordinary sdist directories and keeps unsafe non-regular entries", () => {
    const manifest = parsePyPiReleaseManifest({
      schema: "drydock.release-artifacts.v1",
      ecosystem: "pypi",
      package: "demo-package",
      version: "1.2.0",
      artifacts: [{ path: "dist/demo_package-1.2.0.tar.gz", sha256: "b".repeat(64) }],
    });

    const review = createPyPiReleaseCandidateReview({
      manifest,
      artifacts: [
        {
          path: "dist/demo_package-1.2.0.tar.gz",
          files: [
            file(
              "demo_package-1.2.0/PKG-INFO",
              "Metadata-Version: 2.3\nName: demo-package\nVersion: 1.2.0\n",
            ),
          ],
          suspiciousEntries: [
            // setuptools always emits explicit directory records, so these are
            // the archive norm on PyPI — not the provenance signal they are for
            // `npm pack` tarballs.
            { kind: "non-regular", path: "demo_package-1.2.0", detail: "typeflag 5 (directory)" },
            {
              kind: "non-regular",
              path: "demo_package-1.2.0/tests",
              detail: "typeflag 5 (directory)",
            },
            {
              kind: "non-regular",
              path: "demo_package-1.2.0/evil",
              detail: "typeflag 2 (symlink)",
            },
            {
              kind: "non-regular",
              path: "../../outside",
              detail: "typeflag 5 (directory)",
            },
            {
              kind: "non-regular",
              path: "demo_package-1.2.0/tests\u200b/certs",
              detail: "typeflag 5 (directory)",
            },
          ],
        },
      ],
    });

    const tarFindings = review.ruleFindings.filter(
      (finding) => finding.ruleId === "tar.suspicious-entry",
    );
    expect(tarFindings).toHaveLength(3);
    expect(tarFindings.map((finding) => finding.file)).toEqual([
      "dist/demo_package-1.2.0.tar.gz/evil",
      "dist/demo_package-1.2.0.tar.gz/../../outside",
      "dist/demo_package-1.2.0.tar.gz/tests\u200b/certs",
    ]);
    for (const finding of tarFindings) {
      expect(finding.reason).toContain("Python build backends");
      expect(finding.reason).not.toContain("npm");
    }
  });

  test("does not flag PEP 440-equivalent version spellings as metadata mismatches", () => {
    const manifest = parsePyPiReleaseManifest({
      schema: "drydock.release-artifacts.v1",
      ecosystem: "pypi",
      package: "demo-package",
      version: "1.2.0-final",
      artifacts: [{ path: "dist/demo_package-1.2.0-py3-none-any.whl", sha256: "a".repeat(64) }],
    });
    const review = createPyPiReleaseCandidateReview({
      manifest,
      artifacts: [
        {
          path: "dist/demo_package-1.2.0-py3-none-any.whl",
          files: [
            file(
              "demo_package-1.2.0.dist-info/METADATA",
              "Metadata-Version: 2.3\nName: demo-package\nVersion: 1.2.0\n",
            ),
          ],
        },
      ],
    });

    expect(
      review.ruleFindings.filter((finding) => finding.ruleId === "pypi.metadata-mismatch"),
    ).toEqual([]);
  });

  test("still flags genuinely different artifact versions as critical", () => {
    const manifest = parsePyPiReleaseManifest({
      schema: "drydock.release-artifacts.v1",
      ecosystem: "pypi",
      package: "demo-package",
      version: "1.3.0",
      artifacts: [{ path: "dist/demo_package-1.3.0-py3-none-any.whl", sha256: "a".repeat(64) }],
    });
    const review = createPyPiReleaseCandidateReview({
      manifest,
      artifacts: [
        {
          path: "dist/demo_package-1.3.0-py3-none-any.whl",
          files: [
            file(
              "demo_package-1.3.0.dist-info/METADATA",
              "Metadata-Version: 2.3\nName: demo-package\nVersion: 1.2.0\n",
            ),
          ],
        },
      ],
    });

    expect(review.ruleFindings).toContainEqual(
      expect.objectContaining({ severity: "critical", ruleId: "pypi.metadata-mismatch" }),
    );
  });

  test("marks manifest and artifact metadata mismatches as critical", () => {
    const manifest = parsePyPiReleaseManifest({
      schema: "drydock.release-artifacts.v1",
      ecosystem: "pypi",
      package: "demo-package",
      version: "1.2.0",
      artifacts: [{ path: "dist/demo_package-1.2.0-py3-none-any.whl", sha256: "a".repeat(64) }],
    });
    const review = createPyPiReleaseCandidateReview({
      manifest,
      artifacts: [
        {
          path: "dist/demo_package-1.2.0-py3-none-any.whl",
          files: [
            file(
              "demo_package-1.2.0.dist-info/METADATA",
              "Metadata-Version: 2.3\nName: other-package\nVersion: 1.2.0\n",
            ),
          ],
        },
      ],
    });

    expect(review.risk).toBe("critical");
    expect(review.ruleFindings).toContainEqual(
      expect.objectContaining({
        severity: "critical",
        ruleId: "pypi.metadata-mismatch",
      }),
    );
  });

  test("keeps auditing wheel RECORD entries when METADATA is missing", () => {
    const manifest = parsePyPiReleaseManifest({
      schema: "drydock.release-artifacts.v1",
      ecosystem: "pypi",
      package: "demo-package",
      version: "1.2.0",
      artifacts: [{ path: "dist/demo_package-1.2.0-py3-none-any.whl", sha256: "a".repeat(64) }],
    });
    const review = createPyPiReleaseCandidateReview({
      manifest,
      artifacts: [
        {
          path: "dist/demo_package-1.2.0-py3-none-any.whl",
          files: [
            file(
              "demo_package-1.2.0.dist-info/WHEEL",
              "Wheel-Version: 1.0\nRoot-Is-Purelib: true\nTag: py3-none-any\n",
            ),
            file(
              "demo_package-1.2.0.dist-info/RECORD",
              "demo_package-1.2.0.dist-info/WHEEL,,\ndemo_package-1.2.0.dist-info/RECORD,,\n",
            ),
            file("demo_package/payload.py", "# undeclared payload\n"),
          ],
        },
      ],
    });

    expect(review.ruleFindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "medium",
          ruleId: "pypi.metadata-missing",
          file: "dist/demo_package-1.2.0-py3-none-any.whl/METADATA",
        }),
        expect.objectContaining({
          severity: "high",
          ruleId: "pypi.record-mismatch",
          file: "dist/demo_package-1.2.0-py3-none-any.whl/demo_package/payload.py",
        }),
      ]),
    );
  });

  test("treats an empty wheel RECORD as declaring no files", () => {
    const manifest = parsePyPiReleaseManifest({
      schema: "drydock.release-artifacts.v1",
      ecosystem: "pypi",
      package: "demo-package",
      version: "1.2.0",
      artifacts: [{ path: "dist/demo_package-1.2.0-py3-none-any.whl", sha256: "a".repeat(64) }],
    });
    const review = createPyPiReleaseCandidateReview({
      manifest,
      artifacts: [
        {
          path: "dist/demo_package-1.2.0-py3-none-any.whl",
          files: [
            file(
              "demo_package-1.2.0.dist-info/METADATA",
              "Metadata-Version: 2.3\nName: demo-package\nVersion: 1.2.0\n",
            ),
            file(
              "demo_package-1.2.0.dist-info/WHEEL",
              "Wheel-Version: 1.0\nRoot-Is-Purelib: true\nTag: py3-none-any\n",
            ),
            file("demo_package-1.2.0.dist-info/RECORD", "\n\n"),
            file("demo_package/payload.py", "# undeclared payload\n"),
          ],
        },
      ],
    });

    expect(review.ruleFindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "high",
          ruleId: "pypi.record-mismatch",
          file: "dist/demo_package-1.2.0-py3-none-any.whl/demo_package/payload.py",
        }),
      ]),
    );
  });

  test("only treats the top-level sdist setup.py as install-time code", () => {
    const manifest = parsePyPiReleaseManifest({
      schema: "drydock.release-artifacts.v1",
      ecosystem: "pypi",
      package: "demo-package",
      version: "1.2.0",
      artifacts: [
        { path: "dist/demo_package-1.2.0-py3-none-any.whl", sha256: "a".repeat(64) },
        { path: "dist/demo_package-1.2.0.tar.gz", sha256: "b".repeat(64) },
      ],
    });
    const review = createPyPiReleaseCandidateReview({
      manifest,
      artifacts: [
        {
          path: "dist/demo_package-1.2.0-py3-none-any.whl",
          files: [
            file(
              "demo_package-1.2.0.dist-info/METADATA",
              "Metadata-Version: 2.3\nName: demo-package\nVersion: 1.2.0\n",
            ),
            file(
              "demo_package-1.2.0.dist-info/WHEEL",
              "Wheel-Version: 1.0\nRoot-Is-Purelib: true\nTag: py3-none-any\n",
            ),
            file(
              "demo_package-1.2.0.dist-info/RECORD",
              "demo_package/setup.py,,\ndemo_package-1.2.0.dist-info/METADATA,,\ndemo_package-1.2.0.dist-info/WHEEL,,\ndemo_package-1.2.0.dist-info/RECORD,,\n",
            ),
            file("demo_package/setup.py", 'import os\nos.system("id")\n'),
          ],
        },
        {
          path: "dist/demo_package-1.2.0.tar.gz",
          files: [
            file(
              "demo_package-1.2.0/PKG-INFO",
              "Metadata-Version: 2.3\nName: demo-package\nVersion: 1.2.0\n",
            ),
            file("demo_package-1.2.0/demo_package/setup.py", 'import os\nos.system("id")\n'),
          ],
        },
      ],
    });

    expect(
      review.ruleFindings.some((finding) => finding.ruleId === "pypi.setup-install-command"),
    ).toBe(false);
    expect(review.ruleFindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "code.process-execution",
          file: "wheel/py3-none-any/demo_package/setup.py",
        }),
        expect.objectContaining({
          ruleId: "code.process-execution",
          file: "sdist/demo_package/setup.py",
        }),
      ]),
    );
  });

  test("does not treat sdist root files as installed startup hooks", () => {
    const manifest = parsePyPiReleaseManifest({
      schema: "drydock.release-artifacts.v1",
      ecosystem: "pypi",
      package: "demo-package",
      version: "1.2.0",
      artifacts: [{ path: "dist/demo_package-1.2.0.tar.gz", sha256: "b".repeat(64) }],
    });
    const review = createPyPiReleaseCandidateReview({
      manifest,
      artifacts: [
        {
          path: "dist/demo_package-1.2.0.tar.gz",
          files: [
            file(
              "demo_package-1.2.0/PKG-INFO",
              "Metadata-Version: 2.3\nName: demo-package\nVersion: 1.2.0\n",
            ),
            file("demo_package-1.2.0/sitecustomize.py", "# source helper\n"),
            file("demo_package-1.2.0/inject.pth", "import demo_package.bootstrap\n"),
          ],
        },
      ],
    });

    expect(review.ruleFindings).toEqual([]);
  });

  test("detects secret-looking content before redacting PyPI evidence", () => {
    const manifest = parsePyPiReleaseManifest({
      schema: "drydock.release-artifacts.v1",
      ecosystem: "pypi",
      package: "demo-package",
      version: "1.2.0",
      artifacts: [{ path: "dist/demo_package-1.2.0-py3-none-any.whl", sha256: "a".repeat(64) }],
    });
    const review = createPyPiReleaseCandidateReview({
      manifest,
      artifacts: [
        {
          path: "dist/demo_package-1.2.0-py3-none-any.whl",
          files: [
            file(
              "demo_package-1.2.0.dist-info/METADATA",
              "Metadata-Version: 2.3\nName: demo-package\nVersion: 1.2.0\n",
            ),
            file(
              "demo_package-1.2.0.dist-info/WHEEL",
              "Wheel-Version: 1.0\nRoot-Is-Purelib: true\nTag: py3-none-any\n",
            ),
            file("demo_package-1.2.0.dist-info/RECORD", "demo_package/secret.py,,\n"),
            file("demo_package/secret.py", "TOKEN = 'ghp_aaaaaaaaaaaaaaaaaaaa'\n"),
          ],
        },
      ],
    });

    expect(review.ruleFindings).toContainEqual(
      expect.objectContaining({
        severity: "critical",
        ruleId: "file.secret-content",
        file: "wheel/py3-none-any/demo_package/secret.py",
      }),
    );
  });

  test("requires reviewed artifacts to exactly match the manifest", () => {
    const manifest = parsePyPiReleaseManifest({
      schema: "drydock.release-artifacts.v1",
      ecosystem: "pypi",
      package: "demo-package",
      version: "1.2.0",
      artifacts: [
        { path: "dist/demo_package-1.2.0-py3-none-any.whl", sha256: "a".repeat(64) },
        { path: "dist/demo_package-1.2.0.tar.gz", sha256: "b".repeat(64) },
      ],
    });

    expect(() =>
      createPyPiReleaseCandidateReview({
        manifest,
        artifacts: [
          {
            path: "dist/demo_package-1.2.0-py3-none-any.whl",
            files: [
              file(
                "demo_package-1.2.0.dist-info/METADATA",
                "Metadata-Version: 2.3\nName: demo-package\nVersion: 1.2.0\n",
              ),
            ],
          },
        ],
      }),
    ).toThrow(/exactly match manifest artifacts/);
  });

  test("compares PyPI files through stable artifact namespaces across versions", () => {
    const manifest = parsePyPiReleaseManifest({
      schema: "drydock.release-artifacts.v1",
      ecosystem: "pypi",
      package: "demo-package",
      version: "1.2.0",
      artifacts: [
        { path: "dist/demo_package-1.2.0-py3-none-any.whl", sha256: "a".repeat(64) },
        { path: "dist/demo_package-1.2.0.tar.gz", sha256: "b".repeat(64) },
      ],
    });
    const wheelFiles = (version) => [
      file(
        `demo_package-${version}.dist-info/METADATA`,
        `Metadata-Version: 2.3\nName: demo-package\nVersion: ${version}\n`,
      ),
      file(
        `demo_package-${version}.dist-info/WHEEL`,
        "Wheel-Version: 1.0\nRoot-Is-Purelib: true\nTag: py3-none-any\n",
        { sha256: "sha-wheel-metadata" },
      ),
      file(`demo_package-${version}.dist-info/RECORD`, "demo_package/__init__.py,,\n", {
        sha256: "sha-wheel-record",
      }),
      file("demo_package/__init__.py", "VALUE = 1\n"),
    ];
    const sdistFiles = (version) => [
      file(
        `demo_package-${version}/PKG-INFO`,
        `Metadata-Version: 2.3\nName: demo-package\nVersion: ${version}\n`,
      ),
      file(`demo_package-${version}/demo_package/__init__.py`, "VALUE = 1\n", {
        sha256: "sha-sdist-init",
      }),
    ];

    const review = createPyPiReleaseCandidateReview({
      manifest,
      artifacts: [
        { path: "dist/demo_package-1.2.0-py3-none-any.whl", files: wheelFiles("1.2.0") },
        { path: "dist/demo_package-1.2.0.tar.gz", files: sdistFiles("1.2.0") },
      ],
      previousArtifacts: [
        { path: "dist/demo_package-1.1.0-py3-none-any.whl", files: wheelFiles("1.1.0") },
        { path: "dist/demo_package-1.1.0.tar.gz", files: sdistFiles("1.1.0") },
      ],
    });

    expect(review.diff).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "wheel/py3-none-any/demo_package/__init__.py",
          status: "unchanged",
        }),
        expect.objectContaining({
          path: "wheel/py3-none-any/.dist-info/METADATA",
          status: "modified",
        }),
        expect.objectContaining({
          path: "sdist/demo_package/__init__.py",
          status: "unchanged",
        }),
      ]),
    );
    expect(
      review.diff.some((entry) => entry.path.includes("demo_package-1.2.0-py3-none-any.whl")),
    ).toBe(false);
  });

  test("exposes PyPI review through the package adapter contract", async () => {
    const manifest = parsePyPiReleaseManifest({
      schema: "drydock.release-artifacts.v1",
      ecosystem: "pypi",
      package: "demo-package",
      version: "1.2.0",
      artifacts: [{ path: "dist/demo_package-1.2.0-py3-none-any.whl", sha256: "a".repeat(64) }],
    });
    const input = pypiAdapter.parseInput({
      manifest,
      artifacts: [
        {
          path: "dist/demo_package-1.2.0-py3-none-any.whl",
          files: [
            file(
              "demo_package-1.2.0.dist-info/METADATA",
              "Metadata-Version: 2.3\nName: demo-package\nVersion: 1.2.0\n",
            ),
            file(
              "demo_package-1.2.0.dist-info/WHEEL",
              "Wheel-Version: 1.0\nRoot-Is-Purelib: true\nTag: py3-none-any\n",
            ),
            file("demo_package-1.2.0.dist-info/RECORD", "demo_package/__init__.py,,\n"),
          ],
        },
      ],
    });
    const created = pypiAdapter.createBroker(adapterCtx, { organizationId: "org_1" });
    expect(typeof created.fetchProjectMetadata).toBe("function");
    expect(typeof created.downloadPublicArtifact).toBe("function");

    const { broker, calls } = stubBroker({ metadata: null });
    const staged = await pypiAdapter.acquireStaged(adapterCtx, input, broker);
    const baseline = await pypiAdapter.acquireBaseline(adapterCtx, input, broker, staged);
    const summary = pypiAdapter.describe({
      input,
      staged: staged.artifact,
      details: staged.details,
      baseline: baseline.baseline,
      previous: baseline.artifact,
    });

    expect(pypiAdapter.id).toBe("pypi");
    expect(summary).toMatchObject({
      name: "demo-package",
      stagedVersion: "1.2.0",
      stagedTag: null,
      previousVersion: null,
    });
    expect(staged.artifact.files.map((entry) => entry.path)).toEqual([
      "wheel/py3-none-any/.dist-info/METADATA",
      "wheel/py3-none-any/.dist-info/WHEEL",
      "wheel/py3-none-any/.dist-info/RECORD",
    ]);
    // No published metadata available -> no baseline download attempted.
    expect(calls).toHaveLength(0);
    expect(baseline.artifact).toBeNull();
    expect(baseline.baseline).toMatchObject({
      version: null,
      source: "none",
      reason: "metadata-unavailable",
    });
  });
});

describe("PyPI registry metadata helpers", () => {
  test("picks the latest published release as the default baseline", () => {
    const metadata = {
      info: { version: "1.1.0" },
      releases: {
        "1.0.0": [
          {
            filename: "demo-1.0.0.tar.gz",
            url: "https://files.pythonhosted.org/packages/demo-1.0.0.tar.gz",
            upload_time_iso_8601: "2026-01-01T00:00:00.000Z",
          },
        ],
        "1.1.0": [
          {
            filename: "demo-1.1.0-py3-none-any.whl",
            url: "https://files.pythonhosted.org/packages/demo-1.1.0-py3-none-any.whl",
            upload_time_iso_8601: "2026-02-01T00:00:00.000Z",
          },
        ],
      },
    };

    expect(pickPyPiBaselineRelease(metadata, "1.2.0")).toEqual({
      version: "1.1.0",
      source: "latest-published",
      reason: "project-json-info-version",
    });
  });

  test("falls back to upload time and selects wheel/sdist artifact metadata", () => {
    const metadata = {
      info: { version: "2.0.0" },
      releases: {
        "1.1.0": [
          {
            filename: "demo-1.1.0-py3-none-any.whl",
            packagetype: "bdist_wheel",
            url: "https://files.pythonhosted.org/packages/demo-1.1.0-py3-none-any.whl",
            digests: { sha256: "c".repeat(64) },
            upload_time_iso_8601: "2026-02-01T00:00:00.000Z",
            size: 1234,
          },
          {
            filename: "demo-1.1.0.tar.gz",
            packagetype: "sdist",
            url: "https://files.pythonhosted.org/packages/demo-1.1.0.tar.gz",
            digests: { sha256: "d".repeat(64) },
            upload_time_iso_8601: "2026-02-01T00:00:00.000Z",
          },
          {
            filename: "demo-1.1.0-yanked.tar.gz",
            packagetype: "sdist",
            url: "https://files.pythonhosted.org/packages/demo-1.1.0-yanked.tar.gz",
            digests: { sha256: "e".repeat(64) },
            upload_time_iso_8601: "2026-02-01T00:00:00.000Z",
            yanked: true,
          },
        ],
      },
    };

    expect(pickPyPiBaselineRelease(metadata, "2.0.0")).toMatchObject({
      version: "1.1.0",
      source: "upload-time",
    });
    expect(selectPyPiReleaseArtifacts(metadata, "1.1.0")).toEqual([
      {
        filename: "demo-1.1.0-py3-none-any.whl",
        url: "https://files.pythonhosted.org/packages/demo-1.1.0-py3-none-any.whl",
        sha256: "c".repeat(64),
        packagetype: "bdist_wheel",
        kind: "wheel",
        size: 1234,
      },
      {
        filename: "demo-1.1.0.tar.gz",
        url: "https://files.pythonhosted.org/packages/demo-1.1.0.tar.gz",
        sha256: "d".repeat(64),
        packagetype: "sdist",
        kind: "sdist",
        size: null,
      },
    ]);
  });

  test("allows only files.pythonhosted.org artifact URLs for public PyPI downloads", () => {
    expect(isAllowedPyPiArtifactUrl("https://files.pythonhosted.org/packages/demo.whl")).toBe(true);
    expect(isAllowedPyPiArtifactUrl("https://example.com/packages/demo.whl")).toBe(false);
    expect(isAllowedPyPiArtifactUrl("http://files.pythonhosted.org/packages/demo.whl")).toBe(false);
  });
});

describe("PyPI baseline acquisition through the broker", () => {
  const candidateManifest = (artifacts) =>
    parsePyPiReleaseManifest({
      schema: "drydock.release-artifacts.v1",
      ecosystem: "pypi",
      package: "demo-package",
      version: "1.2.0",
      artifacts,
    });

  test("downloads the selected previous release and namespaces baseline files for diffing", async () => {
    const wheelUrl = "https://files.pythonhosted.org/packages/demo_package-1.1.0-py3-none-any.whl";
    const manifest = candidateManifest([
      { path: "dist/demo_package-1.2.0-py3-none-any.whl", sha256: "a".repeat(64) },
    ]);
    const input = pypiAdapter.parseInput({
      manifest,
      artifacts: [
        { path: "dist/demo_package-1.2.0-py3-none-any.whl", files: wheelArtifactFiles("1.2.0") },
      ],
    });
    const { broker, calls } = stubBroker({
      metadata: {
        info: { version: "1.1.0" },
        releases: {
          "1.1.0": [
            {
              filename: "demo_package-1.1.0-py3-none-any.whl",
              packagetype: "bdist_wheel",
              url: wheelUrl,
              digests: { sha256: "c".repeat(64) },
              upload_time_iso_8601: "2026-02-01T00:00:00.000Z",
            },
          ],
        },
      },
      downloads: { [wheelUrl]: wheelArtifactFiles("1.1.0") },
    });

    const staged = await pypiAdapter.acquireStaged(adapterCtx, input, broker);
    const baseline = await pypiAdapter.acquireBaseline(adapterCtx, input, broker, staged);

    expect(calls).toEqual([{ url: wheelUrl, kind: "wheel" }]);
    expect(baseline.baseline).toMatchObject({
      version: "1.1.0",
      source: "latest-published",
      reason: "project-json-info-version",
    });

    const diff = createPackageDiff(baseline.artifact.files, staged.artifact.files);
    expect(diff).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "wheel/py3-none-any/demo_package/__init__.py",
          status: "unchanged",
        }),
        expect.objectContaining({
          path: "wheel/py3-none-any/.dist-info/METADATA",
          status: "modified",
        }),
      ]),
    );
  });

  test("skips yanked baseline files and only downloads staged artifact namespaces", async () => {
    const wheelUrl = "https://files.pythonhosted.org/packages/demo_package-1.1.0-py3-none-any.whl";
    const manifest = candidateManifest([
      { path: "dist/demo_package-1.2.0-py3-none-any.whl", sha256: "a".repeat(64) },
      { path: "dist/demo_package-1.2.0.tar.gz", sha256: "b".repeat(64) },
    ]);
    const input = pypiAdapter.parseInput({
      manifest,
      artifacts: [
        { path: "dist/demo_package-1.2.0-py3-none-any.whl", files: wheelArtifactFiles("1.2.0") },
        {
          path: "dist/demo_package-1.2.0.tar.gz",
          files: [
            file(
              "demo_package-1.2.0/PKG-INFO",
              "Metadata-Version: 2.3\nName: demo-package\nVersion: 1.2.0\n",
            ),
            file("demo_package-1.2.0/demo_package/__init__.py", "VALUE = 1\n", {
              sha256: "sha-sdist-init",
            }),
          ],
        },
      ],
    });
    const { broker, calls } = stubBroker({
      metadata: {
        info: { version: "1.1.0" },
        releases: {
          "1.1.0": [
            {
              filename: "demo_package-1.1.0-py3-none-any.whl",
              packagetype: "bdist_wheel",
              url: wheelUrl,
              digests: { sha256: "c".repeat(64) },
              upload_time_iso_8601: "2026-02-01T00:00:00.000Z",
            },
            {
              filename: "demo_package-1.1.0.tar.gz",
              packagetype: "sdist",
              url: "https://files.pythonhosted.org/packages/demo_package-1.1.0.tar.gz",
              digests: { sha256: "d".repeat(64) },
              upload_time_iso_8601: "2026-02-01T00:00:00.000Z",
              yanked: true,
            },
            {
              filename: "demo_package-1.1.0-cp39-cp39-manylinux1_x86_64.whl",
              packagetype: "bdist_wheel",
              url: "https://files.pythonhosted.org/packages/demo_package-1.1.0-cp39-cp39-manylinux1_x86_64.whl",
              digests: { sha256: "e".repeat(64) },
              upload_time_iso_8601: "2026-02-01T00:00:00.000Z",
            },
            {
              filename: "demo_package-1.1.0-py3-none-any.whl",
              packagetype: "bdist_wheel",
              url: "https://evil.example.com/demo_package-1.1.0-py3-none-any.whl",
              digests: { sha256: "f".repeat(64) },
              upload_time_iso_8601: "2026-02-01T00:00:00.000Z",
            },
          ],
        },
      },
      downloads: { [wheelUrl]: wheelArtifactFiles("1.1.0") },
    });

    const staged = await pypiAdapter.acquireStaged(adapterCtx, input, broker);
    const baseline = await pypiAdapter.acquireBaseline(adapterCtx, input, broker, staged);

    // Yanked sdist, off-host wheel, and the unstaged manylinux namespace are all
    // excluded; only the staged py3-none-any wheel is fetched.
    expect(calls).toEqual([{ url: wheelUrl, kind: "wheel" }]);
    expect(
      baseline.artifact.files.every((entry) => entry.path.startsWith("wheel/py3-none-any/")),
    ).toBe(true);
  });

  test("downloads 44 comparable baseline wheels sequentially and compacts repeated samples", async () => {
    const wheelNames = Array.from(
      { length: 44 },
      (_, index) =>
        `demo_package-1.1.0-cp312-cp312-manylinux_${String(index).padStart(2, "0")}_x86_64.whl`,
    );
    const candidateNames = wheelNames.map((name) => name.replace("1.1.0", "1.2.0"));
    const manifest = candidateManifest(
      candidateNames.map((path) => ({ path: `dist/${path}`, sha256: "a".repeat(64) })),
    );
    const input = pypiAdapter.parseInput({
      manifest,
      artifacts: candidateNames.map((path) => ({
        path: `dist/${path}`,
        files: wheelArtifactFiles("1.2.0"),
      })),
    });
    const metadata = {
      info: { version: "1.1.0" },
      releases: {
        "1.1.0": wheelNames.map((filename) => ({
          filename,
          packagetype: "bdist_wheel",
          url: `https://files.pythonhosted.org/packages/${filename}`,
          size: 5 * 1024 * 1024,
          digests: { sha256: "c".repeat(64) },
          upload_time_iso_8601: "2026-02-01T00:00:00.000Z",
        })),
      },
    };
    let activeDownloads = 0;
    let maxActiveDownloads = 0;
    const calls = [];
    const broker = {
      async fetchProjectMetadata() {
        return metadata;
      },
      async downloadPublicArtifact(artifact) {
        calls.push(artifact);
        activeDownloads += 1;
        maxActiveDownloads = Math.max(maxActiveDownloads, activeDownloads);
        await Promise.resolve();
        activeDownloads -= 1;
        return { files: wheelArtifactFiles("1.1.0"), packageJson: null };
      },
      dispose() {},
    };

    const staged = await pypiAdapter.acquireStaged(adapterCtx, input, broker);
    const baseline = await pypiAdapter.acquireBaseline(adapterCtx, input, broker, staged);

    expect(calls).toHaveLength(44);
    expect(maxActiveDownloads).toBe(1);
    expect(
      baseline.artifact.files.filter(
        (entry) => entry.path.endsWith("demo_package/__init__.py") && entry.textSample,
      ),
    ).toHaveLength(1);
  });

  test("marks the comparison skipped when the published baseline is too large", async () => {
    const manifest = candidateManifest([
      { path: "dist/demo_package-1.2.0-py3-none-any.whl", sha256: "a".repeat(64) },
    ]);
    const input = pypiAdapter.parseInput({
      manifest,
      artifacts: [
        { path: "dist/demo_package-1.2.0-py3-none-any.whl", files: wheelArtifactFiles("1.2.0") },
      ],
    });
    const { broker, calls } = stubBroker({
      metadata: {
        info: { version: "1.1.0" },
        releases: {
          "1.1.0": [
            {
              filename: "demo_package-1.1.0-py3-none-any.whl",
              packagetype: "bdist_wheel",
              url: "https://files.pythonhosted.org/packages/demo_package-1.1.0-py3-none-any.whl",
              // One distribution over the 768 MiB advertised-bytes budget.
              size: 800 * 1024 * 1024,
              digests: { sha256: "c".repeat(64) },
              upload_time_iso_8601: "2026-02-01T00:00:00.000Z",
            },
          ],
        },
      },
    });

    const staged = await pypiAdapter.acquireStaged(adapterCtx, input, broker);
    const baseline = await pypiAdapter.acquireBaseline(adapterCtx, input, broker, staged);

    // Nothing is downloaded, but the report must say a predecessor exists and
    // was skipped rather than silently reviewing without a baseline.
    expect(calls).toEqual([]);
    expect(baseline.artifact).toBeNull();
    expect(baseline.baseline).toMatchObject({
      version: "1.1.0",
      comparisonSkipped: "baseline-too-large",
    });
    expect(baseline.baseline.reason).toContain("baseline-resource-budget");
  });

  test("keeps the retained sample in the same namespace on both sides of the diff", async () => {
    // 1.2.0 adds a macOS wheel the baseline never published. Its filename sorts
    // before `manylinux`, so an independent baseline pass would keep the shared
    // body under `macosx` on the staged side and under `manylinux` on the
    // baseline side — rendering a changed file as a whole-file deletion.
    const platformWheel = (platform, version, initSha, initBody) => [
      file(
        `demo_package-${version}.dist-info/METADATA`,
        `Metadata-Version: 2.3\nName: demo-package\nVersion: ${version}\n`,
      ),
      file(
        `demo_package-${version}.dist-info/WHEEL`,
        `Wheel-Version: 1.0\nRoot-Is-Purelib: false\nTag: cp312-cp312-${platform}\n`,
        { sha256: "sha-wheel-metadata" },
      ),
      file(`demo_package-${version}.dist-info/RECORD`, "demo_package/__init__.py,,\n", {
        sha256: "sha-wheel-record",
      }),
      file("demo_package/__init__.py", initBody, { sha256: initSha }),
    ];
    const stagedPaths = [
      "dist/demo_package-1.2.0-cp312-cp312-macosx_11_0_arm64.whl",
      "dist/demo_package-1.2.0-cp312-cp312-manylinux_x86_64.whl",
    ];
    const manylinuxUrl =
      "https://files.pythonhosted.org/packages/demo_package-1.1.0-cp312-cp312-manylinux_x86_64.whl";
    const input = pypiAdapter.parseInput({
      manifest: candidateManifest(
        stagedPaths.map((path, index) => ({ path, sha256: `${index}a`.repeat(32) })),
      ),
      artifacts: [
        {
          path: stagedPaths[0],
          files: platformWheel("macosx_11_0_arm64", "1.2.0", "sha-init-new", "VALUE = 2\n"),
        },
        {
          path: stagedPaths[1],
          files: platformWheel("manylinux_x86_64", "1.2.0", "sha-init-new", "VALUE = 2\n"),
        },
      ],
    });
    const { broker } = stubBroker({
      metadata: {
        info: { version: "1.1.0" },
        releases: {
          "1.1.0": [
            {
              filename: "demo_package-1.1.0-cp312-cp312-manylinux_x86_64.whl",
              packagetype: "bdist_wheel",
              url: manylinuxUrl,
              digests: { sha256: "c".repeat(64) },
              upload_time_iso_8601: "2026-02-01T00:00:00.000Z",
            },
          ],
        },
      },
      downloads: {
        [manylinuxUrl]: platformWheel("manylinux_x86_64", "1.1.0", "sha-init-old", "VALUE = 1\n"),
      },
    });

    const staged = await pypiAdapter.acquireStaged(adapterCtx, input, broker);
    const baseline = await pypiAdapter.acquireBaseline(adapterCtx, input, broker, staged);

    const sampleAt = (files, namespace) =>
      files.find((entry) => entry.path === `${namespace}/demo_package/__init__.py`)?.textSample;

    // The macOS wheel is new, so it keeps the body and the diff shows it as an
    // added file with content.
    expect(sampleAt(staged.artifact.files, "wheel/cp312-cp312-macosx_11_0_arm64")).toBe(
      "VALUE = 2\n",
    );
    // The manylinux namespace exists on both sides, so neither side keeps a body.
    expect(sampleAt(staged.artifact.files, "wheel/cp312-cp312-manylinux_x86_64")).toBeUndefined();
    expect(sampleAt(baseline.artifact.files, "wheel/cp312-cp312-manylinux_x86_64")).toBeUndefined();
  });
});
