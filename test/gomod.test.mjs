import { describe, expect, test } from "vitest";
import {
  compareGoVersions,
  createGoReleaseCandidateReview,
  escapeGoModulePath,
  goAdapter,
  goProxyZipUrl,
  inferGoArtifactKind,
  isAllowedGoProxyArtifactUrl,
  parseGoModFile,
  parseGoModuleZipRoot,
  parseGoReleaseManifest,
  pickGoBaselineVersion,
  prepareGoArtifact,
} from "../server/lib/adapters/gomod/index.ts";
import { acquireBaselineGo } from "../server/lib/adapters/gomod/acquire.ts";

function file(path, textSample, extra = {}) {
  return {
    path,
    size: textSample.length,
    sha256: `sha-${path}-${textSample.length}`,
    flags: [],
    textSample,
    ...extra,
  };
}

const adapterCtx = { env: {}, executionCtx: {}, db: {}, session: { userId: "user_1" } };

const MODULE = "github.com/octo/demo";

function moduleFiles(version, { goMod, extraFiles = [] } = {}) {
  const root = `${MODULE}@${version}`;
  return [
    file(`${root}/go.mod`, goMod ?? `module ${MODULE}\n\ngo 1.22\n`),
    file(`${root}/main.go`, "package demo\n\nfunc Value() int { return 1 }\n"),
    ...extraFiles.map((entry) => ({ ...entry, path: `${root}/${entry.path}` })),
  ];
}

function manifestFor(version, path = `demo-${version}.zip`) {
  return {
    schema: "drydock.release-artifacts.v1",
    ecosystem: "go",
    package: MODULE,
    version,
    artifacts: [{ path, sha256: "a".repeat(64) }],
  };
}

describe("Go release manifests", () => {
  test("validates manifest shape and artifact kinds", () => {
    const manifest = parseGoReleaseManifest(manifestFor("v1.2.0"));
    expect(manifest.package).toBe(MODULE);
    expect(manifest.artifacts[0].kind).toBe("module");
    expect(inferGoArtifactKind("demo-v1.2.0.zip")).toBe("module");
    expect(inferGoArtifactKind("demo-v1.2.0.tar.gz")).toBeNull();
  });

  test("rejects invalid module paths and non-canonical versions", () => {
    expect(() => parseGoReleaseManifest({ ...manifestFor("v1.0.0"), package: "no-dot" })).toThrow(
      /valid Go module path/,
    );
    expect(() => parseGoReleaseManifest({ ...manifestFor("v1.0.0"), version: "1.0.0" })).toThrow(
      /canonical Go semver/,
    );
  });
});

describe("module zip root parsing", () => {
  test("parses a consistent {module}@{version} root", () => {
    expect(parseGoModuleZipRoot(moduleFiles("v1.2.0"))).toEqual({
      modulePath: MODULE,
      version: "v1.2.0",
    });
  });

  test("returns null for inconsistent or missing roots", () => {
    expect(
      parseGoModuleZipRoot([
        file(`${MODULE}@v1.2.0/go.mod`, `module ${MODULE}\n`),
        file(`${MODULE}@v1.1.0/main.go`, "package demo\n"),
      ]),
    ).toBeNull();
    expect(parseGoModuleZipRoot([file("go.mod", `module ${MODULE}\n`)])).toBeNull();
  });
});

describe("go.mod parsing", () => {
  test("reads the module path and replace directives (inline and block)", () => {
    const parsed = parseGoModFile(
      [
        `module ${MODULE}`,
        "",
        "go 1.22",
        "",
        "replace example.com/a => ../local-a",
        "",
        "replace (",
        "\texample.com/b => example.com/b-fork v1.0.0",
        ")",
      ].join("\n"),
    );
    expect(parsed.modulePath).toBe(MODULE);
    expect(parsed.replaceDirectives).toEqual([
      "example.com/a => ../local-a",
      "example.com/b => example.com/b-fork v1.0.0",
    ]);
  });
});

describe("Go artifact preparation", () => {
  test("strips the module zip root", () => {
    const prepared = prepareGoArtifact({ path: "demo-v1.2.0.zip", files: moduleFiles("v1.2.0") });
    expect(prepared.files.map((entry) => entry.path)).toEqual(["go.mod", "main.go"]);
    expect(prepared.summary.module.rootModulePath).toBe(MODULE);
    expect(prepared.summary.module.rootVersion).toBe("v1.2.0");
  });
});

