import { describe, expect, test } from "vitest";
import {
  computeScanRisk,
  computeScanRiskBreakdown,
  normalizeScanRiskBreakdown,
} from "../server/lib/review/risk";

function makeAiReview(overrides = {}) {
  return {
    status: "unavailable",
    risk: "low",
    releaseAssessment: "not_assessed",
    summary: "",
    findings: [],
    requiresManualReview: false,
    model: null,
    ...overrides,
  };
}

describe("computeScanRisk", () => {
  test("returns low when no findings and AI unavailable (model null)", () => {
    const result = computeScanRisk([], makeAiReview());
    expect(result).toBe("low");
  });

  test("returns deterministic risk when AI is unavailable with null model", () => {
    const findings = [{ severity: "high", file: "x.js", evidence: "e", reason: "r" }];
    const result = computeScanRisk(findings, makeAiReview());
    expect(result).toBe("high");
  });

  test("escalates to medium when AI was attempted but did not complete (model present)", () => {
    const result = computeScanRisk([], makeAiReview({ model: "llama-3" }));
    expect(result).toBe("medium");
  });

  test("does not escalate when AI is unavailable with null model (disabled)", () => {
    const result = computeScanRisk([], makeAiReview({ model: null }));
    expect(result).toBe("low");
  });

  test("combines AI risk when AI review is complete with evidence", () => {
    const aiReview = makeAiReview({
      status: "complete",
      releaseAssessment: "suspicious",
      risk: "high",
      findings: [
        { severity: "high", file: "f.js", evidence: "e", reason: "r", recommendation: "x" },
      ],
    });
    const result = computeScanRisk([], aiReview);
    expect(result).toBe("high");
  });

  test("combines AI requiresManualReview to medium floor", () => {
    const aiReview = makeAiReview({
      status: "complete",
      releaseAssessment: "review_recommended",
      risk: "low",
      findings: [],
      requiresManualReview: true,
    });
    const result = computeScanRisk([], aiReview);
    expect(result).toBe("medium");
  });

  test("deterministic findings dominate when higher than AI risk", () => {
    const findings = [{ severity: "critical", file: "x.js", evidence: "e", reason: "r" }];
    const aiReview = makeAiReview({
      status: "complete",
      releaseAssessment: "nothing_unusual",
      risk: "low",
      findings: [],
    });
    const result = computeScanRisk(findings, aiReview);
    expect(result).toBe("critical");
  });

  test("AI complete with no evidence stays low", () => {
    const aiReview = makeAiReview({
      status: "complete",
      releaseAssessment: "nothing_unusual",
      risk: "low",
      findings: [],
      requiresManualReview: false,
    });
    const result = computeScanRisk([], aiReview);
    expect(result).toBe("low");
  });
});

