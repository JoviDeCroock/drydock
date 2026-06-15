---
name: drydock-agent-tour
description: Run, inspect, and summarize the portable Drydock local product walkthrough. Use when an agent or developer needs to experience the end-to-end Drydock flow outside Conductor, generate screenshots/traces/report artifacts, validate the fake-registry local review path, or report product feel issues from the staged-publish workbench.
---

# Drydock Agent Tour

## Workflow

1. From the repository root, run `pnpm run agent:tour`.
2. If a browser needs to stay visible, run `pnpm run agent:tour -- --headed`.
3. If an existing local server should be reused without deleting prior tour artifacts, run `pnpm run agent:tour -- --no-clean`.
4. Read `agent-tour-output/report.md`, unless `AGENT_TOUR_DIR` points elsewhere.
5. Inspect screenshots in `agent-tour-output/screenshots/` and the Playwright trace/video in `agent-tour-output/test-results/`.
6. Summarize both correctness and product feel: confusing UI states, missing cues, slow waits, awkward copy, layout issues, unexpected console/network errors, and any security-boundary concerns.

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

Do not treat the tour as a replacement for `pnpm run verify` or `pnpm run test:e2e`. Use it when the task asks what the flow feels like, whether the full local product path is understandable, or when screenshots/traces are useful evidence.
