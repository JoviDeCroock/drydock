import { describe, expect, test } from "vitest";
import { computeRisk } from "../server/lib/review";
import { computeScanRiskBreakdown } from "../server/lib/review/risk";

describe("computeRisk weighted multi-signal roll-up (issue #193)", () => {
  const code = (ruleId, severity, extra = {}) => ({ ruleId, severity, file: "f.js", ...extra });

  test("a lone process-execution capability de-escalates to low", () => {
    // The benign-build-script false positive: a build helper that shells out is
    // not, on its own, evidence of risk.
    expect(computeRisk([code("code.process-execution", "high")])).toBe("low");
  });

  test("two distinct code capabilities co-occur to high", () => {
    expect(
      computeRisk([code("code.process-execution", "high"), code("code.credential-access", "high")]),
    ).toBe("high");
  });

  test("two individually-weak (medium) capabilities still escalate to high", () => {
    // Under max-severity this stalled at medium and under-detected; co-occurrence
    // now treats the combination as the multi-signal risk it is.
    expect(
      computeRisk([
        code("code.network-access", "medium"),
        code("code.dynamic-evaluation", "medium"),
      ]),
    ).toBe("high");
  });

  test("a lone remote-shell capability is not de-escalated", () => {
    // `code.remote-shell` used to live inside `code.process-execution`, so
    // `execSync('curl … | bash')` scored as one weak capability and the release
    // rolled up to low — the gate then recommended approve. Shelling out to a
    // compiler and shelling out to the network are not the same evidence.
    expect(computeRisk([code("code.remote-shell", "high")])).toBe("high");
    expect(computeRisk([code("code.remote-shell", "critical")])).toBe("critical");
  });

  test("co-occurrence is a floor, not a ceiling", () => {
    // The co-occurrence branch used to return a flat "high", which meant adding a
    // second capability could *lower* a critical one. Escalation must never
    // de-escalate.
    expect(
      computeRisk([code("code.remote-shell", "critical"), code("code.process-execution", "high")]),
    ).toBe("critical");
  });

  test("an obfuscated lone capability is not de-escalated", () => {
    // Assembling `child_process` from string fragments is itself a malice signal,
    // so a lone obfuscated process-execution keeps its severity.
    expect(computeRisk([code("code.process-execution", "high", { obfuscated: true })])).toBe(
      "high",
    );
  });

  test("a lone non-process capability keeps its own severity", () => {
    // eval/atob on an added file stays high (obfuscation survives base64 wrapping)…
    expect(computeRisk([code("code.dynamic-evaluation", "high")])).toBe("high");
    // …while a lone modified-file network read stays medium.
    expect(computeRisk([code("code.network-access", "medium")])).toBe("medium");
  });

  test("authoritative non-code findings still set a severity floor on their own", () => {
    expect(computeRisk([{ ruleId: "file.outside-files-list", severity: "high", file: "x" }])).toBe(
      "high",
    );
    expect(
      computeRisk([{ ruleId: "install-script.preinstall", severity: "critical", file: "p" }]),
    ).toBe("critical");
  });

  test("an install-hook anchor floors a lone process-execution to high", () => {
    expect(
      computeRisk([
        { ruleId: "install-script.lifecycle", severity: "high", file: "package.json" },
        code("code.process-execution", "high"),
      ]),
    ).toBe("high");
  });

  test("findings without a rule id anchor at their severity (fail toward higher risk)", () => {
    expect(computeRisk([{ severity: "high", file: "x" }])).toBe("high");
  });

  test("no findings is low", () => {
    expect(computeRisk([])).toBe("low");
  });
});

describe("expanded capabilities in release scoring", () => {
  const code = (ruleId, severity, extra = {}) => ({ ruleId, severity, file: "f.js", ...extra });
  const expanded = { expandedCapability: true };

  test("a lone expanded capability scores one step lower", () => {
    expect(computeRisk([code("code.network-access", "high", expanded)])).toBe("medium");
    expect(computeRisk([code("code.network-access", "high")])).toBe("high");
  });

  test("expanded capabilities still co-occur, across files too", () => {
    expect(
      computeRisk([
        code("code.network-access", "medium", expanded),
        { ...code("code.process-execution", "high", expanded), file: "cli.js" },
      ]),
    ).toBe("high");
    expect(
      computeRisk([
        code("code.credential-access", "medium"),
        code("code.process-execution", "high", expanded),
      ]),
    ).toBe("high");
  });

  test("only release risk treats an expanded finding as weaker", () => {
    const breakdown = computeScanRiskBreakdown(
      [
        {
          ...code("code.network-access", "high"),
          evidence: "e",
          reason: "r",
          diffStatus: "modified",
          releaseDelta: true,
          releaseDeltaKind: "expanded",
        },
      ],
      {
        status: "unavailable",
        risk: "low",
        releaseAssessment: "not_assessed",
        summary: "",
        findings: [],
        requiresManualReview: false,
        model: null,
        reviewerVersion: null,
      },
    );

    expect(breakdown.releaseRisk).toBe("medium");
    expect(breakdown.artifactRisk).toBe("high");
  });
});
