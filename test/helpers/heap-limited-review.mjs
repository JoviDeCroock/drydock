// Run a review scenario in a child process with a capped heap.
//
// A heap delta measured inside the test process depends on whatever earlier
// tests left behind, so it passes or fails by luck. A process with its own
// `--max-old-space-size` fails the same way every time: a rule that retains one
// string per token runs out of memory, and a streaming rule finishes well
// inside the cap. The child loads this module through Vite so
// it can import the TypeScript review sources, then runs one named scenario.

import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  createPackageDiff,
  deterministicFindings,
  tarSuspiciousEntryFindings,
} from "../../server/lib/review";

/**
 * Space-separated distinct tokens, written straight into one buffer so building
 * the input leaves no garbage behind in the capped heap.
 *
 * @param {number} count
 */
export function distinctTokenText(count) {
  const buffer = Buffer.allocUnsafe(count * 8);
  let length = 0;
  for (let index = 0; index < count; index++) {
    length += buffer.write(`t${index.toString(36)} `, length, "latin1");
  }
  return buffer.toString("latin1", 0, length);
}

/**
 * `require(…)` calls whose arguments are distinct tokens, at least `minLength`
 * characters in all.
 *
 * @param {number} minLength
 */
export function loadCallArgumentText(minLength) {
  const buffer = Buffer.allocUnsafe(minLength + 1_024);
  let length = 0;
  for (let index = 0; length < minLength;) {
    length += buffer.write("require(", length, "latin1");
    const start = length;
    while (length - start < 280) {
      length += buffer.write(`t${(index++).toString(36)} `, length, "latin1");
    }
    length += buffer.write(")\n", length, "latin1");
  }
  return buffer.toString("latin1", 0, length);
}

export function neverSampledBundleSeverity(text) {
  const entries = [
    { kind: "retention-tier", path: "<archive>", detail: "1 file body was hash-only" },
  ];
  return tarSuspiciousEntryFindings(entries, {
    fileDiff: [{ path: "dist/app.min.js", status: "modified", flags: ["content-skipped"] }],
    stagedFiles: [
      { path: "dist/app.min.js", flags: ["content-skipped"] },
      { path: "package.json", flags: [], textSample: '{"main":"index.js"}' },
      { path: "index.js", flags: [], textSample: text },
    ],
  })[0].severity;
}

const MANIFEST = JSON.stringify({ main: "index.js", files: ["index.js"] });

export function reviewEntrypoint(text, files = []) {
  const staged = [
    // The `files` list leaves the guide outside it, so the documentation rule
    // scans the code for load calls too.
    { path: "package.json", size: 1, sha256: "p", flags: [], textSample: MANIFEST },
    { path: "index.js", size: text.length, sha256: "i", flags: [], textSample: text },
    { path: "docs/guide.md", size: 1, sha256: "d", flags: [], textSample: "# guide" },
    ...files,
  ];
  return deterministicFindings(staged, createPackageDiff([], staged));
}

const scenarios = {
  neverSampledBundle: () => neverSampledBundleSeverity(distinctTokenText(1_500_000)),
  loadCallArguments: () => reviewEntrypoint(loadCallArgumentText(12_000_000)).length,
};

/**
 * Resolve with the scenario's result, or reject when the child process dies
 * (V8 aborts it once the scenario outgrows `heapMb`).
 *
 * @param {keyof typeof scenarios} scenario
 * @param {number} heapMb
 */
export function runUnderHeapLimit(scenario, heapMb) {
  // A child process rather than a worker thread: an out-of-memory worker can
  // abort the whole test process instead of failing just this test.
  const source = `
    const { runnerImport } = await import("vite");
    const [helper, scenario] = process.argv.slice(1);
    const { module } = await runnerImport(helper, { configFile: false, logLevel: "silent" });
    process.stdout.write(JSON.stringify(module.runScenario(scenario)));
  `;
  const args = [`--max-old-space-size=${heapMb}`, "--input-type=module", "-e", source];
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [...args, fileURLToPath(import.meta.url), scenario],
      {
        cwd: fileURLToPath(new URL("../..", import.meta.url)),
        maxBuffer: 1024 * 1024,
        // A child thrashing just under its cap is killed before the test's
        // own timeout would abandon it.
        timeout: 50_000,
        killSignal: "SIGKILL",
      },
      (error, stdout) => (error ? reject(error) : resolve(JSON.parse(stdout))),
    );
  });
}

/**
 * The child process's entry point, reached through `runnerImport`.
 *
 * @public
 * @param {keyof typeof scenarios} scenario
 */
export function runScenario(scenario) {
  return scenarios[scenario]();
}
