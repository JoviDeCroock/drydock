import { describe, expect, test } from "vitest";
import type {
  PyPiProjectMetadata,
  PyPiReleaseFile,
  PyPiRemoteArtifact,
} from "../../server/lib/adapters/pypi/types";
import { PublicDiffError } from "../../server/lib/public-diff-error";
import {
  buildPublicPyPiDiffSources,
  listPublicPyPiVersions,
  selectPublicPyPiDiffArtifacts,
} from "../../server/lib/public-diff-pypi";
import { createPackageDiff, type FileRecord } from "../../server/lib/review";

const HOST = "https://files.pythonhosted.org/packages";

function releaseFile(
  filename: string,
  opts: { yanked?: boolean; uploaded?: string; url?: string } = {},
): PyPiReleaseFile {
  return {
    filename,
    url: opts.url ?? `${HOST}/${filename}`,
    packagetype: filename.endsWith(".whl") ? "bdist_wheel" : "sdist",
    digests: { sha256: "a".repeat(64) },
    upload_time_iso_8601: opts.uploaded ?? "2026-01-01T00:00:00.000Z",
    yanked: opts.yanked ?? false,
  };
}

const metadata: PyPiProjectMetadata = {
  info: { name: "Demo.Pkg", version: "1.1.0" },
  releases: {
    "1.0.0": [
      releaseFile("demo_pkg-1.0.0.tar.gz", { uploaded: "2026-02-01T00:00:00.000Z" }),
      releaseFile("demo_pkg-1.0.0-py3-none-any.whl", { uploaded: "2026-02-01T00:00:00.000Z" }),
      releaseFile("demo_pkg-1.0.0-cp312-cp312-manylinux_2_17_x86_64.whl", {
        uploaded: "2026-02-01T00:00:00.000Z",
      }),
    ],
    "1.1.0": [
      releaseFile("demo_pkg-1.1.0.tar.gz", { uploaded: "2026-03-01T00:00:00.000Z" }),
      releaseFile("demo_pkg-1.1.0-py3-none-any.whl", { uploaded: "2026-03-01T00:00:00.000Z" }),
      releaseFile("demo_pkg-1.1.0-cp313-cp313-manylinux_2_17_x86_64.whl", {
        uploaded: "2026-03-01T00:00:00.000Z",
      }),
    ],
    // Yanked-only and off-registry-host releases must not be listed or served.
    "0.9.0": [releaseFile("demo_pkg-0.9.0.tar.gz", { yanked: true })],
    "0.8.0": [
      releaseFile("demo_pkg-0.8.0.tar.gz", { url: "https://evil.example/demo_pkg-0.8.0.tar.gz" }),
    ],
  },
};

describe("listPublicPyPiVersions", () => {
  test("lists servable versions newest-first with a synthetic latest tag", () => {
    const { versions, suggested } = listPublicPyPiVersions(metadata);

    expect(versions.map((entry) => entry.version)).toEqual(["1.1.0", "1.0.0"]);
    expect(versions[0]).toEqual({
      version: "1.1.0",
      distTags: ["latest"],
      publishedAt: "2026-03-01T00:00:00.000Z",
    });
    expect(versions[1].distTags).toEqual([]);
    expect(suggested).toEqual({ from: "1.0.0", to: "1.1.0" });
  });

  test("suggests nothing when only one version is servable", () => {
    const single: PyPiProjectMetadata = {
      info: { name: "demo-pkg", version: "1.0.0" },
      releases: { "1.0.0": [releaseFile("demo_pkg-1.0.0.tar.gz")] },
    };
    expect(listPublicPyPiVersions(single).suggested).toBeNull();
  });
});

describe("selectPublicPyPiDiffArtifacts", () => {
  test("bounds each side to one sdist plus the shared pure-Python wheel", () => {
    const selection = selectPublicPyPiDiffArtifacts(metadata, "1.0.0", "1.1.0");

    expect(selection.from.map((artifact) => artifact.filename)).toEqual([
      "demo_pkg-1.0.0.tar.gz",
      "demo_pkg-1.0.0-py3-none-any.whl",
    ]);
    expect(selection.to.map((artifact) => artifact.filename)).toEqual([
      "demo_pkg-1.1.0.tar.gz",
      "demo_pkg-1.1.0-py3-none-any.whl",
    ]);
  });

  test("404s for unknown versions and versions without allowed artifacts", () => {
    expect(() => selectPublicPyPiDiffArtifacts(metadata, "9.9.9", "1.1.0")).toThrowError(
      PublicDiffError,
    );
    expect(() => selectPublicPyPiDiffArtifacts(metadata, "0.8.0", "1.1.0")).toThrowError(
      "version has no diffable wheel or sdist artifacts",
    );
  });
});

function record(path: string, textSample?: string): FileRecord {
  return {
    path,
    size: textSample?.length ?? 10,
    sha256: "s",
    flags: [],
    ...(textSample !== undefined ? { textSample } : {}),
  };
}