describe("computeScanRiskBreakdown", () => {
  test("separates release delta findings from context findings", () => {
    const findings = [
      { severity: "high", file: "a.js", evidence: "e", reason: "r", releaseDelta: true },
      { severity: "low", file: "b.js", evidence: "e", reason: "r", releaseDelta: false },
      {
        severity: "medium",
        file: "c.js",
        evidence: "e",
        reason: "r",
        releaseDelta: false,
        diffStatus: "unknown",
      },
    ];
    const result = computeScanRiskBreakdown(findings, makeAiReview());
    expect(result.releaseFindingCount).toBe(1);
    expect(result.contextFindingCount).toBe(2);
    expect(result.unknownFindingCount).toBe(1);
  });

  test("artifactRisk reflects all findings", () => {
    const findings = [
      { severity: "critical", file: "a.js", evidence: "e", reason: "r", releaseDelta: true },
      { severity: "low", file: "b.js", evidence: "e", reason: "r", releaseDelta: false },
    ];
    const result = computeScanRiskBreakdown(findings, makeAiReview());
    expect(result.artifactRisk).toBe("critical");
  });

  test("contextRisk is computed without AI review influence", () => {
    const findings = [
      { severity: "high", file: "a.js", evidence: "e", reason: "r", releaseDelta: false },
    ];
    const aiReview = makeAiReview({
      status: "complete",
      releaseAssessment: "nothing_unusual",
      risk: "low",
      findings: [],
    });
    const result = computeScanRiskBreakdown(findings, aiReview);
    expect(result.contextRisk).toBe("high");
  });

  test("releaseRisk includes a verdict-bounded AI review", () => {
    const findings = [
      { severity: "low", file: "a.js", evidence: "e", reason: "r", releaseDelta: true },
    ];
    const aiReview = makeAiReview({
      status: "complete",
      releaseAssessment: "suspicious",
      risk: "critical",
      findings: [
        { severity: "high", file: "x.js", evidence: "e", reason: "r", recommendation: "fix" },
      ],
    });
    const result = computeScanRiskBreakdown(findings, aiReview);
    expect(result.artifactRisk).toBe("high");
    expect(result.releaseRisk).toBe("high");
  });

  test("releaseRisk drops AI risk whose findings all cite package context", () => {
    const findings = [
      { severity: "low", file: "a.js", evidence: "e", reason: "r", releaseDelta: true },
    ];
    const aiReview = makeAiReview({
      status: "complete",
      releaseAssessment: "suspicious",
      risk: "high",
      requiresManualReview: false,
      findings: [
        { severity: "high", file: "old.js", evidence: "e", reason: "r", recommendation: "fix" },
      ],
      model: "llama-3",
    });
    const aiFindings = [
      { severity: "high", file: "old.js", evidence: "e", reason: "r", releaseDelta: false },
    ];
    const result = computeScanRiskBreakdown(findings, aiReview, null, { aiFindings });
    // The concern is about the package, so the headline still carries it...
    expect(result.artifactRisk).toBe("high");
    // ...but the release delta, which the workflow gate reads, does not.
    expect(result.releaseRisk).toBe("low");
    expect(result.contextRisk).toBe("high");
    expect(result.releaseFindingCount).toBe(1);
    expect(result.contextFindingCount).toBe(1);
  });

  test("releaseRisk keeps AI risk when any AI finding cites the release delta", () => {
    const aiReview = makeAiReview({
      status: "complete",
      releaseAssessment: "suspicious",
      risk: "high",
      findings: [
        { severity: "high", file: "old.js", evidence: "e", reason: "r", recommendation: "fix" },
        { severity: "high", file: "new.js", evidence: "e", reason: "r", recommendation: "fix" },
      ],
      model: "llama-3",
    });
    const aiFindings = [
      { severity: "high", file: "old.js", releaseDelta: false },
      { severity: "high", file: "new.js", releaseDelta: true },
    ];
    const result = computeScanRiskBreakdown([], aiReview, null, { aiFindings });
    expect(result.releaseRisk).toBe("high");
    expect(result.releaseFindingCount).toBe(1);
    expect(result.contextFindingCount).toBe(1);
  });

  test("a context-only AI review keeps its manual-review floor on releaseRisk", () => {
    const aiReview = makeAiReview({
      status: "complete",
      releaseAssessment: "blocked",
      risk: "critical",
      requiresManualReview: true,
      findings: [
        { severity: "critical", file: "old.js", evidence: "e", reason: "r", recommendation: "fix" },
      ],
      model: "llama-3",
    });
    const aiFindings = [
      { severity: "critical", file: "old.js", evidence: "e", reason: "r", releaseDelta: false },
    ];
    const result = computeScanRiskBreakdown([], aiReview, null, { aiFindings });
    expect(result.artifactRisk).toBe("critical");
    expect(result.releaseRisk).toBe("medium");
  });

  test("an AI review with no findings is scored wholesale on releaseRisk", () => {
    const aiReview = makeAiReview({
      status: "complete",
      releaseAssessment: "suspicious",
      risk: "high",
      requiresManualReview: true,
      findings: [],
      model: "llama-3",
    });
    const result = computeScanRiskBreakdown([], aiReview, null, { aiFindings: [] });
    expect(result.artifactRisk).toBe("high");
    expect(result.releaseRisk).toBe("high");
  });

  test("an attempted-but-failed AI review keeps its medium floor with annotations passed", () => {
    const result = computeScanRiskBreakdown([], makeAiReview({ model: "llama-3" }), null, {
      aiFindings: [{ releaseDelta: false }],
    });
    expect(result.releaseRisk).toBe("medium");
  });

  test("returns zeros when no findings", () => {
    const result = computeScanRiskBreakdown([], makeAiReview());
    expect(result.releaseFindingCount).toBe(0);
    expect(result.contextFindingCount).toBe(0);
    expect(result.unknownFindingCount).toBe(0);
    expect(result.artifactRisk).toBe("low");
    expect(result.releaseRisk).toBe("low");
    expect(result.contextRisk).toBe("low");
  });
});

