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
} from "../server/lib/adapters/pypi/index.ts";

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
            file("demo_package/sitecustomize.pth", "import demo_package.bootstrap\n"),
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
          file: "dist/demo_package-1.2.0-py3-none-any.whl/demo_package/sitecustomize.pth",
        }),
        expect.objectContaining({
          severity: "high",
          ruleId: "pypi.setup-install-command",
          file: "dist/demo_package-1.2.0.tar.gz/setup.py",
        }),
      ]),
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
    const ctx = { env: {}, executionCtx: {}, db: {}, session: { userId: "user_1" } };
    const broker = pypiAdapter.createBroker(ctx, { organizationId: "org_1" });
    const staged = await pypiAdapter.acquireStaged(ctx, input, broker);
    const baseline = await pypiAdapter.acquireBaseline(ctx, input, broker, staged);
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
    expect(baseline.baseline).toMatchObject({
      version: null,
      source: "none",
      reason: "no-previous-artifacts",
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
