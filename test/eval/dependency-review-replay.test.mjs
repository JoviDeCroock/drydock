// Network-bound replay of real Dependabot/Renovate PRs through the dependency
// review stages. Gated off so `pnpm test` and `pnpm run verify` stay offline.
// Run with `pnpm run eval:dependency-review-replay`.
//
// Optional: GITHUB_TOKEN (otherwise unauthenticated, 60 requests an hour; the
// run stops cleanly at the limit and resumes from cache), DEPENDENCY_REVIEW_REPLAY_REPOS
// (comma-separated owner/name instead of the curated list),
// DEPENDENCY_REVIEW_REPLAY_PRS (bot PRs per repository, default 15),
// DEPENDENCY_REVIEW_REPLAY_BUDGET_MIN (minutes before new cold diffs stop,
// default 25). Output: .context/dependency-review-replay/{dataset.json,report.md}.
//
// It reports rather than gates: the sample moves with each repository's PRs.

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {},
}));

const enabled = process.env.DEPENDENCY_REVIEW_REPLAY === "1";
const prsPerRepo = Number(process.env.DEPENDENCY_REVIEW_REPLAY_PRS ?? "15");
const budgetMs = Number(process.env.DEPENDENCY_REVIEW_REPLAY_BUDGET_MIN ?? "25") * 60_000;

describe.skipIf(!enabled)("dependency review replay", () => {
  test("replays real dependency PRs through the production review stages", async () => {
    const { loadReplayRepositories, runReplay, writeReplayReport, REPLAY_DIR } =
      await import("./dependency-review-replay-harness.mjs");
    const repositories = process.env.DEPENDENCY_REVIEW_REPLAY_REPOS
      ? process.env.DEPENDENCY_REVIEW_REPLAY_REPOS.split(",").map((repo) => ({ repo: repo.trim() }))
      : loadReplayRepositories();
    // Vitest holds console output until the test ends; the log file is
    // followable during a long run.
    mkdirSync(REPLAY_DIR, { recursive: true });
    const log = (line) => {
      const stamped = `${new Date().toISOString()} ${line}`;
      appendFileSync(join(REPLAY_DIR, "run.log"), `${stamped}\n`);
      console.log(`[dependency-review-replay] ${stamped}`);
    };
    const dataset = await runReplay({
      repositories,
      prsPerRepo,
      budgetMs,
      token: process.env.GITHUB_TOKEN,
      log,
    });
    const summary = writeReplayReport(dataset);
    const held = Object.entries(summary.variants)
      .map(([name, variant]) => `${name} ${variant.held}/${variant.prs}`)
      .join(", ");
    console.log(
      `[dependency-review-replay] ${summary.complete} PRs, held: ${held} → ${REPLAY_DIR}/report.md`,
    );
    expect(dataset.repositories.length).toBeGreaterThan(0);
  }, 3_600_000);
});
