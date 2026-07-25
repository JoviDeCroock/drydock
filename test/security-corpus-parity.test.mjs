import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  createPackageDiff,
  deterministicFindings,
  packageJsonDiffFindings,
  summarizePackageJsonDiff,
} from "../server/lib/review";
import {
  createPyPiReleaseCandidateReview,
  parsePyPiReleaseManifest,
} from "../server/lib/adapters/pypi";

const __dirname = dirname(fileURLToPath(import.meta.url));
const corpusDir = join(__dirname, "fixtures/security-corpus");

function loadCorpus(relativeDir, ecosystem) {
  const dir = join(corpusDir, relativeDir);
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => ({
      ecosystem,
      file: `${relativeDir}/${file}`,
      fixture: JSON.parse(readFileSync(join(dir, file), "utf8")),
    }));
}

const npmFixtures = loadCorpus("cases", "npm");
const pypiFixtures = loadCorpus("cases-pypi", "pypi");
const allFixtures = [...npmFixtures, ...pypiFixtures];

function runNpm(fixture) {
  const previousFiles = fixture.previousFiles ?? [];
  const stagedFiles = fixture.stagedFiles ?? [];
  const diff = createPackageDiff(previousFiles, stagedFiles);
  const packageJsonDiff = summarizePackageJsonDiff(
    fixture.previousPackageJson,
    fixture.stagedPackageJson,
  );
  return [
    ...deterministicFindings(stagedFiles, diff, fixture.stagedPackageJson),
    ...packageJsonDiffFindings(packageJsonDiff),
  ];
}

function runPyPi(fixture) {
  const review = createPyPiReleaseCandidateReview({
    manifest: parsePyPiReleaseManifest(fixture.manifest),
    artifacts: fixture.artifacts,
    previousArtifacts: fixture.previousArtifacts,
  });
  return review.ruleFindings;
}

function runEngine(entry) {
  return entry.ecosystem === "npm" ? runNpm(entry.fixture) : runPyPi(entry.fixture);
}

// Reduce a finding set to a sorted multiset of `${ruleId}:${severity}` strings,
// dropping the rule IDs this fixture documents as legitimately ecosystem-specific.
function ruleSeverityMultiset(findings, ignoreRuleIds) {
  const ignore = new Set(ignoreRuleIds ?? []);
  return findings
    .filter((finding) => !ignore.has(finding.ruleId))
    .map((finding) => `${finding.ruleId}:${finding.severity}`)
    .sort((a, b) => a.localeCompare(b));
}

const groups = new Map();
for (const entry of allFixtures) {
  const group = entry.fixture.parityGroup;
  if (!group) continue;
  if (!groups.has(group)) groups.set(group, []);
  groups.get(group).push(entry);
}

describe("cross-corpus npm<->pypi rule-ID parity", () => {
  test("at least one parity group is declared", () => {
    expect(groups.size).toBeGreaterThan(0);
  });

  for (const [group, entries] of groups) {
    describe(`parity group: ${group}`, () => {
      test("has exactly one npm fixture and one pypi fixture", () => {
        const ecosystems = entries.map((entry) => entry.ecosystem).sort();
        expect(ecosystems).toEqual(["npm", "pypi"]);
      });

      test("npm and pypi findings agree on rule IDs and severities", () => {
        const npm = entries.find((entry) => entry.ecosystem === "npm");
        const pypi = entries.find((entry) => entry.ecosystem === "pypi");
        // Skip silently is wrong here: a malformed group is a real failure
        // surfaced by the membership test above, so guard with a hard assertion.
        expect(npm, `parity group "${group}" is missing an npm fixture`).toBeTruthy();
        expect(pypi, `parity group "${group}" is missing a pypi fixture`).toBeTruthy();

        const npmMultiset = ruleSeverityMultiset(runEngine(npm), npm.fixture.parityIgnoreRuleIds);
        const pypiMultiset = ruleSeverityMultiset(
          runEngine(pypi),
          pypi.fixture.parityIgnoreRuleIds,
        );

        expect(npmMultiset, `npm fixture: ${npm.file}`).toEqual(pypiMultiset);
      });
    });
  }
});
