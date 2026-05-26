# Local E2E test environment

The normal end-to-end loop is local and deterministic. It uses fixture packages plus a tiny fake npm staging registry, so agents and developers can exercise the product without publishing to npm. Keep `packages/experiments` and real npm staged publishes as a final canary for npm endpoint drift, not as the everyday test path.

## What Runs

- `test/e2e-fixtures/scenarios/*` stores package scenarios. Each scenario has a `previous/` package, a `staged/` package, and `scenario.json` metadata.
- `test/e2e/build-fixtures.mjs` runs `npm pack --json` for the previous and staged package directories and writes generated registry state to `.context/e2e-registry/`.
- `test/e2e/fake-registry.mjs` serves only the npm endpoints the app uses:
  - `GET /-/whoami`
  - `GET /-/stage?perPage=...`
  - `GET /-/stage/:stageId`
  - `GET /-/stage/:stageId/tarball`
  - `GET /:packageName`
  - `GET /:packageName/-/:tarballName.tgz`
- `test/e2e/dev-server.mjs` starts the fake registry and the Vite/Cloudflare Worker dev server together, after applying D1 migrations to the same local persistence path Vite uses.
- `test/e2e/local-registry.spec.ts` is the browser smoke. It signs up, stores a fake npm token, validates it, submits a staged fixture ID, waits for the report, and asserts the implicit node-gyp finding.

The fake registry writes `.context/e2e-registry/requests.jsonl`. The browser test checks this journal so we can verify authorization headers only appear on expected npm-like endpoints.

## Commands

```sh
pnpm run e2e:fixtures
pnpm run e2e:dev
pnpm run test:e2e
```

`pnpm run e2e:dev` prints the app URL, fake registry URL, request journal, and artifact directory. By default it uses:

- app: `http://127.0.0.1:5173`
- fake registry: `http://127.0.0.1:5174`

Override ports when needed:

```sh
E2E_APP_PORT=5200 E2E_REGISTRY_PORT=5201 pnpm run test:e2e
```

Playwright artifacts are written under `.context/e2e-artifacts/`, including traces on failure and `implicit-node-gyp-report.png` on a successful smoke run.

## CI

The GitHub Actions CI workflow runs `pnpm run test:e2e` after lint, format check, typecheck, and Vitest. CI installs Chromium with:

```sh
pnpm exec playwright install --with-deps chromium
```

The workflow uploads `.context/e2e-artifacts/` and `.context/e2e-registry/requests.jsonl` as `e2e-artifacts` for every run, so failed browser tests keep traces, screenshots, videos, and the fake-registry request journal.

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

## Current Scenarios

- `benign-diff` exercises a harmless changed `index.js` release and expects low release risk.
- `implicit-node-gyp` adds a root `binding.gyp` in the staged package and expects `install-script.implicit-node-gyp` with high release risk.

Good next scenarios:

- added lifecycle script;
- secret-looking file added;
- unparseable `package.json`;
- staged metadata mismatch;
- tag-aware beta baseline;
- no previous published version;
- registry failure/retry path.

## Notes

The fake registry is intentionally not a general-purpose npm registry. It only mirrors the staged-publish and packument surface this app consumes. Package code is never executed; fixture packages are packed as tarballs and treated as hostile evidence by the same Dynamic Worker sandbox path as production scans.
