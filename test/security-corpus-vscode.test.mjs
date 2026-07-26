import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  buildVscodeReleaseManifest,
  createVscodeExtensionReview,
  VSCODE_RULE_IDS,
  VSCODE_RULES_VERSION,
} from "../server/lib/ecosystems/vscode";
import { DETERMINISTIC_RULES_VERSION } from "../server/lib/review";

const __dirname = dirname(fileURLToPath(import.meta.url));
const casesDir = join(__dirname, "fixtures/security-corpus/cases-vscode");
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

describe("VS Code security detection golden corpus", () => {
  test("corpus contains unique fixture IDs", () => {
    expect(cases.length).toBeGreaterThan(0);
    expect(new Set(cases.map((fixture) => fixture.id)).size).toBe(cases.length);
  });

  for (const fixture of cases) {
    test(`${fixture.id}: ${fixture.title}`, () => {
      const path = fixture.artifactPath ?? `dist/${fixture.extensionId}-${fixture.version}.vsix`;
      const manifest = buildVscodeReleaseManifest(fixture.extensionId, fixture.version, [
        { path, sha256: fixture.sha256 },
      ]);
      const review = createVscodeExtensionReview({
        manifest,
        artifact: { path, sha256: fixture.sha256, files: fixture.stagedFiles },
        ...(fixture.previousFiles
          ? {
              previousArtifact: {
                path,
                sha256: fixture.previousSha256,
                files: fixture.previousFiles,
              },
            }
          : {}),
      });

      expect(review.risk).toBe(fixture.expectedRisk);
      expect(comparableFindings(review.ruleFindings)).toEqual(
        comparableFindings(fixture.expectedFindings ?? []),
      );
      for (const finding of review.ruleFindings) {
        const expectedVersion = Object.values(VSCODE_RULE_IDS).includes(finding.ruleId)
          ? VSCODE_RULES_VERSION
          : DETERMINISTIC_RULES_VERSION;
        expect(finding.ruleVersion).toBe(expectedVersion);
      }
    });
  }
});
