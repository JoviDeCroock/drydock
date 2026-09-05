---
name: drydock-agent-tour
description: Run or inspect Drydock’s fixed local product walkthrough and its report, screenshots, traces, browser errors, and product-feel evidence.
---

# Canonical Drydock walkthrough

Use the tour to inspect the canonical product path or collect its artifacts. For changes outside that path, use [verify-live](../verify-live/SKILL.md). The default tour needs no real secrets: it uses a local test account, fake npm credentials, and the fake-registry/local D1 harness.

## Run and inspect

Run `pnpm run agent:tour` from the repository root. Choose options for the task:

- `-- --headed` keeps the browser visible.
- `-- --no-clean` preserves existing tour artifacts and allows local server reuse.
- `AGENT_TOUR_DIR` changes the default `agent-tour-output/` destination.
- If Playwright reports missing Chromium, install it with `pnpm exec playwright install chromium` and retry.

If asked to inspect an existing run, read its artifacts first; rerun when freshness or missing evidence requires it. Read `agent-tour-output/report.md`, inspect relevant screenshots and traces, and check **Browser Events** even when the report says passed. A successful assertion set can coexist with console or network errors.

## Coverage and artifacts

The fixed path covers landing/docs, registration, dashboard before setup, fake npm access setup, an implicit `node-gyp` staged review, diff filtering/file selection, risk signals, JSON export, a manual block, a fail-closed tarball error, and discovery. Targeted fixture scans start through the authenticated API; the visible interactions run through Playwright.

Default outputs:

| Artifact | Evidence |
| --- | --- |
| `agent-tour-output/report.md` | Narrative result and browser events |
| `agent-tour-output/screenshots/` | Major UI states |
| `agent-tour-output/exported-report.json` | Canonical report export |
| `agent-tour-output/playwright-report/` | HTML test report |
| `agent-tour-output/test-results/` | Traces, videos, per-test artifacts |
| `agent-tour-output/registry-state/requests.jsonl` | Fake-registry request journal |

Summarize correctness and observed product feel with artifact paths: confusing states, missing cues, slow waits, copy/layout issues, and console/network errors. Distinguish observations from suspected causes and state gaps in coverage. The tour does not replace `pnpm run verify` or required e2e tests. See `docs/agent-tour.md` for the harness contract.
