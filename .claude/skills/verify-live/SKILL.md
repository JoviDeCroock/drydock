---
name: verify-live
description: Verify changed Drydock UI or browser-visible behavior against the seeded local fake registry; use drydock-agent-tour for the fixed walkthrough.
---

# Verify changed behavior live

Choose browser targets from the requested behavior and actual branch/working-tree diff: pages, scan states, interactions, and API results visible in the UI. A page load alone does not verify a changed interaction. Use `docs/e2e-test-environment.md` for harness details and `docs/design.md` when evaluating design.

## Local environment

Run `pnpm run e2e:dev:seed` in the background, or reuse a known suitable local harness. The seed summary prints the app URL, throwaway login, and a completed implicit `node-gyp` fixture scan. Use only fake registry credentials and local D1 state. Keep servers available during verification; stop the processes you started when done.

Ports use `CONDUCTOR_PORT` and the next port, falling back to 5173/5174. A conflict fails rather than selecting another port; use `E2E_APP_PORT`/`E2E_REGISTRY_PORT` if needed.

For other scan states, take `stageId` values from `test/e2e-fixtures/scenarios/` and pass all needed IDs to one `pnpm run e2e:seed -- <stageId> ...` command. Each run creates a fresh account/organization, so separate runs cannot populate one account. Add a scenario when a changed workflow needs new regression coverage; use targeted local setup when an existing scenario simply does not represent a UI state.

The dashboard's “Check npm” action triggers the discovery sweep against the fake registry. Exercise the flow that populates a surface before treating an empty state as a defect.

## Browser evidence

Use available browser automation, sign in at `/login` with the seed account, and exercise the target interactions. Anonymous `/diff` pages need no login. Capture changed states and inspect console errors and failed requests even when the UI appears correct. Report observed failures rather than concealing them with a workaround.

For scan lifecycle, diff workbench, npm setup, or dashboard discovery changes, also run the canonical tour via [drydock-agent-tour](../drydock-agent-tour/SKILL.md). Reuse an existing run when it covers the current revision/environment. The tour supplies a fixed baseline; branch-specific interactions may require additional checks.

Report each target, result, screenshot/artifact paths, and any unverified behavior. Include concrete product-feel findings when observed. Browser evidence complements the automated checks required by `docs/release-safety.md`.
