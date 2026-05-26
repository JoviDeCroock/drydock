import { describe, expect, test } from "vitest";
import {
  createPyPiReleaseCandidateReview,
  inferPyPiArtifactKind,
  isAllowedPyPiArtifactUrl,
  normalizePyPiProjectName,
  parsePyPiReleaseManifest,
  pickPyPiBaselineRelease,
  preparePyPiArtifact,
  selectPyPiReleaseArtifacts,
} from "../server/lib/pypi.ts";

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
