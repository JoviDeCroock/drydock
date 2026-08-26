// Machine checks for the detection rule manifest (the deterministic-guardrail
// pattern: every recurring add-a-rule mistake becomes a failing test, not a
// checklist item):
//
// 1. Every rule ID a corpus fixture asserts exists in a rule registry, so a
//    typo'd or stale fixture cannot silently assert nothing.
// 2. Every registered rule is asserted by at least one corpus fixture, with an
//    exact exception list for rules whose inputs the corpus harness cannot
//    represent. The list is a ratchet: adding a rule without a fixture fails
//    here, and adding a fixture for an excepted rule forces its removal.
// 3. The rule inventory table in docs/security-detection-corpus.md lists
//    exactly the registered rule IDs, so the docs cannot drift from the code.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { DETERMINISTIC_RULES } from "../server/lib/review/rules/rule-ids";
import { PYPI_RULE_IDS } from "../server/lib/ecosystems/pypi/types";
import { VSCODE_RULE_IDS } from "../server/lib/ecosystems/vscode/types";

const __dirname = dirname(fileURLToPath(import.meta.url));
const corpusRoot = join(__dirname, "fixtures/security-corpus");
const corpusDirs = [
  "cases",
  "cases-atpm",
  "cases-benign",
  "cases-frontier",
  "cases-pypi",
  "cases-vscode",
];

// Rules the golden corpus cannot exercise because their inputs are not part of
// the fixture shape (FileRecord[] plus manifest summaries). Each stays covered
// at the unit layer instead.
const CORPUS_COVERAGE_EXCEPTIONS = new Map([
  // Compares staged registry metadata against the packed artifact; covered by
  // test/staged-artifact-integrity.test.mjs.
  ["stage.metadata-mismatch", "staged-artifact integrity comparison"],
  ["stage.tarball-digest-mismatch", "staged-artifact integrity comparison"],
  // Emitted from tar parser structural metadata (TarSuspiciousEntry), which
  // FileRecord fixtures cannot carry; covered by test/review.test.mjs.
  ["tar.suspicious-entry", "tar parser structural metadata"],
  // Compares the release against the repository fingerprint; covered by
  // test/release-fingerprint.test.ts.
  ["release.source-drift", "release fingerprint comparison"],
  // Compare marketplace metadata and extension manifests outside the vsix
  // artifact fixtures; covered by test/vscode.test.mjs.
  ["vscode.metadata-mismatch", "marketplace metadata comparison"],
  ["vscode.extension-dependency", "extension manifest dependency review"],
]);

const RULE_ID_PATTERN = /^[a-z][a-z0-9-]*\.[a-z0-9-]+$/;

const registeredIds = new Set([
  ...Object.values(DETERMINISTIC_RULES).map((spec) => spec.id),
  ...Object.values(PYPI_RULE_IDS),
  ...Object.values(VSCODE_RULE_IDS),
]);

function fixtureAssertedRuleIds() {
  const asserted = new Map();
  for (const dir of corpusDirs) {
    const casesDir = join(corpusRoot, dir);
    for (const file of readdirSync(casesDir).filter((name) => name.endsWith(".json"))) {
      const fixture = JSON.parse(readFileSync(join(casesDir, file), "utf8"));
      for (const finding of fixture.expectedFindings ?? []) {
        if (!asserted.has(finding.ruleId)) asserted.set(finding.ruleId, []);
        asserted.get(finding.ruleId).push(`${dir}/${file}`);
      }
    }
  }
  return asserted;
}

describe("detection rule coverage", () => {
  test("rule IDs are well-formed and unique across registries", () => {
    const all = [
      ...Object.values(DETERMINISTIC_RULES).map((spec) => spec.id),
      ...Object.values(PYPI_RULE_IDS),
      ...Object.values(VSCODE_RULE_IDS),
    ];
    for (const id of all) {
      expect(id, `rule ID ${id} must be dot-namespaced kebab-case`).toMatch(RULE_ID_PATTERN);
    }
    expect(new Set(all).size).toBe(all.length);
  });

  test("every rule ID asserted by a corpus fixture is registered", () => {
    const unknown = [...fixtureAssertedRuleIds()]
      .filter(([ruleId]) => !registeredIds.has(ruleId))
      .map(([ruleId, files]) => `${ruleId} (${files.join(", ")})`);
    expect(unknown).toEqual([]);
  });

  test("every registered rule has a corpus fixture or an explicit exception", () => {
    const asserted = fixtureAssertedRuleIds();
    const uncovered = [...registeredIds].filter((id) => !asserted.has(id)).sort();
    expect(uncovered).toEqual([...CORPUS_COVERAGE_EXCEPTIONS.keys()].sort());
    // The ratchet's other direction: an exception for a rule the corpus now
    // covers (or that no longer exists) is stale and must be removed.
    for (const ruleId of CORPUS_COVERAGE_EXCEPTIONS.keys()) {
      expect(registeredIds.has(ruleId), `exception for unregistered rule ${ruleId}`).toBe(true);
      expect(asserted.has(ruleId), `stale exception: ${ruleId} now has a fixture`).toBe(false);
    }
  });

  test("docs rule inventory matches the registries exactly", () => {
    const doc = readFileSync(join(__dirname, "../docs/security-detection-corpus.md"), "utf8");
    const section = doc.split("## Rule inventory")[1]?.split("\n## ")[0];
    expect(
      section,
      "docs/security-detection-corpus.md needs a '## Rule inventory' section",
    ).toBeTruthy();
    const documented = new Set(
      [...section.matchAll(/^\| `([^`]+)`\s+\|/gm)].map((match) => match[1]),
    );
    expect([...documented].sort()).toEqual([...registeredIds].sort());
  });
});
