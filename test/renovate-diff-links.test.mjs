import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { parseDiffSpec } from "../src/lib/package-diff-path";

// The Renovate preset is the one Drydock artifact no test in this repository
// exercises by running it: this repository uses Dependabot, so nothing here ever
// renders the preset. These assertions stand in for that, and they guard three
// things that break adopters silently.
//
// The values copied from Renovate below were read from renovatebot/renovate at
// lib/config/options/index.ts (prBodyColumns default) and
// lib/config/presets/internal/{merge-confidence,security}.preset.ts. The
// template semantics they encode were verified by rendering both definitions
// through Renovate's own compiled `util/template` module.
const PRESET_PATH = "renovate/diff-links.json";

const preset = JSON.parse(
  readFileSync(fileURLToPath(new URL(`../${PRESET_PATH}`, import.meta.url)), "utf8"),
);

const rulesByDatasource = new Map(
  preset.packageRules.map((rule) => [rule.matchDatasources.join(","), rule]),
);

// prBodyColumns is not a mergeable option, so within one upgrade the last
// matching packageRule replaces the list outright. Listing this preset after a
// base preset therefore erases whatever columns that base preset asked for
// unless they are repeated here. Every upstream list that can precede us:
const UPSTREAM_COLUMNS = {
  "renovate defaults": ["Package", "Type", "Update", "Change", "Pending"],
  "mergeConfidence:age-confidence-badges": ["Package", "Change", "Age", "Confidence"],
  "mergeConfidence:all-badges": ["Package", "Change", "Age", "Adoption", "Passing", "Confidence"],
  "security:openssf-scorecard": ["Package", "Type", "Update", "Change", "Pending", "OpenSSF"],
};

// Sample upgrades, one per URL shape the preset has to produce. Field names are
// Renovate template fields; a template that interpolates anything else fails the
// substitution below rather than silently rendering an empty path segment.
const SAMPLES = [
  {
    label: "unscoped npm",
    datasource: "npm",
    fields: { packageName: "lodash", currentVersion: "4.17.20", newVersion: "4.17.21" },
    expected: {
      ecosystem: "npm",
      packageName: "lodash",
      fromVersion: "4.17.20",
      toVersion: "4.17.21",
    },
  },
  {
    label: "scoped npm",
    datasource: "npm",
    fields: { packageName: "@babel/core", currentVersion: "7.24.0", newVersion: "7.25.1" },
    expected: {
      ecosystem: "npm",
      packageName: "@babel/core",
      fromVersion: "7.24.0",
      toVersion: "7.25.1",
    },
  },
  {
    label: "npm build metadata",
    datasource: "npm",
    fields: { packageName: "pkg", currentVersion: "1.0.0+build.1", newVersion: "1.0.1+build.2" },
    expected: {
      ecosystem: "npm",
      packageName: "pkg",
      fromVersion: "1.0.0+build.1",
      toVersion: "1.0.1+build.2",
    },
  },
  {
    label: "pypi project",
    datasource: "pypi",
    fields: { packageName: "requests", currentVersion: "2.31.0", newVersion: "2.32.0" },
    expected: {
      ecosystem: "pypi",
      packageName: "requests",
      fromVersion: "2.31.0",
      toVersion: "2.32.0",
    },
  },
  {
    label: "pypi PEP 440 epoch",
    datasource: "pypi",
    fields: { packageName: "pkg", currentVersion: "1!1.0", newVersion: "1!1.1" },
    expected: {
      ecosystem: "pypi",
      packageName: "pkg",
      fromVersion: "1!1.0",
      toVersion: "1!1.1",
    },
  },
];

function drydockDefinition(datasource) {
  const rule = rulesByDatasource.get(datasource);
  if (!rule) throw new Error(`no packageRule for datasource ${datasource}`);
  return rule.prBodyDefinitions.Drydock;
}

// Renovate compiles the definition with Handlebars; this pulls out just the link
// target and substitutes the triple-stashed fields, which is all the URL shape
// depends on. An unknown field throws rather than substituting empty.
function diffUrl(datasource, fields) {
  const definition = drydockDefinition(datasource);
  const match = /\]\((https:\/\/drydock\.org[^)]*)\)/.exec(definition);
  if (!match) throw new Error(`no drydock.org link in ${definition}`);
  return match[1].replace(/\{\{\{(\w+)\}\}\}/g, (_, field) => {
    if (!(field in fields)) throw new Error(`template interpolates unknown field ${field}`);
    return fields[field];
  });
}

describe("renovate diff-links preset", () => {
  // Renovate resolves `github>JoviDeCroock/drydock//renovate/diff-links` to this
  // path on the default branch. A failed preset resolution is not a soft miss:
  // it raises CONFIG_VALIDATION and stops Renovate processing the adopting
  // repository entirely, so every adopter loses all updates, not just a column.
  // Moving the file already fails this suite at import; the literal below exists
  // so that updating PRESET_PATH to match a move fails too.
  test("stays at the path adopters reference", () => {
    expect(PRESET_PATH).toBe("renovate/diff-links.json");
  });

  // Only the ecosystems /diff serves get a column. Adding one here means adding
  // a URL shape, so the sample list below has to grow with it.
  test("covers exactly the datasources with a diff URL shape", () => {
    expect(preset.packageRules.map((rule) => rule.matchDatasources)).toEqual([["npm"], ["pypi"]]);
    expect(new Set(SAMPLES.map((sample) => sample.datasource))).toEqual(new Set(["npm", "pypi"]));
  });

  test.each(Object.entries(UPSTREAM_COLUMNS))(
    "keeps every column %s asks for",
    (_name, columns) => {
      for (const rule of preset.packageRules) {
        expect(rule.prBodyColumns).toEqual(expect.arrayContaining(columns));
        expect(rule.prBodyColumns).toContain("Drydock");
      }
    },
  );

  test.each(SAMPLES)(
    "$label links a URL the diff router parses",
    ({ datasource, fields, expected }) => {
      const url = new URL(diffUrl(datasource, fields));
      expect(parseDiffSpec(url.pathname)).toEqual(expected);
    },
  );

  // Guards, verified against Renovate's template engine: no link unless the pair
  // is two distinct published versions of one package. `equals` is a Renovate
  // helper, and all four fields are in Renovate's template allowlist.
  test.each(["npm", "pypi"])(
    "%s definition drops the link for non-diffable updates",
    (datasource) => {
      const definition = drydockDefinition(datasource);
      expect(definition).toContain("{{#if currentVersion}}");
      expect(definition).toContain("{{#if newVersion}}");
      expect(definition).toContain("{{#unless newName}}");
      expect(definition).toContain("{{#unless (equals currentVersion newVersion)}}");
      // packageName, not depName: for npm alias specs and normalized PyPI names,
      // depName is what the manifest calls the dependency, which can be a
      // different package than the one actually installed.
      expect(definition).not.toContain("depName");
    },
  );
});