describe("normalizeScanRiskBreakdown", () => {
  test("returns null for null or non-object", () => {
    expect(normalizeScanRiskBreakdown(null)).toBe(null);
    expect(normalizeScanRiskBreakdown(undefined)).toBe(null);
    expect(normalizeScanRiskBreakdown("string")).toBe(null);
    expect(normalizeScanRiskBreakdown(42)).toBe(null);
    expect(normalizeScanRiskBreakdown([])).toBe(null);
  });

  test("returns null for empty object", () => {
    expect(normalizeScanRiskBreakdown({})).toBe(null);
  });

  test("normalizes valid risk levels", () => {
    const result = normalizeScanRiskBreakdown({
      artifactRisk: "high",
      releaseRisk: "critical",
      contextRisk: "low",
    });
    expect(result).toEqual({ artifactRisk: "high", releaseRisk: "critical", contextRisk: "low" });
  });

  test("normalizes unknown risk strings to medium", () => {
    const result = normalizeScanRiskBreakdown({
      artifactRisk: "unknown_value",
    });
    expect(result).toEqual({ artifactRisk: "medium" });
  });

  test("floors counts to zero and truncates decimals", () => {
    const result = normalizeScanRiskBreakdown({
      releaseFindingCount: -5,
      contextFindingCount: 3.7,
      unknownFindingCount: 0,
    });
    expect(result).toEqual({
      releaseFindingCount: 0,
      contextFindingCount: 3,
      unknownFindingCount: 0,
    });
  });

  test("ignores non-string risk and non-number counts", () => {
    const result = normalizeScanRiskBreakdown({
      artifactRisk: 42,
      releaseFindingCount: "five",
    });
    expect(result).toBe(null);
  });
});