function remoteWheel(filename: string): PyPiRemoteArtifact {
  return {
    filename,
    url: `${HOST}/${filename}`,
    sha256: "a".repeat(64),
    packagetype: "bdist_wheel",
    kind: "wheel",
    size: 10,
  };
}

function wheelFiles(version: string, extra: FileRecord[] = []): FileRecord[] {
  const distInfo = `demo_pkg-${version}.dist-info`;
  const paths = [
    "demo_pkg/__init__.py",
    ...extra.map((file) => file.path),
    `${distInfo}/METADATA`,
    `${distInfo}/WHEEL`,
    `${distInfo}/RECORD`,
  ];
  return [
    record("demo_pkg/__init__.py", `VERSION = "${version}"\n`),
    ...extra,
    record(`${distInfo}/METADATA`, `Metadata-Version: 2.1\nName: demo-pkg\nVersion: ${version}\n`),
    record(`${distInfo}/WHEEL`, "Wheel-Version: 1.0\nTag: py3-none-any\n"),
    record(`${distInfo}/RECORD`, paths.map((path) => `${path},sha256=x,10`).join("\n") + "\n"),
  ];
}

describe("buildPublicPyPiDiffSources", () => {
  test("namespaces wheel files and pins release findings onto the diff tree", () => {
    const sources = buildPublicPyPiDiffSources({
      packageName: "Demo.Pkg",
      fromVersion: "1.0.0",
      toVersion: "1.1.0",
      from: [{ path: "demo_pkg-1.0.0-py3-none-any.whl", files: wheelFiles("1.0.0") }],
      to: [
        {
          path: "demo_pkg-1.1.0-py3-none-any.whl",
          files: wheelFiles("1.1.0", [record("evil.pth", "import os\n")]),
        },
      ],
      toRemoteArtifacts: [remoteWheel("demo_pkg-1.1.0-py3-none-any.whl")],
    });

    const toPaths = sources.to.files.map((file) => file.path);
    expect(toPaths).toContain("wheel/py3-none-any/demo_pkg/__init__.py");
    // The wheel's versioned dist-info directory is normalized so it lines up
    // across versions in the diff.
    expect(toPaths).toContain("wheel/py3-none-any/.dist-info/METADATA");
    expect(sources.to.packageJson).toEqual({ name: "demo-pkg", version: "1.1.0" });
    expect(sources.from.packageJson).toEqual({ name: "demo-pkg", version: "1.0.0" });

    const fileDiff = createPackageDiff(sources.from.files, sources.to.files);
    const findings = sources.buildFindings(fileDiff, {});
    const pth = findings.find((finding) => finding.ruleId === "pypi.pth-execution");
    expect(pth).toBeDefined();
    // The finding must reference the flattened diff path, not the artifact
    // filename, so the UI can attach it to the file tree.
    expect(pth?.file).toBe("wheel/py3-none-any/evil.pth");
    expect(toPaths).toContain(pth?.file);
    // Registry metadata and embedded metadata agree, so no mismatch findings.
    expect(findings.some((finding) => finding.ruleId === "pypi.metadata-mismatch")).toBe(false);
  });

  test("strips the sdist archive root and flags install-time execution", () => {
    const sdistFiles = (version: string, setupText: string): FileRecord[] => [
      record(
        `demo_pkg-${version}/PKG-INFO`,
        `Metadata-Version: 2.1\nName: demo-pkg\nVersion: ${version}\n`,
      ),
      record(`demo_pkg-${version}/setup.py`, setupText),
    ];
    const sources = buildPublicPyPiDiffSources({
      packageName: "demo-pkg",
      fromVersion: "1.0.0",
      toVersion: "1.1.0",
      from: [{ path: "demo_pkg-1.0.0.tar.gz", files: sdistFiles("1.0.0", "print('hi')\n") }],
      to: [
        {
          path: "demo_pkg-1.1.0.tar.gz",
          files: sdistFiles(
            "1.1.0",
            "from setuptools.command.install import install\ncmdclass = {'install': install}\n",
          ),
        },
      ],
      toRemoteArtifacts: [
        {
          filename: "demo_pkg-1.1.0.tar.gz",
          url: `${HOST}/demo_pkg-1.1.0.tar.gz`,
          sha256: "a".repeat(64),
          packagetype: "sdist",
          kind: "sdist",
          size: 10,
        },
      ],
    });

    expect(sources.to.files.map((file) => file.path)).toEqual(["sdist/PKG-INFO", "sdist/setup.py"]);

    const fileDiff = createPackageDiff(sources.from.files, sources.to.files);
    const findings = sources.buildFindings(fileDiff, {});
    const setup = findings.find((finding) => finding.ruleId === "pypi.setup-install-command");
    expect(setup?.file).toBe("sdist/setup.py");
  });
});
