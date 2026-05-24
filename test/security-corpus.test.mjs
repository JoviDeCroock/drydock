import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  computeRisk,
  createPackageDiff,
  deterministicFindings,
  DETERMINISTIC_RULES_VERSION,
  summarizePackageJsonDiff,
} from "../server/lib/review.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const casesDir = join(__dirname, "fixtures/security-corpus/cases");
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

describe("security detection golden corpus", () => {
  test("corpus contains unique fixture IDs", () => {
    expect(cases.length).toBeGreaterThan(0);
    expect(new Set(cases.map((fixture) => fixture.id)).size).toBe(cases.length);
  });

  for (const fixture of cases) {
    test(`${fixture.id}: ${fixture.title}`, () => {
      const previousFiles = fixture.previousFiles ?? [];
      const stagedFiles = fixture.stagedFiles ?? [];
      const diff = createPackageDiff(previousFiles, stagedFiles);
      const findings = deterministicFindings(stagedFiles, diff, fixture.stagedPackageJson);

      expect(computeRisk(findings)).toBe(fixture.expectedRisk);
      expect(comparableFindings(findings)).toEqual(
        comparableFindings(fixture.expectedFindings ?? []),
      );
      for (const finding of findings) {
        expect(finding.ruleVersion).toBe(DETERMINISTIC_RULES_VERSION);
      }

      if (fixture.expectedPackageJsonDiff) {
        const packageJsonDiff = summarizePackageJsonDiff(
          fixture.previousPackageJson,
          fixture.stagedPackageJson,
        );
        expect(packageJsonDiff).toMatchObject(fixture.expectedPackageJsonDiff);
      }
    });
  }
});