describe("release memory as a risk input", () => {
  // A tape-shaped release: the package's own machinery trips rules on files this
  // release never touched, while the release delta is clean. These use an anchor
  // rule (`file.native-artifact`) rather than a `code.*` capability so the
  // assertions measure release memory and not the lone-capability
  // de-escalation, which would report "low" either way.
  const contextFinding = (ruleId, file) => ({
    ruleId,
    severity: "high",
    file,
    evidence: "e",
    reason: "r",
    releaseDelta: false,
    diffStatus: "unchanged",
  });
  const deltaFinding = (ruleId, file) => ({
    ruleId,
    severity: "high",
    file,
    evidence: "e",
    reason: "r",
    releaseDelta: true,
    diffStatus: "modified",
  });
  const consistency = (overrides = {}) => ({
    status: "match",
    priorScanId: "scan-prior",
    priorVersion: "5.10.0",
    decidedAt: "2026-07-01T00:00:00.000Z",
    currentFindingCount: 2,
    priorFindingCount: 2,
    newFindingCount: 0,
    newFindings: [],
    ...overrides,
  });

  test("without release memory, package context still anchors the headline", () => {
    const result = computeScanRiskBreakdown(
      [contextFinding("file.native-artifact", "lib/cli.node")],
      makeAiReview(),
    );
    expect(result.contextRisk).toBe("high");
    expect(result.artifactRisk).toBe("high");
    expect(result.priorApprovedContextFindingCount).toBe(0);
  });

  test("a matching approved profile stops approved context re-anchoring the headline", () => {
    const result = computeScanRiskBreakdown(
      [contextFinding("file.native-artifact", "lib/cli.node")],
      makeAiReview(),
      consistency(),
    );
    expect(result.contextRisk).toBe("low");
    expect(result.artifactRisk).toBe("low");
    // The finding is still reported — only its scoring contribution is dropped.
    expect(result.contextFindingCount).toBe(1);
    expect(result.priorApprovedContextFindingCount).toBe(1);
  });

  test.each([
    ["install-script.preinstall"],
    ["install-script.lifecycle"],
    ["install-script.implicit-node-gyp"],
    ["install-script.gyp-command-substitution"],
    ["code.remote-shell"],
    ["file.review-manipulation"],
    ["file.secret-content"],
    ["tar.suspicious-entry"],
  ])("an approval never discounts %s", (ruleId) => {
    // The discount's premise is that a capability is a property of the package
    // rather than the release. That does not extend to evidence of an active
    // compromise: if a release shipping a dropper is ever approved (compromised
    // account, or an approval predating the rule), the next README-only release
    // must not report it as settled background. Without this carve-out the
    // profile matches, the finding moves to context, and the headline reads low
    // for every release thereafter.
    const result = computeScanRiskBreakdown(
      [contextFinding(ruleId, "lib/postinstall.js")],
      makeAiReview(),
      consistency(),
    );
    expect(result.contextRisk).toBe("high");
    expect(result.artifactRisk).toBe("high");
    expect(result.priorApprovedContextFindingCount).toBe(0);
  });

  test("standing-danger rules do not block the discount for the rest", () => {
    const result = computeScanRiskBreakdown(
      [
        contextFinding("file.secret-content", "lib/.env"),
        contextFinding("file.native-artifact", "lib/cli.node"),
      ],
      makeAiReview(),
      consistency({ currentFindingCount: 3, priorFindingCount: 3 }),
    );
    // The native artifact is discounted; the embedded secret keeps scoring.
    expect(result.priorApprovedContextFindingCount).toBe(1);
    expect(result.contextRisk).toBe("high");
  });

  test("release-delta findings are never demoted, so the gate cannot move", () => {
    const result = computeScanRiskBreakdown(
      [
        contextFinding("file.native-artifact", "lib/cli.node"),
        deltaFinding("install-script.lifecycle", "package.json"),
      ],
      makeAiReview(),
      consistency(),
    );
    // `releaseRisk` is what workflow-gate-job.ts reads for its accept/reject
    // recommendation. A prior approval must not be able to release a held job.
    expect(result.releaseRisk).toBe("high");
    expect(result.artifactRisk).toBe("high");
    expect(result.priorApprovedContextFindingCount).toBe(1);
  });

  test("diverged: only findings new since the approval keep scoring", () => {
    const result = computeScanRiskBreakdown(
      [
        contextFinding("file.native-artifact", "lib/cli.node"),
        contextFinding("file.secret-content", "lib/new.js"),
      ],
      makeAiReview(),
      consistency({
        status: "diverged",
        newFindingCount: 1,
        newFindings: [{ ruleId: "file.secret-content", severity: "high", file: "lib/new.js" }],
      }),
    );
    expect(result.contextRisk).toBe("high");
    expect(result.priorApprovedContextFindingCount).toBe(1);
  });

  test("fails closed when the new-finding list was truncated by the cap", () => {
    // newFindingCount > newFindings.length means the exact approved set can't be
    // reconstructed. Demoting on a partial list could drop a real finding.
    const result = computeScanRiskBreakdown(
      [contextFinding("file.native-artifact", "lib/cli.node")],
      makeAiReview(),
      consistency({ status: "diverged", newFindingCount: 40, newFindings: [] }),
    );
    expect(result.contextRisk).toBe("high");
    expect(result.priorApprovedContextFindingCount).toBe(0);
  });

  test("fails closed when there is no prior approved scan", () => {
    const result = computeScanRiskBreakdown(
      [contextFinding("file.native-artifact", "lib/cli.node")],
      makeAiReview(),
      consistency({ status: "none", priorScanId: null }),
    );
    expect(result.contextRisk).toBe("high");
    expect(result.priorApprovedContextFindingCount).toBe(0);
  });
});

describe("release memory never demotes AI findings", () => {
  // The release-memory profile is built from deterministic rule findings only,
  // so a "match" says nothing about what the AI reviewer found. An AI finding is
  // projected without a ruleId; that is what keeps it out of the adjustment.
  const aiContextFinding = () => ({
    severity: "high",
    file: "lib/vendor.js",
    evidence: "e",
    reason: "r",
    releaseDelta: false,
    diffStatus: "unchanged",
  });
  const matched = {
    status: "match",
    priorScanId: "scan-prior",
    priorVersion: "1.0.0",
    decidedAt: "2026-07-01T00:00:00.000Z",
    currentFindingCount: 1,
    priorFindingCount: 1,
    newFindingCount: 0,
    newFindings: [],
  };

  test("an AI context finding keeps scoring through a matching profile", () => {
    const result = computeScanRiskBreakdown([aiContextFinding()], makeAiReview(), matched);
    expect(result.contextRisk).toBe("high");
    expect(result.priorApprovedContextFindingCount).toBe(0);
  });

  test("a deterministic finding is dropped while the AI one beside it is not", () => {
    const result = computeScanRiskBreakdown(
      [
        {
          ruleId: "file.native-artifact",
          severity: "high",
          file: "lib/cli.node",
          evidence: "e",
          reason: "r",
          releaseDelta: false,
          diffStatus: "unchanged",
        },
        aiContextFinding(),
      ],
      makeAiReview(),
      matched,
    );
    expect(result.priorApprovedContextFindingCount).toBe(1);
    expect(result.contextRisk).toBe("high");
  });
});

