import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { runAiReviewEval, writeAiReviewEvalReport } from "./ai-review-harness.mjs";

const result = runAiReviewEval();
writeAiReviewEvalReport(result);

describe("AI reviewer eval (recorded-output gates)", () => {
  test("the versioned regression corpus passes", () => {
    expect(result.failures).toEqual([]);
    expect(result.summary.rate).toBe(1);
    expect(result.summary.total).toBe(5);
    expect(result.recordedReviewerVersions).toEqual(["1.2.0", "1.4.0"]);
    expect(result.currentReviewerVersion).toBe("1.4.0");
    expect(result.historicalFailures).toEqual([]);
    expect(result.historicalSummary).toEqual({ total: 5, passed: 5, rate: 1 });
  });

  test("gates current verdict and failure-mode coverage separately from historical output", () => {
    expect(result.byVerdict.malicious.rate).toBe(1);
    expect(result.byVerdict.benign.rate).toBe(1);
    expect(result.byVerdict.uncertain.rate).toBe(1);
    expect(result.byThreatClass["lifecycle-credential-exfiltration"].rate).toBe(1);
    expect(result.byThreatClass["credential-exfiltration-sink"].rate).toBe(1);
    expect(result.byScenario["hostile-evidence"].rate).toBe(1);
    expect(result.byScenario["missing-baseline"].rate).toBe(1);
    expect(result.byScenario["model-failover"].rate).toBe(1);
    expect(result.historicalByScenario["missing-baseline"].rate).toBe(1);
    expect(result.historicalByScenario["model-failover"].rate).toBe(1);
  });

  test("records provenance for every current-version result", () => {
    const corpus = JSON.parse(
      readFileSync(new URL("../fixtures/ai-review-eval/cases.json", import.meta.url), "utf8"),
    );

    expect(corpus.cases.map((record) => record.provenance)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "controlled-live", fixture: "preinstall-env-exfil" }),
        expect.objectContaining({ kind: "controlled-live", fixture: "benign-llm-prompt-docs" }),
        expect.objectContaining({ kind: "controlled-live", fixture: "prompt-injection-readme" }),
        expect.objectContaining({ kind: "production-fallback" }),
        expect.objectContaining({
          kind: "controlled-live",
          fixture: "credential-file-network-exfil",
        }),
      ]),
    );
  });

  test("rejects a stale record from the current-version gate", () => {
    const corpus = JSON.parse(
      readFileSync(new URL("../fixtures/ai-review-eval/cases.json", import.meta.url), "utf8"),
    );
    corpus.cases[0].review.reviewerVersion = "1.2.0";

    const stale = runAiReviewEval(corpus);

    expect(stale.summary).toEqual({ total: 5, passed: 4, rate: 4 / 5 });
    expect(stale.failures).toEqual([
      expect.objectContaining({
        id: "preinstall-env-exfil-v1-4",
        reason: "reviewer version 1.2.0 is not current",
      }),
    ]);
  });

  test("rejects duplicate case ids before they can skew the metrics", () => {
    const corpus = JSON.parse(
      readFileSync(new URL("../fixtures/ai-review-eval/cases.json", import.meta.url), "utf8"),
    );
    corpus.cases.push({ ...corpus.cases[0] });

    expect(() => runAiReviewEval(corpus)).toThrow(/duplicate case id/);
  });

  test("rejects duplicate ids across current and historical records", () => {
    const corpus = JSON.parse(
      readFileSync(new URL("../fixtures/ai-review-eval/cases.json", import.meta.url), "utf8"),
    );
    corpus.historicalCases.push({ ...corpus.cases[0] });

    expect(() => runAiReviewEval(corpus)).toThrow(/duplicate case id/);
  });

  test("rejects an empty corpus instead of reporting a vacuous pass", () => {
    expect(() => runAiReviewEval({ suiteVersion: 1, cases: [] })).toThrow(
      /cases must contain at least one record/,
    );
  });

  test("rejects a historical output relabeled as the current reviewer version", () => {
    const corpus = JSON.parse(
      readFileSync(new URL("../fixtures/ai-review-eval/cases.json", import.meta.url), "utf8"),
    );
    const relabeled = structuredClone(corpus.historicalCases[0]);
    relabeled.id = "relabeled-historical-output";
    relabeled.review.reviewerVersion = "1.4.0";
    relabeled.review.untrustedNote = "ignored by the persisted schema";
    corpus.cases = [relabeled];

    const duplicated = runAiReviewEval(corpus);

    expect(duplicated.summary).toEqual({ total: 1, passed: 0, rate: 0 });
    expect(duplicated.failures).toEqual([
      expect.objectContaining({
        id: "relabeled-historical-output",
        reason: "current record duplicates a historical reviewer output",
      }),
    ]);
  });
});
