# Local E2E test environment

The normal end-to-end loop is local and deterministic. It uses fixture packages plus a tiny fake npm staging registry, so agents and developers can exercise the product without publishing to npm. Keep `packages/experiments` and real npm staged publishes as a final canary for npm endpoint drift, not as the everyday test path.

## What Runs

- `test/e2e-fixtures/scenarios/*` stores package scenarios. Each scenario has a `staged/` package, optional `previous/` package, and `scenario.json` expected outcome.
- `test/e2e/build-fixtures.mjs` runs `npm pack --json` for the previous and staged package directories and writes generated registry state to `.context/e2e-registry/`.
- `test/e2e/fake-registry.mjs` serves only the staged-publish, packument, and tarball endpoints the app uses.
- `test/e2e/dev-server.mjs` starts the fake registry and the Vite/Cloudflare Worker dev server together, after applying D1 migrations to an isolated `.context/e2e/state` persistence path that is reset on each run.
- `test/e2e/local-registry.spec.ts` creates one authenticated browser state, runs the implicit node-gyp fixture through the UI, then runs each remaining fixture as its own Playwright test through the local Worker API. Each scenario asserts its `scenario.json` expected outcome independently, so CI points at the exact fixture that regressed.
- `test/e2e/smoke.spec.ts` is a cheap browser smoke suite with mocked API responses. It covers the workflow-gate scan-detail surface and decision dialog without touching the fake-registry journal, so Playwright can run it across desktop, mobile, and dark-mode projects without multiplying the full scan matrix.

The fake registry writes `.context/e2e-registry/requests.jsonl`. The browser test checks this journal so we can verify authorization headers only appear on expected npm-like endpoints.

Any change to npm staged-publish endpoints, registry metadata handling,
credential forwarding, or browser-visible scan workflow should add or update a
fixture scenario and journal assertion in this harness. See
[`release-safety.md`](./release-safety.md) for the broader test matrix.

## Commands

```sh
pnpm run e2e:fixtures
pnpm run e2e:dev
pnpm run test:e2e
```

`pnpm run e2e:dev` prints the app URL, fake registry URL, request journal, artifact directory, and Worker state directory. By default it uses:

- app: `http://127.0.0.1:5173`
- fake registry: `http://127.0.0.1:5174`

Override ports when needed:

```sh
E2E_APP_PORT=5200 E2E_REGISTRY_PORT=5201 pnpm run test:e2e
```

Playwright artifacts are written under `.context/e2e-artifacts/`, including traces on failure and `implicit-node-gyp-report.png` on a successful smoke run.

Vite ignores `.context/**` in its file watcher. The E2E runner writes registry state, Worker state, traces, screenshots, and reports there while the app is open; watching those files can cause hot-reload loops that interrupt browser interactions in CI.

## CI

The GitHub Actions CI workflow runs `pnpm run test:e2e` after lint, format check, typecheck, and Vitest. CI installs Chromium with:

```sh
pnpm exec playwright install --with-deps chromium
```

The workflow uploads `.context/e2e-artifacts/` and `.context/e2e-registry/requests.jsonl` as `e2e-artifacts` for every run, so failed browser tests keep traces, screenshots, videos, and the fake-registry request journal.

`playwright.config.ts` keeps the expensive scenario coverage in the `chromium`
project (`local-registry.spec.ts` and `two-factor.spec.ts`). The lightweight
`smoke.spec.ts` runs in `desktop-smoke`, `mobile-smoke`, and `dark-smoke`, giving
responsive/theme coverage without rerunning every staged-publish fixture.

## Conductor

`conductor.json` is checked in:

```json
{
  "scripts": {
    "setup": "pnpm install",
    "run": "pnpm e2e:dev"
  },
  "runScriptMode": "concurrent"
}
```

Conductor sets `CONDUCTOR_PORT`; the E2E runner uses that as the app port and `CONDUCTOR_PORT + 1` as the fake registry port. That lets multiple workspaces run the harness concurrently.

## Local HTTP Registry Guard

Production registry URLs still require HTTPS. The E2E runner generates a Wrangler config with `ALLOW_INSECURE_LOCAL_REGISTRY=true`, which permits only loopback HTTP registries (`localhost`, `127.0.0.1`, `::1`). Non-local HTTP registries are still rejected.

This flag exists for local testability only. Do not set it in production Wrangler config.

## Scenario Contract

The scenario matrix is executable instead of duplicated in docs. Add a directory under `test/e2e-fixtures/scenarios/`, define the package inputs, and put the expected risk, rule IDs, baseline, or failure response in `scenario.json`. The Playwright smoke reads the generated `.context/e2e-registry/registry.json` and asserts those expectations automatically.

## Notes

The fake registry is intentionally not a general-purpose npm registry. It only mirrors the staged-publish and packument surface this app consumes. Package code is never executed; fixture packages are packed as tarballs and treated as hostile evidence by the same Dynamic Worker sandbox path as production scans.
