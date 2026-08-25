---
name: verify-live
description: Verify this branch's changes in a running local Drydock instance with a real browser. Use when asked to "verify this change in the app", "check it works live", "see it in the browser", or when a UI/behavior change needs evidence beyond passing tests. Diff-driven and exploratory; for the fixed canonical product walkthrough use drydock-agent-tour instead.
---

# Verify Live

Spin up the seeded local environment, drive a browser at the surfaces this branch changed, and report with screenshots. No credentials — everything runs against the fake registry and isolated local D1 state.

## 1. Start the seeded environment

Run `pnpm run e2e:dev:seed` in the background and wait for the seed summary block. It prints the app URL, a throwaway login email/password, and a completed scan URL (implicit `node-gyp` fixture). Ports come from `CONDUCTOR_PORT` (app) and `CONDUCTOR_PORT + 1` (fake registry), falling back to 5173/5174 — a taken port fails fast rather than auto-picking; set `E2E_APP_PORT`/`E2E_REGISTRY_PORT` if needed. Keep the server running for the whole session and stop it when done.

## 2. Pick targets from the diff

Read `git diff origin/main...HEAD` and list the user-visible surfaces it touches: which pages, which scan states, which API behaviors the UI reflects. Verification means exercising *those*, not a generic smoke pass.

If a target needs a scan state the default seed doesn't cover, seed more fixtures against the running server: `pnpm run e2e:seed -- stage-<scenario>-000001`, with scenarios from `test/e2e-fixtures/scenarios/` (e.g. `stage-secret-file-added-000001`, `stage-registry-failure-000001`). Every `e2e:seed` run signs up a fresh throwaway account, so pass all needed stage ids in one command — two runs put the scans in two different organizations. A change that no existing fixture can reach usually means the branch is missing a scenario — add one; it doubles as the regression test.

State that production fills in via the discovery cron has an on-demand trigger here too: the dashboard's "Check npm" button runs the same sweep against the fake registry. If a surface stays empty after seeding, trigger the flow that populates it before concluding it is broken.

## 3. Drive the browser

Use whatever browser automation the session has (the Conductor `browse` skill, or Playwright via `pnpm exec playwright`). Sign in at `/login` with the printed credentials; the anonymous `/diff` pages need no login. For each target:

- Navigate to it and exercise the changed behavior end to end, not just page load.
- Screenshot the changed state (before/after when an interaction is the change).
- Check the browser console and failed network requests even when the UI looks right — silent errors are findings.

## 4. Canonical-flow changes: also run the tour

If the diff touches the scan lifecycle, diff workbench, npm setup, or dashboard discovery, also run `pnpm run agent:tour` and read `agent-tour-output/report.md` including its Browser Events section. The tour is the fixed baseline for the canonical path; this skill covers what the tour can't know about (see `.claude/skills/drydock-agent-tour`).

## 5. Report with evidence

State what was verified and how, per target, with screenshot paths. Report anything off — bugs, but also product feel: confusing states, missing cues, slow waits, awkward copy. Failures are reported as-is, not worked around.

This skill is evidence that the change works in the real app; it does not replace `pnpm run verify` or `pnpm run test:e2e`.
