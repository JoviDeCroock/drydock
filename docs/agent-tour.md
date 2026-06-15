# Agent tour

The agent tour is a portable product walkthrough for Drydock. It is not tied to
Conductor: any agent or developer with the repo checked out can run it from a
normal shell.

```sh
pnpm run agent:tour
```

Useful variants:

```sh
pnpm run agent:tour -- --headed
pnpm run agent:tour -- --no-clean
AGENT_TOUR_DIR=/tmp/drydock-agent-tour pnpm run agent:tour
E2E_APP_PORT=5200 E2E_REGISTRY_PORT=5201 pnpm run agent:tour
```

The tour uses the existing local fake-registry harness, starts the Worker through
Playwright's web server config, and writes inspectable artifacts under
`agent-tour-output/` by default:

- `report.md` — the main narrative report
- `screenshots/` — ordered screenshots for each product state
- `exported-report.json` — the report downloaded from the app
- `playwright-report/` and `test-results/` — trace, video, and HTML artifacts

It also writes the fake npm registry journal under `registry-state/`, so agents
can inspect which registry endpoints were touched and whether authorization
stayed on expected npm-like paths.

## Scope

`pnpm run test:e2e` remains the regression suite. The agent tour is for product
inspection: it walks landing/docs, registration, npm connection, a completed
staged-publish review, diff workbench, risk signals, report export, manual
decision, a fail-closed error state, and dashboard discovery.

Repository agents can discover the workflow through the
`drydock-agent-tour` skill in `.claude/skills/` and the `.agents/skills` symlink.