describe("release memory and a skipped baseline", () => {
  // When the published baseline exceeds the download budget the comparison is
  // skipped and every finding is annotated `unknown` package context, so the
  // whole scan lands in release memory's bucket. Discounting it on a profile
  // match would grade an uncompared release as clean — the exact failure the
  // skipped-baseline handling exists to prevent. The profile is
  // (ruleId, severity, file); identical bytes are not implied.
  const uncomparedFinding = (file) => ({
    ruleId: "file.native-artifact",
    severity: "high",
    file,
    evidence: "e",
    reason: "r",
    releaseDelta: false,
    diffStatus: "unknown",
  });
  const matched = {
    status: "match",
    priorScanId: "scan-prior",
    priorVersion: "1.0.0",
    decidedAt: "2026-07-01T00:00:00.000Z",
    currentFindingCount: 2,
    priorFindingCount: 2,
    newFindingCount: 0,
    newFindings: [],
  };
  const findings = [uncomparedFinding("pkg/_c.pyd"), uncomparedFinding("pkg/_d.pyd")];

  test("a matching profile does not discount an uncompared release", () => {
    const result = computeScanRiskBreakdown(findings, makeAiReview(), matched, {
      baselineComparisonSkipped: true,
    });
    expect(result.artifactRisk).toBe("high");
    expect(result.contextRisk).toBe("high");
    expect(result.priorApprovedContextFindingCount).toBe(0);
  });

  test("the same scan with a real baseline still discounts", () => {
    const result = computeScanRiskBreakdown(findings, makeAiReview(), matched);
    expect(result.artifactRisk).toBe("low");
    expect(result.priorApprovedContextFindingCount).toBe(2);
  });
});

const RISK_LEVELS = ["low", "medium", "high", "critical"];
const RANK = { low: 0, medium: 1, high: 2, critical: 3 };
const VERDICT_CAP = {
  nothing_unusual: "low",
  review_recommended: "medium",
  suspicious: "high",
  blocked: "critical",
};
const maxRisk = (...levels) => levels.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), "low");
const minRisk = (a, b) => (RANK[a] < RANK[b] ? a : b);

function deterministicAt(level, extra = {}) {
  return level === "low"
    ? []
    : [{ severity: level, file: "lib/rule.js", evidence: "e", reason: "r", ...extra }];
}

// A completed review whose own risk and single finding both sit at `level`.
function reviewAt(releaseAssessment, level, overrides = {}) {
  return makeAiReview({
    status: "complete",
    releaseAssessment,
    risk: level,
    requiresManualReview: false,
    findings: [
      {
        severity: level,
        file: "lib/new.js",
        evidence: "e",
        reason: "r",
        recommendation: "x",
      },
    ],
    model: "reviewer",
    ...overrides,
  });
}

function annotated(level, overrides = {}) {
  return [{ severity: level, releaseDelta: true, diffStatus: "modified", ...overrides }];
}

const MATRIX = Object.keys(VERDICT_CAP).flatMap((assessment) =>
  RISK_LEVELS.flatMap((aiRisk) =>
    RISK_LEVELS.map((deterministicRisk) => ({ assessment, aiRisk, deterministicRisk })),
  ),
);

