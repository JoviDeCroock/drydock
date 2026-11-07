import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { DETERMINISTIC_RULE_IDS, DETERMINISTIC_RULES_VERSION } from "../server/lib/review";
import { createProvenanceCorpusReview } from "./helpers/provenance-security-corpus.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const casesDir = join(__dirname, "fixtures/security-corpus/cases-provenance");
const cases = readdirSync(casesDir)
  .filter((file) => file.endsWith(".json"))
  .sort()
  .map((file) => JSON.parse(readFileSync(join(casesDir, file), "utf8")));

const PROVENANCE_RULES = [
  DETERMINISTIC_RULE_IDS.releaseProvenanceDropped,
  DETERMINISTIC_RULE_IDS.releaseProvenancePublisherChanged,
];

function comparableFindings(findings) {
  return findings
    .map((finding) => ({ ruleId: finding.ruleId, severity: finding.severity, file: finding.file }))
    .sort((a, b) =>
      `${a.ruleId}:${a.severity}:${a.file}`.localeCompare(`${b.ruleId}:${b.severity}:${b.file}`),
    );
}

describe("registry provenance continuity golden corpus", () => {
  test("corpus contains unique fixture IDs", () => {
    expect(cases.length).toBeGreaterThan(0);
    expect(new Set(cases.map((fixture) => fixture.id)).size).toBe(cases.length);
  });

  test("corpus covers both provenance rules in npm and PyPI", () => {
    for (const ecosystem of ["npm", "pypi"]) {
      const covered = new Set(
        cases
          .filter((fixture) => fixture.ecosystem === ecosystem)
          .flatMap((fixture) => fixture.expectedFindings.map((finding) => finding.ruleId)),
      );
      for (const ruleId of PROVENANCE_RULES) expect(covered, ecosystem).toContain(ruleId);
    }
  });

  for (const fixture of cases) {
    test(`${fixture.id}: ${fixture.title}`, () => {
      const review = createProvenanceCorpusReview(fixture);
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
