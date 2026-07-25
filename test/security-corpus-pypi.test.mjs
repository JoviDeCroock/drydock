import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  createPyPiReleaseCandidateReview,
  parsePyPiReleaseManifest,
  PYPI_RULES_VERSION,
} from "../server/lib/adapters/pypi";
import { DETERMINISTIC_RULES_VERSION } from "../server/lib/review";

const __dirname = dirname(fileURLToPath(import.meta.url));
const casesDir = join(__dirname, "fixtures/security-corpus/cases-pypi");
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

describe("PyPI security detection golden corpus", () => {
  test("corpus contains unique fixture IDs", () => {
    expect(cases.length).toBeGreaterThan(0);
    expect(new Set(cases.map((fixture) => fixture.id)).size).toBe(cases.length);
  });

  for (const fixture of cases) {
    test(`${fixture.id}: ${fixture.title}`, () => {
      const review = createPyPiReleaseCandidateReview({
        manifest: parsePyPiReleaseManifest(fixture.manifest),
        artifacts: fixture.artifacts,
        previousArtifacts: fixture.previousArtifacts,
      });

      expect(review.risk).toBe(fixture.expectedRisk);
      expect(comparableFindings(review.ruleFindings)).toEqual(
        comparableFindings(fixture.expectedFindings ?? []),
      );

      // PyPI findings mix two rule families: pypi.* carry PYPI_RULES_VERSION,
      // shared file.*/code.*/diff.* carry DETERMINISTIC_RULES_VERSION.
      for (const finding of review.ruleFindings) {
        if (finding.ruleId.startsWith("pypi.")) {
          expect(finding.ruleVersion).toBe(PYPI_RULES_VERSION);
        } else {
          expect(finding.ruleVersion).toBe(DETERMINISTIC_RULES_VERSION);
        }
      }
    });
  }
});
