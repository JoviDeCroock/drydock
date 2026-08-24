import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { BROWSER_RULE_IDS, BROWSER_RULES_VERSION } from "../server/lib/ecosystems/browser";
import { DETERMINISTIC_RULES_VERSION } from "../server/lib/review";
import { createBrowserCorpusReview } from "./helpers/browser-security-corpus.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const casesDir = join(__dirname, "fixtures/security-corpus/cases-browser");
const cases = readdirSync(casesDir)
  .filter((file) => file.endsWith(".json"))
  .sort()
  .map((file) => JSON.parse(readFileSync(join(casesDir, file), "utf8")));

function comparableFindings(findings) {
  return findings
    .map(({ ruleId, severity, file }) => ({ ruleId, severity, file }))
    .sort((a, b) =>
      `${a.ruleId}:${a.severity}:${a.file}`.localeCompare(`${b.ruleId}:${b.severity}:${b.file}`),
    );
}

describe("browser extension security detection golden corpus", () => {
  test("corpus contains unique fixture IDs", () => {
    expect(cases.length).toBeGreaterThan(0);
    expect(new Set(cases.map((fixture) => fixture.id)).size).toBe(cases.length);
  });

  for (const fixture of cases) {
    test(`${fixture.id}: ${fixture.title}`, () => {
      const review = createBrowserCorpusReview(fixture);

      expect(review.risk).toBe(fixture.expectedRisk);
      expect(comparableFindings(review.ruleFindings)).toEqual(
        comparableFindings(fixture.expectedFindings ?? []),
      );
      for (const finding of review.ruleFindings) {
        const expectedVersion = Object.values(BROWSER_RULE_IDS).includes(finding.ruleId)
          ? BROWSER_RULES_VERSION
          : DETERMINISTIC_RULES_VERSION;
        expect(finding.ruleVersion).toBe(expectedVersion);
      }
    });
  }
});
