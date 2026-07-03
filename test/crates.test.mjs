import { describe, expect, test } from "vitest";
import {
  createCratesReleaseCandidateReview,
  cratesAdapter,
  cratesIndexPath,
  cratesStaticArtifactUrl,
  inferCratesArtifactKind,
  isAllowedCratesArtifactUrl,
  parseCargoManifest,
  parseCratesReleaseManifest,
  pickCratesBaselineVersion,
  prepareCratesArtifact,
} from "../server/lib/adapters/crates/index.ts";
import { acquireBaselineCrates } from "../server/lib/adapters/crates/acquire.ts";

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

function cargoToml(version, extra = "") {
  return `[package]\nname = "demo-crate"\nversion = "${version}"\n${extra}`;
}

function crateFiles(version, { manifestExtra = "", extraFiles = [] } = {}) {
  return [
    file(`demo-crate-${version}/Cargo.toml`, cargoToml(version, manifestExtra)),
    file(`demo-crate-${version}/src/lib.rs`, "pub fn value() -> u32 { 1 }\n"),
    ...extraFiles.map((entry) => ({ ...entry, path: `demo-crate-${version}/${entry.path}` })),
  ];
}

function manifestFor(version, path = `demo-crate-${version}.crate`) {
  return {
    schema: "drydock.release-artifacts.v1",
    ecosystem: "crates",
    package: "demo-crate",
    version,
    artifacts: [{ path, sha256: "a".repeat(64) }],
  };
}

describe("crates release manifests", () => {
  test("validates manifest shape and artifact kinds", () => {
    const manifest = parseCratesReleaseManifest(manifestFor("1.2.0"));
    expect(manifest.package).toBe("demo-crate");
    expect(manifest.artifacts[0].kind).toBe("crate");
    expect(inferCratesArtifactKind("demo-1.0.0.tar.gz")).toBeNull();
    expect(inferCratesArtifactKind("demo-1.0.0.crate")).toBe("crate");
  });

  test("rejects unsafe paths and invalid names", () => {
    expect(() =>
      parseCratesReleaseManifest({
        ...manifestFor("1.0.0"),
        artifacts: [{ path: "../demo-1.0.0.crate", sha256: "a".repeat(64) }],
      }),
    ).toThrow(/path is not safe/);
    expect(() => parseCratesReleaseManifest({ ...manifestFor("1.0.0"), package: "9bad" })).toThrow(
      /valid crates.io package name/,
    );
  });
});

describe("Cargo.toml parsing", () => {
  test("reads name, version, links, build, proc-macro, and non-registry deps", () => {
    const summary = parseCargoManifest(
      [
        "[package]",
        'name = "demo-crate"',
        'version = "1.2.0"',
        'links = "zlib"',
        'build = "custom-build.rs"',
        "",
        "[lib]",
        "proc-macro = true",
        "",
        "[dependencies]",
        'evil = { git = "https://example.com/evil.git" }',
        'local = { path = "../local" }',
        'serde = "1"',
        "",
        "[dependencies.other]",
        'git = "https://example.com/other.git"',
      ].join("\n"),
    );
    expect(summary.name).toBe("demo-crate");
    expect(summary.version).toBe("1.2.0");
    expect(summary.links).toBe("zlib");
    expect(summary.buildValue).toBe("custom-build.rs");
    expect(summary.procMacro).toBe(true);
    expect(summary.nonRegistryDependencies).toEqual([
      { name: "evil", source: "git", section: "dependencies" },
      { name: "local", source: "path", section: "dependencies" },
      { name: "other", source: "git", section: "dependencies" },
    ]);
  });

  test("build = false disables the conventional build script", () => {
    const summary = parseCargoManifest('[package]\nname = "x"\nversion = "1.0.0"\nbuild = false\n');
    expect(summary.buildValue).toBe(false);
  });
});

describe("crates artifact preparation", () => {
  test("strips the {name}-{version} root and summarizes the manifest", () => {
    const prepared = prepareCratesArtifact({
      path: "demo-crate-1.2.0.crate",
      files: crateFiles("1.2.0"),
    });
    expect(prepared.files.map((entry) => entry.path)).toEqual(["Cargo.toml", "src/lib.rs"]);
    expect(prepared.summary.manifest.name).toBe("demo-crate");
    expect(prepared.summary.manifest.version).toBe("1.2.0");
    expect(prepared.summary.buildScriptPath).toBeNull();
  });

  test("rejects non-.crate artifacts", () => {
    expect(() => prepareCratesArtifact({ path: "demo.tgz", files: [] })).toThrow(/\.crate/);
  });
});

