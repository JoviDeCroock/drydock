// @ts-nocheck
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const SERVER_DIR = fileURLToPath(new URL("../server", import.meta.url));

function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (/\.(ts|js)$/.test(entry) && !entry.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

function relative(file) {
  return path.relative(SERVER_DIR, file).replaceAll(path.sep, "/");
}

// Files allowed to *originate* a per-file text-sample cap. Everything else may
// only forward a cap it was handed, which is plumbing rather than policy.
//
// Every entry here parses something that is NOT the reviewed release: the
// previous-version baselines, and the artifacts of dependencies a release newly
// introduces. Capping those trades a bounded amount of detection depth on
// third-party bytes for memory the reviewed side needs. Adding the staged
// download, the workflow-gate inline parse, or either side of the public diff
// has to change this list — and should not.
const CAPPED_ACQUISITION_FILES = [
  "lib/ecosystems/npm/acquire.ts",
  // Dependency artifacts: several may be fetched for one release, none of their
  // bodies are persisted or rendered, and the cap is 8x the display sample.
  "lib/ecosystems/npm/dependency-artifacts.ts",
  "lib/ecosystems/pypi/acquire.ts",
  "lib/ecosystems/vscode/index.ts",
];

const ASSIGNMENT = /maxTextSampleChars:\s*([^,}]+)/;
const FORWARDED = /^(?:options|opts|retention)\??\.maxTextSampleChars$/;

function capSetters() {
  const setters = new Set();
  for (const file of sourceFiles(SERVER_DIR)) {
    const source = readFileSync(file, "utf8");
    if (!source.includes("maxTextSampleChars")) continue;
    for (const line of source.split("\n")) {
      const match = ASSIGNMENT.exec(line);
      if (!match) continue;
      if (FORWARDED.test(match[1].trim())) continue;
      setters.add(relative(file));
    }
  }
  return [...setters].sort();
}

// Region of a file between two markers, so an assertion can name one method
// instead of a whole module.
function region(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  expect(start, `expected to find ${startMarker}`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(endMarker, start);
  expect(end, `expected to find ${endMarker} after ${startMarker}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("sandbox text-sample retention invariants", () => {
  // The reviewed (staged/gated) side is scanned whole in the parent worker, so
  // capping its parse is a detection hole, not an optimization (issue #191).
  // The option is reachable from anywhere that talks to the sandbox, so pin
  // *who may set one*: adding it to the staged download, the workflow-gate
  // inline parse, or either side of the public diff has to change this list.
  test("only baseline and dependency acquisitions set a text-sample cap", () => {
    expect(capSetters()).toEqual([...CAPPED_ACQUISITION_FILES].sort());
  });

  test("dependency review rejects every clipped text sample before assessment", () => {
    const source = readFileSync(
      path.join(SERVER_DIR, "lib/ecosystems/npm/dependency-artifacts.ts"),
      "utf8",
    );
    const inspection = region(source, "async function inspectOne(", "/**\n * Which version");
    expect(inspection).toContain('file.flags.includes("baseline-truncated")');
    expect(inspection).toContain('file.flags.includes("content-skipped")');
    expect(inspection.indexOf('file.flags.includes("baseline-truncated")')).toBeLessThan(
      inspection.indexOf("assessDependencyArtifact("),
    );
    expect(inspection.indexOf('file.flags.includes("content-skipped")')).toBeLessThan(
      inspection.indexOf("assessDependencyArtifact("),
    );
    expect(inspection).toContain('"artifact-truncated"');
  });

  test("the staged npm download is parsed without a cap in both broker impls", () => {
    const source = readFileSync(path.join(SERVER_DIR, "lib/ecosystems/npm/broker.ts"), "utf8");

    // NpmAdapterBroker (the deployed WorkerEntrypoint) and LocalNpmBroker each
    // declare downloadStaged immediately before downloadPublished.
    const stagedRegions = [
      region(source, "async downloadStaged(stageId: string", "async downloadPublished("),
      region(
        source.slice(source.indexOf("class LocalNpmBroker")),
        "async downloadStaged(stageId: string",
        "async downloadPublished(",
      ),
    ];
    expect(stagedRegions).toHaveLength(2);
    for (const staged of stagedRegions) {
      expect(staged).toContain("downloadInSandbox(");
      expect(staged, "the staged parse must never carry a text-sample cap").not.toContain(
        "maxTextSampleChars",
      );
    }
  });

  test("the workflow-gate and public-diff parses are called without a cap", () => {
    const cases = [
      // Workflow-gate artifacts: bytes GitHub Actions built, under review.
      ["lib/workflow-gates/resolve.ts", /downloadInSandboxInline\(/],
      // Public diff: the newer side is run through the deterministic rules, and
      // the older side is what it is diffed against.
      ["lib/ecosystems/npm/public-diff.ts", /downloadPublishedTarball\(|downloadPkgPrNewTarball\(/],
      ["lib/ecosystems/pypi/public-diff.ts", /downloadInSandbox\(/],
    ];

    for (const [file, callPattern] of cases) {
      const source = readFileSync(path.join(SERVER_DIR, file), "utf8");
      expect(source, `${file} should still make the call this test pins`).toMatch(callPattern);
      expect(source, `${file} must not cap the reviewed side's text samples`).not.toContain(
        "maxTextSampleChars",
      );
    }
  });

  test("the persisted display clip stays below the baseline wire cap", async () => {
    const { BASELINE_TEXT_SAMPLE_LIMIT, SCAN_FILE_SAMPLE_LIMIT } =
      await import("../server/lib/sample-retention");
    // A baseline sample smaller than what the UI displays would shorten the
    // baseline side of a rendered diff for reasons no reader could see.
    expect(BASELINE_TEXT_SAMPLE_LIMIT).toBeGreaterThan(SCAN_FILE_SAMPLE_LIMIT);
  });
});
