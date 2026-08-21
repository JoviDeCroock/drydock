import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { DETERMINISTIC_RULE_IDS, DETERMINISTIC_RULES_VERSION } from "../server/lib/review";
import { createAtpmCorpusReview } from "./helpers/atpm-security-corpus.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const casesDir = join(__dirname, "fixtures/security-corpus/cases-atpm");
const cases = readdirSync(casesDir)
  .filter((file) => file.endsWith(".json"))
  .sort()
  .map((file) => JSON.parse(readFileSync(join(casesDir, file), "utf8")));

function comparableFindings(findings) {
  return findings
    .map((finding) => ({
      ruleId: finding.ruleId,
      severity: finding.severity,
      file: finding.file,
    }))
    .sort((a, b) =>
      `${a.ruleId}:${a.severity}:${a.file}`.localeCompare(`${b.ruleId}:${b.severity}:${b.file}`),
    );
}

describe("atpm security detection golden corpus", () => {
  test("corpus contains unique fixture IDs", () => {
    expect(cases.length).toBeGreaterThan(0);
    expect(new Set(cases.map((fixture) => fixture.id)).size).toBe(cases.length);
  });

  test("corpus covers every registered atpm rule", () => {
    const registered = Object.values(DETERMINISTIC_RULE_IDS)
      .filter((ruleId) => ruleId.startsWith("atpm."))
      .sort();
    const covered = [
      ...new Set(
        cases.flatMap((fixture) => fixture.expectedFindings.map((finding) => finding.ruleId)),
      ),
    ]
      .filter((ruleId) => ruleId.startsWith("atpm."))
      .sort();
    expect(covered).toEqual(registered);
  });

  for (const fixture of cases) {
    test(`${fixture.id}: ${fixture.title}`, () => {
      const review = createAtpmCorpusReview(fixture);
      expect(review.risk).toBe(fixture.expectedRisk);
      expect(comparableFindings(review.findings)).toEqual(
        comparableFindings(fixture.expectedFindings ?? []),
      );
      for (const finding of review.findings) {
        expect(finding.ruleVersion).toBe(DETERMINISTIC_RULES_VERSION);
      }
    });
  }
});
