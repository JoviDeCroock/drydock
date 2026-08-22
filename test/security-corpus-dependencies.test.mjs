// @ts-nocheck
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  assessDependencyArtifact,
  computeRisk,
  dependencyEvidenceFindings,
  DETERMINISTIC_RULES_VERSION,
  selectAddedDependencies,
  summarizePackageJsonDiff,
} from "../server/lib/review";
import { getReleaseRecommendation } from "../src/pages/Dashboard/recommendation";

const __dirname = dirname(fileURLToPath(import.meta.url));
const casesDir = join(__dirname, "fixtures/security-corpus/cases-dependencies");
const cases = readdirSync(casesDir)
  .filter((file) => file.endsWith(".json"))
  .sort()
  .map((file) => JSON.parse(readFileSync(join(casesDir, file), "utf8")));

// Stands in for the registry + sandbox: the fixture supplies the bytes each
// declared dependency resolves to, so the corpus exercises selection →
// assessment → findings without any network. Resolution itself is covered by
// test/npm-dependency-artifacts.test.mjs and test/npm-semver.test.mjs.
function buildReview(fixture) {
  const diff = summarizePackageJsonDiff(fixture.previousPackageJson, fixture.stagedPackageJson);
  const selected = selectAddedDependencies(diff);
  const dependencies = selected.map((dependency) => {
    const resolved = fixture.dependencyArtifacts?.[dependency.name];
    if (!resolved) {
      return {
        ...emptyEvidence(dependency),
        status: "uninspectable",
        reason: fixture.uninspectableReasons?.[dependency.name] ?? "metadata-unavailable",
      };
    }
    const assessment = assessDependencyArtifact(resolved.files, resolved.packageJson, {
      codePatternSet: "javascript",
      entrypointResolution: "npm",
    });
    return {
      ...emptyEvidence(dependency),
      status: "inspected",
      resolvedVersion: resolved.version,
      registryHost: "registry.npmjs.org",
      declaredDigest: resolved.declaredDigest ?? null,
      reviewedDigest: resolved.reviewedDigest ?? null,
      digestVerified: typeof resolved.digestVerified === "boolean" ? resolved.digestVerified : null,
      fileCount: resolved.files.length,
      automaticExecution: assessment.automaticExecution,
      capabilities: assessment.capabilities,
      installReachableCapabilities: assessment.installReachableCapabilities,
      verdict: assessment.verdict,
    };
  });
  const inspectedCount = dependencies.filter((entry) => entry.status === "inspected").length;
  return {
    status: dependencies.length ? "complete" : "not-applicable",
    selectedCount: dependencies.length,
    inspectedCount,
    uninspectableCount: dependencies.length - inspectedCount,
    dependencies,
  };
}

function emptyEvidence(dependency) {
  return {
    name: dependency.name,
    section: dependency.section,
    declaredSpec: dependency.spec,
    declarationKind: dependency.declarationKind,
    status: "uninspectable",
    reason: null,
    resolvedVersion: null,
    registryHost: null,
    artifactUrl: null,
    declaredDigest: null,
    reviewedDigest: null,
    digestVerified: null,
    fileCount: null,
    automaticExecution: [],
    capabilities: [],
    installReachableCapabilities: [],
    verdict: "clean",
  };
}

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

describe("dependency-artifact detection corpus", () => {
  test("corpus contains unique fixture IDs", () => {
    expect(cases.length).toBeGreaterThan(0);
    expect(new Set(cases.map((fixture) => fixture.id)).size).toBe(cases.length);
  });

  for (const fixture of cases) {
    test(`${fixture.id}: ${fixture.title}`, () => {
      const review = buildReview(fixture);
      const findings = dependencyEvidenceFindings(review, {
        name: fixture.stagedPackageJson?.name ?? null,
        version: fixture.stagedPackageJson?.version ?? null,
      });

      expect(review.dependencies.map((entry) => entry.name).sort()).toEqual(
        [...(fixture.expectedDependencies ?? [])].map((entry) => entry.name).sort(),
      );
      for (const expected of fixture.expectedDependencies ?? []) {
        const actual = review.dependencies.find((entry) => entry.name === expected.name);
        expect(actual, `dependency ${expected.name}`).toMatchObject(expected);
      }

      expect(comparableFindings(findings)).toEqual(
        comparableFindings(fixture.expectedFindings ?? []),
      );
      for (const finding of findings) {
        expect(finding.ruleVersion).toBe(DETERMINISTIC_RULES_VERSION);
      }
      expect(computeRisk(findings)).toBe(fixture.expectedRisk);

      // Every dependency-artifact finding is release-scoped, so the corpus's
      // expected risk is also the release risk the recommendation reads. Pin
      // the maintainer-facing verdict too: "reaches critical" and "cannot be
      // recommended for approval" are two different claims, and the acceptance
      // criterion is the second one.
      const recommendation = getReleaseRecommendation(
        fixture.expectedRisk,
        fixture.expectedRisk,
        findings.length,
      );
      expect(recommendation.label).toBe(fixture.expectedRecommendation);
    });
  }
});