describe("crates release review", () => {
  test("flags build script, proc-macro, links, and non-registry dep changes vs baseline", () => {
    const review = createCratesReleaseCandidateReview({
      manifest: manifestFor("1.2.0"),
      artifacts: [
        {
          path: "demo-crate-1.2.0.crate",
          files: crateFiles("1.2.0", {
            manifestExtra:
              'links = "zlib"\n\n[lib]\nproc-macro = true\n\n[dependencies]\nevil = { git = "https://example.com/evil.git" }\n',
            extraFiles: [file("build.rs", 'fn main() { println!("cargo:rerun"); }\n')],
          }),
        },
      ],
      previousArtifacts: [{ path: "demo-crate-1.1.0.crate", files: crateFiles("1.1.0") }],
    });

    const ruleIds = review.ruleFindings.map((finding) => finding.ruleId);
    expect(ruleIds).toContain("crates.build-script-added");
    expect(ruleIds).toContain("crates.proc-macro-introduced");
    expect(ruleIds).toContain("crates.links-changed");
    expect(ruleIds).toContain("crates.non-registry-dependency");
    expect(review.package).toEqual({ name: "demo-crate", version: "1.2.0" });
  });

  test("flags a changed build script between releases", () => {
    const review = createCratesReleaseCandidateReview({
      manifest: manifestFor("1.2.0"),
      artifacts: [
        {
          path: "demo-crate-1.2.0.crate",
          files: crateFiles("1.2.0", {
            extraFiles: [file("build.rs", 'fn main() { std::process::Command::new("sh"); }\n')],
          }),
        },
      ],
      previousArtifacts: [
        {
          path: "demo-crate-1.1.0.crate",
          files: crateFiles("1.1.0", {
            extraFiles: [file("build.rs", "fn main() {}\n")],
          }),
        },
      ],
    });
    expect(review.ruleFindings.map((finding) => finding.ruleId)).toContain(
      "crates.build-script-changed",
    );
  });

  test("flags metadata mismatch against the reviewed manifest", () => {
    const review = createCratesReleaseCandidateReview({
      manifest: manifestFor("1.2.0"),
      artifacts: [{ path: "demo-crate-1.2.0.crate", files: crateFiles("9.9.9") }],
    });
    const mismatch = review.ruleFindings.find(
      (finding) => finding.ruleId === "crates.metadata-mismatch",
    );
    expect(mismatch).toBeTruthy();
    expect(mismatch.severity).toBe("critical");
  });

  test("uses rust code patterns for changed-line findings", () => {
    const review = createCratesReleaseCandidateReview({
      manifest: manifestFor("1.2.0"),
      artifacts: [
        {
          path: "demo-crate-1.2.0.crate",
          files: [
            file("demo-crate-1.2.0/Cargo.toml", cargoToml("1.2.0")),
            file(
              "demo-crate-1.2.0/src/lib.rs",
              'pub fn run() { std::process::Command::new("curl"); }\n',
            ),
          ],
        },
      ],
    });
    expect(
      review.ruleFindings.some(
        (finding) => finding.file === "src/lib.rs" && /process/i.test(finding.evidence ?? ""),
      ),
    ).toBe(true);
  });
});

describe("crates baseline selection", () => {
  test("picks the newest non-yanked index entry that is not the candidate", () => {
    expect(
      pickCratesBaselineVersion(
        [
          { vers: "1.0.0" },
          { vers: "1.1.0" },
          { vers: "1.2.0-broken", yanked: true },
          { vers: "1.2.0" },
        ],
        "1.2.0",
      ),
    ).toBe("1.1.0");
    expect(pickCratesBaselineVersion([{ vers: "1.0.0" }], "1.0.0")).toBeNull();
  });

  test("downloads the baseline crate from static.crates.io via the broker", async () => {
    const calls = [];
    const broker = {
      async fetchIndexEntries() {
        return [{ vers: "1.1.0" }, { vers: "1.2.0" }];
      },
      async downloadPublicArtifact(url) {
        calls.push(url);
        return { files: crateFiles("1.1.0"), packageJson: null };
      },
      dispose() {},
    };
    const input = cratesAdapter.parseInput({
      manifest: manifestFor("1.2.0"),
      artifacts: [{ path: "demo-crate-1.2.0.crate", files: crateFiles("1.2.0") }],
    });
    const result = await acquireBaselineCrates(adapterCtx, input, broker);
    expect(calls).toEqual(["https://static.crates.io/crates/demo-crate/demo-crate-1.1.0.crate"]);
    expect(result.baseline.version).toBe("1.1.0");
    expect(result.baseline.source).toBe("latest-published");
    expect(result.artifact.files.map((entry) => entry.path)).toContain("Cargo.toml");
  });

  test("returns an empty baseline when the index is unavailable", async () => {
    const broker = {
      async fetchIndexEntries() {
        return null;
      },
      async downloadPublicArtifact() {
        throw new Error("unexpected download");
      },
      dispose() {},
    };
    const input = cratesAdapter.parseInput({
      manifest: manifestFor("1.2.0"),
      artifacts: [{ path: "demo-crate-1.2.0.crate", files: crateFiles("1.2.0") }],
    });
    const result = await acquireBaselineCrates(adapterCtx, input, broker);
    expect(result.artifact).toBeNull();
    expect(result.baseline.source).toBe("none");
  });
});

describe("crates broker URL rules", () => {
  test("sparse index paths follow the crates.io layout", () => {
    expect(cratesIndexPath("a")).toBe("1/a");
    expect(cratesIndexPath("ab")).toBe("2/ab");
    expect(cratesIndexPath("abc")).toBe("3/a/abc");
    expect(cratesIndexPath("Demo-Crate")).toBe("de/mo/demo-crate");
  });

  test("only https static.crates.io artifact URLs are allowed", () => {
    expect(isAllowedCratesArtifactUrl(cratesStaticArtifactUrl("demo-crate", "1.1.0"))).toBe(true);
    expect(isAllowedCratesArtifactUrl("https://example.com/demo-1.1.0.crate")).toBe(false);
    expect(isAllowedCratesArtifactUrl("http://static.crates.io/crates/demo/demo-1.1.0.crate")).toBe(
      false,
    );
  });
});