describe("AI contribution is capped by the reviewer's own verdict", () => {
  test.each(MATRIX)(
    "$assessment with AI $aiRisk over deterministic $deterministicRisk",
    ({ assessment, aiRisk, deterministicRisk }) => {
      const expected = maxRisk(deterministicRisk, minRisk(aiRisk, VERDICT_CAP[assessment]));
      const review = reviewAt(assessment, aiRisk);

      expect(computeScanRisk(deterministicAt(deterministicRisk), review)).toBe(expected);

      // A release-delta finding gives the release score the same
      // verdict-bounded contribution as the artifact score.
      const breakdown = computeScanRiskBreakdown(
        deterministicAt(deterministicRisk, { releaseDelta: true }),
        review,
        null,
        { aiFindings: annotated(aiRisk) },
      );
      expect(breakdown.artifactRisk).toBe(expected);
      expect(breakdown.releaseRisk).toBe(expected);
    },
  );

  test("a nothing_unusual review with restating high findings adds nothing", () => {
    const review = reviewAt("nothing_unusual", "high", { risk: "low" });
    const result = computeScanRiskBreakdown([], review, null, { aiFindings: annotated("high") });
    expect(result.artifactRisk).toBe("low");
    expect(result.releaseRisk).toBe("low");
    expect(result.contextRisk).toBe("low");
  });

  test("the manual-review floor still applies under a nothing_unusual verdict", () => {
    const review = reviewAt("nothing_unusual", "high", { requiresManualReview: true });
    expect(computeScanRisk([], review)).toBe("medium");
  });

  test("an attempted but unavailable review still floors at medium", () => {
    expect(computeScanRisk([], makeAiReview({ status: "invalid", model: "reviewer" }))).toBe(
      "medium",
    );
  });

  test("AI finding severities on package context are verdict-bounded in contextRisk", () => {
    const review = reviewAt("review_recommended", "critical");
    const result = computeScanRiskBreakdown([], review, null, {
      aiFindings: annotated("critical", { releaseDelta: false }),
    });
    expect(result.contextRisk).toBe("medium");
  });
});

describe("AI-only escalations reach the release without a located line", () => {
  test("a suspicious review with no findings escalates over a medium deterministic release", () => {
    // The prompt tells the reviewer not to restate deterministic findings, so a
    // real escalation can arrive with none of its own.
    const review = reviewAt("suspicious", "high", { requiresManualReview: true, findings: [] });
    const result = computeScanRiskBreakdown(
      deterministicAt("medium", { releaseDelta: true }),
      review,
      null,
      { aiFindings: [] },
    );
    expect(result.releaseRisk).toBe("high");
  });

  test("a legacy recorded review (no category, no line) still escalates the release", () => {
    const legacy = reviewAt("suspicious", "high", { reviewerVersion: "1.7.0" });
    const result = computeScanRiskBreakdown([], legacy, null, {
      aiFindings: [{ severity: "high", releaseDelta: true, diffStatus: "modified" }],
    });
    expect(result.releaseRisk).toBe("high");
  });

  test("a blocked review with a critical release finding reaches critical", () => {
    const result = computeScanRiskBreakdown([], reviewAt("blocked", "critical"), null, {
      aiFindings: annotated("critical"),
    });
    expect(result.releaseRisk).toBe("critical");
  });
});

describe("AI review never lowers deterministic risk", () => {
  const assessments = Object.keys(VERDICT_CAP);
  const attributions = [annotated("low"), annotated("critical"), [{ releaseDelta: false }], []];

  test.each(RISK_LEVELS)("deterministic %s survives every AI review shape", (level) => {
    for (const assessment of assessments) {
      for (const aiRisk of RISK_LEVELS) {
        for (const aiFindings of attributions) {
          const review = reviewAt(assessment, aiRisk, {
            deterministicAssessments: [
              {
                ruleId: "code.network-access",
                file: "lib/rule.js",
                verdict: "disputed",
                note: "n",
              },
            ],
          });
          expect(RANK[computeScanRisk(deterministicAt(level), review)]).toBeGreaterThanOrEqual(
            RANK[level],
          );
          const releaseSide = computeScanRiskBreakdown(
            deterministicAt(level, { releaseDelta: true }),
            review,
            null,
            { aiFindings },
          );
          expect(RANK[releaseSide.artifactRisk]).toBeGreaterThanOrEqual(RANK[level]);
          expect(RANK[releaseSide.releaseRisk]).toBeGreaterThanOrEqual(RANK[level]);
          const contextSide = computeScanRiskBreakdown(
            deterministicAt(level, { releaseDelta: false }),
            review,
            null,
            { aiFindings },
          );
          expect(RANK[contextSide.contextRisk]).toBeGreaterThanOrEqual(RANK[level]);
        }
      }
    }
  });

  test("deterministic assessments never move a score", () => {
    const findings = deterministicAt("high", { releaseDelta: true, ruleId: "code.network-access" });
    const base = reviewAt("review_recommended", "medium");
    const disputing = {
      ...base,
      deterministicAssessments: [
        { ruleId: "code.network-access", file: "lib/rule.js", verdict: "disputed", note: "FP" },
      ],
    };
    expect(computeScanRiskBreakdown(findings, disputing)).toEqual(
      computeScanRiskBreakdown(findings, base),
    );
  });
});
