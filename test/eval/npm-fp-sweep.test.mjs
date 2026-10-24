// Network-bound real-package false-positive sweep. Gated off so `pnpm test`
// and `pnpm run verify` stay offline. Run with `pnpm run eval:npm-sweep`.
//
// Optional: NPM_FP_SWEEP_DEPTH (release pairs per package, default 1),
// NPM_FP_SWEEP_PACKAGES (comma-separated names instead of the curated list),
// NPM_FP_SWEEP_CONCURRENCY (default 6), NPM_FP_SWEEP_CACHE (compressed tarball
// cache directory, default .context/npm-fp-sweep/tarballs).
//
// It reports rather than gates: a flagged pair is a triage candidate, and the
// curated list moves with the registry, so a threshold here would fail on a
// maintainer's release rather than on a rule change.

import { describe, expect, test, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {},
}));

const enabled = process.env.NPM_FP_SWEEP === "1";
const depth = Number(process.env.NPM_FP_SWEEP_DEPTH ?? "1");
const concurrency = Number(process.env.NPM_FP_SWEEP_CONCURRENCY ?? "6");

describe.skipIf(!enabled)("npm real-package false-positive sweep", () => {
  test("reviews real release pairs through the production deterministic path", async () => {
    const { loadSweepPackages, runSweep, writeSweepReport, SWEEP_DIR } =
      await import("./npm-fp-sweep-harness.mjs");
    const packages = process.env.NPM_FP_SWEEP_PACKAGES
      ? process.env.NPM_FP_SWEEP_PACKAGES.split(",").map((name) => ({
          name: name.trim(),
          group: "adhoc",
        }))
      : loadSweepPackages();
    const result = await runSweep({
      packages,
      depth,
      concurrency,
      onProgress: (done, total) => {
        if (done % 25 === 0 || done === total) console.log(`[npm-fp-sweep] ${done}/${total}`);
      },
    });
    writeSweepReport(result);
    console.log(
      `[npm-fp-sweep] ${result.pairs} pairs: release>=medium ${result.release.medium}, release>=high ${result.release.high}, artifact>=high ${result.artifact.high}, errors ${result.errors.length} → ${SWEEP_DIR}/report.md`,
    );
    expect(result.pairs).toBeGreaterThan(0);
  }, 3_600_000);
});
