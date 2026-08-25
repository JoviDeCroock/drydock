---
name: drydock-agent-tour
description: Run, inspect, and summarize the portable Drydock local product walkthrough. Use when an agent or developer needs to experience the end-to-end Drydock flow outside Conductor, generate screenshots/traces/report artifacts, validate the fake-registry local review path, or report product feel issues from the staged-publish workbench.
---

# Drydock Agent Tour

## Secrets Needed

None for the default local fake-registry tour. The tour registers a local test user, uses a fake npm registry token, and runs against local D1/Worker state.

## Workflow

1. From the repository root, run `pnpm run agent:tour`.
2. If Playwright reports a missing Chromium/headless-shell executable, run `pnpm exec playwright install chromium` once, then rerun the tour.
3. If a browser needs to stay visible, run `pnpm run agent:tour -- --headed`.
4. If an existing local server should be reused without deleting prior tour artifacts, run `pnpm run agent:tour -- --no-clean`.
5. Read `agent-tour-output/report.md`, unless `AGENT_TOUR_DIR` points elsewhere.
6. Inspect screenshots in `agent-tour-output/screenshots/` and the Playwright trace/video in `agent-tour-output/test-results/`.
7. Check the report's `Browser Events` section even when `Status: passed`; console/page errors can indicate product issues that did not fail the walkthrough.
8. Summarize both correctness and product feel: confusing UI states, missing cues, slow waits, awkward copy, layout issues, unexpected console/network errors, and any security-boundary concerns.

## What The Tour Exercises

The script uses the same fake-registry harness as `pnpm run test:e2e`, but writes agent-readable artifacts instead of only pass/fail output. It walks:

- landing page and docs
- registration
- dashboard before npm setup
- organization npm access setup against the fake registry
- a completed implicit `node-gyp` staged-publish review
- diff workbench filtering and file selection
- risk signals
- JSON report export
- manual block decision
- fail-closed staged tarball failure
- dashboard npm discovery

The tour starts targeted fixture scans through the authenticated scan API so the browser can inspect specific states reliably. UI surfaces that matter for product feel are still driven through Playwright.

## Artifact Contract

Expect these outputs after a run:

- `agent-tour-output/report.md` — primary narrative report
- `agent-tour-output/screenshots/*.png` — ordered screenshots for every major state
- `agent-tour-output/exported-report.json` — downloaded canonical report
- `agent-tour-output/playwright-report/` — HTML report
- `agent-tour-output/test-results/` — traces, videos, and per-test artifacts
- `agent-tour-output/registry-state/requests.jsonl` — fake npm registry journal

Do not treat the tour as a replacement for `pnpm run verify` or `pnpm run test:e2e`. Use it when the task asks what the flow feels like, whether the full local product path is understandable, or when screenshots/traces are useful evidence. For verifying a specific branch's changes rather than the fixed canonical path, use `.claude/skills/verify-live`.