describe("Go release review", () => {
  test("flags replace directives and capability additions vs baseline", () => {
    const review = createGoReleaseCandidateReview({
      manifest: manifestFor("v1.2.0"),
      artifacts: [
        {
          path: "demo-v1.2.0.zip",
          files: moduleFiles("v1.2.0", {
            goMod: `module ${MODULE}\n\ngo 1.22\n\nreplace example.com/a => ../local-a\n`,
            extraFiles: [
              file(
                "native.go",
                'package demo\n\n//go:generate ./gen.sh\n\nimport "C"\n\nimport "unsafe"\n\nimport "syscall"\n',
              ),
            ],
          }),
        },
      ],
      previousArtifacts: [{ path: "demo-v1.1.0.zip", files: moduleFiles("v1.1.0") }],
    });

    const ruleIds = review.ruleFindings.map((finding) => finding.ruleId);
    expect(ruleIds).toContain("go.replace-directive");
    expect(ruleIds).toContain("go.generate-directive-added");
    expect(ruleIds).toContain("go.cgo-introduced");
    expect(ruleIds).toContain("go.unsafe-usage-added");
    expect(ruleIds).toContain("go.syscall-usage-added");
    expect(review.package).toEqual({ name: MODULE, version: "v1.2.0" });
  });

  test("does not re-flag capabilities already present in the baseline", () => {
    const carrying = {
      extraFiles: [file("sys.go", 'package demo\n\nimport "unsafe"\n')],
    };
    const review = createGoReleaseCandidateReview({
      manifest: manifestFor("v1.2.0"),
      artifacts: [{ path: "demo-v1.2.0.zip", files: moduleFiles("v1.2.0", carrying) }],
      previousArtifacts: [{ path: "demo-v1.1.0.zip", files: moduleFiles("v1.1.0", carrying) }],
    });
    expect(review.ruleFindings.map((finding) => finding.ruleId)).not.toContain(
      "go.unsafe-usage-added",
    );
  });

  test("flags metadata mismatch when the zip root disagrees with the manifest", () => {
    const review = createGoReleaseCandidateReview({
      manifest: manifestFor("v1.2.0"),
      artifacts: [{ path: "demo-v1.2.0.zip", files: moduleFiles("v9.9.9") }],
    });
    const mismatch = review.ruleFindings.find(
      (finding) => finding.ruleId === "go.metadata-mismatch",
    );
    expect(mismatch).toBeTruthy();
    expect(mismatch.severity).toBe("critical");
  });

  test("uses go code patterns for changed-line findings", () => {
    const review = createGoReleaseCandidateReview({
      manifest: manifestFor("v1.2.0"),
      artifacts: [
        {
          path: "demo-v1.2.0.zip",
          files: [
            file(`${MODULE}@v1.2.0/go.mod`, `module ${MODULE}\n`),
            file(
              `${MODULE}@v1.2.0/run.go`,
              'package demo\n\nimport "os/exec"\n\nfunc Run() { exec.Command("curl").Run() }\n',
            ),
          ],
        },
      ],
    });
    expect(
      review.ruleFindings.some(
        (finding) => finding.file === "run.go" && /process/i.test(finding.evidence ?? ""),
      ),
    ).toBe(true);
  });
});

describe("Go baseline selection", () => {
  test("picks the highest semver from the proxy list, skipping the candidate", () => {
    expect(pickGoBaselineVersion(["v1.0.0", "v1.2.0", "v1.1.0", "v1.2.0-rc.1"], "v1.2.0")).toBe(
      "v1.2.0-rc.1",
    );
    expect(pickGoBaselineVersion(["v1.0.0", "v1.1.0", "not-a-version"], "v1.2.0")).toBe("v1.1.0");
    expect(pickGoBaselineVersion(["v1.0.0"], "v1.0.0")).toBeNull();
  });

  test("orders prereleases below releases", () => {
    expect(compareGoVersions("v1.2.0-rc.1", "v1.2.0")).toBeLessThan(0);
    expect(compareGoVersions("v1.2.0-rc.2", "v1.2.0-rc.1")).toBeGreaterThan(0);
    expect(compareGoVersions("v1.10.0", "v1.9.0")).toBeGreaterThan(0);
  });

  test("downloads the baseline zip from proxy.golang.org via the broker", async () => {
    const calls = [];
    const broker = {
      async fetchVersionList() {
        return ["v1.1.0", "v1.2.0"];
      },
      async downloadPublicArtifact(url) {
        calls.push(url);
        return { files: moduleFiles("v1.1.0"), packageJson: null };
      },
      dispose() {},
    };
    const input = goAdapter.parseInput({
      manifest: manifestFor("v1.2.0"),
      artifacts: [{ path: "demo-v1.2.0.zip", files: moduleFiles("v1.2.0") }],
    });
    const result = await acquireBaselineGo(adapterCtx, input, broker);
    expect(calls).toEqual(["https://proxy.golang.org/github.com/octo/demo/@v/v1.1.0.zip"]);
    expect(result.baseline.version).toBe("v1.1.0");
    expect(result.artifact.files.map((entry) => entry.path)).toContain("go.mod");
  });

  test("returns an empty baseline when the proxy is unavailable", async () => {
    const broker = {
      async fetchVersionList() {
        return null;
      },
      async downloadPublicArtifact() {
        throw new Error("unexpected download");
      },
      dispose() {},
    };
    const input = goAdapter.parseInput({
      manifest: manifestFor("v1.2.0"),
      artifacts: [{ path: "demo-v1.2.0.zip", files: moduleFiles("v1.2.0") }],
    });
    const result = await acquireBaselineGo(adapterCtx, input, broker);
    expect(result.artifact).toBeNull();
    expect(result.baseline.source).toBe("none");
  });
});

describe("Go proxy URL rules", () => {
  test("case-encodes module paths for proxy URLs", () => {
    expect(escapeGoModulePath("github.com/Octo/Demo")).toBe("github.com/!octo/!demo");
    expect(goProxyZipUrl("github.com/Octo/Demo", "v1.0.0")).toBe(
      "https://proxy.golang.org/github.com/!octo/!demo/@v/v1.0.0.zip",
    );
  });

  test("only https proxy.golang.org artifact URLs are allowed", () => {
    expect(isAllowedGoProxyArtifactUrl(goProxyZipUrl(MODULE, "v1.1.0"))).toBe(true);
    expect(isAllowedGoProxyArtifactUrl("https://example.com/demo-v1.1.0.zip")).toBe(false);
    expect(isAllowedGoProxyArtifactUrl("http://proxy.golang.org/x/@v/v1.0.0.zip")).toBe(false);
  });
});
