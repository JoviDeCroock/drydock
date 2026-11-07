# Agent tour

A portable product walkthrough any agent or developer can run from a normal shell (not tied to Conductor). **Authority:** internal. **Owner:** `scripts/agent-tour.mjs` (spec: `test/agent-tour/drydock-agent-tour.spec.ts`).

## Commands

```sh
pnpm run agent:tour
pnpm run agent:tour -- --headed
pnpm run agent:tour -- --no-clean
AGENT_TOUR_DIR=/tmp/drydock-agent-tour pnpm run agent:tour
E2E_APP_PORT=5200 E2E_REGISTRY_PORT=5201 pnpm run agent:tour
```

It reuses the fake-registry harness ([e2e-test-environment.md](./e2e-test-environment.md)) and starts the Worker through Playwright's web server config.

## Artifacts

Under `agent-tour-output/` (or `AGENT_TOUR_DIR`):

| Path | Use |
| --- | --- |
| `report.md` | Main narrative report. |
| `screenshots/` | Ordered screenshots per product state. |
| `exported-report.json` | Report downloaded from the app. |
| `playwright-report/`, `test-results/` | Trace, video, HTML. |
| `registry-state/` | Fake npm registry journal: which endpoints were touched and whether authorization stayed on expected npm-like paths. |

## Scope

`pnpm run test:e2e` remains the regression suite; the tour is for product inspection and does not replace `pnpm run verify`. It walks landing/docs, registration, npm connection, a completed staged-publish review, the diff workbench, risk signals, report export, a manual decision, a fail-closed error state, and dashboard discovery.

Agents discover it through the `drydock-agent-tour` skill in `.claude/skills/` (also `.agents/skills`).
