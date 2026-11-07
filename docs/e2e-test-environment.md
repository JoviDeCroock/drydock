# Local e2e test environment

A deterministic local loop: fixture packages, a fake npm staging registry, and the real Worker, with no npm publish and no real credentials. **Authority:** internal (test harness). **Owner:** `test/e2e/dev-server.mjs`.

Real npm staged publishes (`packages/experiments`) are a final canary for npm endpoint drift, not the everyday path.

## Quick start

```sh
pnpm install
pnpm run e2e:dev:seed
```

1. Starts the fake registry and the Vite/Worker dev server, then runs `scripts/e2e-seed.mjs` over the app's own HTTP API.
2. The seed signs up a throwaway account, connects the fake registry, runs the implicit node-gyp fixture through a full scan, and shares the completed review.
3. It prints the login email/password, the scan URL, and the public report URL.
4. The report URL answers `404` until npm's status for the version is read (no public route serves a review before its release is public). The fixture registry reports the implicit node-gyp version `published`, so **Check npm** on the dashboard makes it live.
5. Against an already-running `pnpm run e2e:dev`, run `pnpm run e2e:seed`; pass extra fixture stage ids as arguments (`pnpm run e2e:seed -- stage-benign-diff-000001`).

## Commands

| Command | Ports | State dir | Needs creds? |
| --- | --- | --- | --- |
| `pnpm run e2e:dev:seed` | app `5173`, registry app+1 | `.context/e2e/state` (reset each run), `.context/e2e-registry/` | No |
| `pnpm run e2e:dev` | app `5173`, registry app+1 | same | No |
| `pnpm run e2e:seed` | targets the running app | — | No |
| `pnpm run e2e:fixtures` | — | writes `.context/e2e-registry/registry.json` | No |
| `pnpm run e2e:registry` | registry only, `--port` or `E2E_REGISTRY_PORT` (default `5184` standalone) | `.context/e2e-registry/` | No |
| `pnpm run test:e2e` | starts `e2e:dev` via Playwright `webServer` (reused locally, fresh in CI) | `.context/e2e-artifacts/` | No |
| `pnpm run agent:tour` | same harness | `agent-tour-output/` ([agent-tour.md](./agent-tour.md)) | No |
| `pnpm run dev` | `5173` | your `.dev.vars` | Yes ([self-hosting.md](./self-hosting.md#local-development)) |

`pnpm run e2e:dev` prints the app URL, registry URL, request journal, artifact directory, and Worker state directory.

### Environment variables

| Variable | Effect |
| --- | --- |
| `E2E_APP_PORT` | App port (then `CONDUCTOR_PORT`, then `5173`). Also honored by plain `pnpm run dev` (`vite.config.ts`). |
| `E2E_REGISTRY_PORT` | Registry port (default app port + 1). |
| `CONDUCTOR_PORT` | Parallel workspaces: app = `CONDUCTOR_PORT`, registry = `CONDUCTOR_PORT + 1`. |
| `E2E_APP_URL`, `E2E_NPM_REGISTRY` | Override URLs for seed and Playwright. |
| `E2E_REGISTRY_STATE_DIR`, `E2E_ARTIFACTS_DIR`, `E2E_CONFIG_DIR` | Relocate registry state, artifacts, and generated config + Worker state (parallel harnesses need separate dirs). |
| `E2E_SEED=1` | Same as `--seed` on `test/e2e/dev-server.mjs`. |

Example: `E2E_APP_PORT=5200 E2E_REGISTRY_PORT=5201 pnpm run test:e2e`.

Ports are strict, never auto-picked: `BETTER_AUTH_URL` and the generated Wrangler config bake the app port in before start, so a taken port fails fast; set the env var instead.

## Components

| Piece | File | Role |
| --- | --- | --- |
| Scenarios | `test/e2e-fixtures/scenarios/*` | Each has `staged/`, optional `previous/`, and `scenario.json` (expected risk, rule IDs, baseline, or failure response). |
| Fixture builder | `test/e2e/build-fixtures.mjs` | `npm pack --json` for each side into `.context/e2e-registry/`. `staged.packageJsonText` rewrites the packed `package.json` and repacks with system `tar`. |
| Fake registry | `test/e2e/fake-registry.mjs` | Only the staged-publish, packument, and tarball endpoints the app uses; writes `.context/e2e-registry/requests.jsonl`. Not a general-purpose registry. |
| Dev server | `test/e2e/dev-server.mjs` | Generates a Wrangler config, applies D1 migrations to the isolated state dir, starts registry + Vite/Worker. |
| Worker routes | `test/e2e/worker-routes.mjs` | Prefixes routed to the Worker (see below). |
| Seed | `scripts/e2e-seed.mjs` | Account, connection, scan, share. |
| Playwright config | `playwright.config.ts` | Projects below. |

| Playwright project | Specs |
| --- | --- |
| `chromium` | `test/e2e/local-registry.spec.ts`, `test/e2e/two-factor.spec.ts`, `test/e2e/org-switcher.spec.ts`, `test/e2e/slack-selector.spec.ts`, `test/e2e/npm-scope-guide.spec.ts` |
| `desktop-smoke`, `mobile-smoke`, `dark-smoke` | `test/e2e/smoke.spec.ts`, `test/e2e/publisher-setup.spec.ts` |

1. `local-registry.spec.ts` creates one authenticated state, runs the implicit node-gyp fixture through the UI, then runs each remaining fixture as its own test via the local Worker API; each asserts its own `scenario.json`, so CI names the regressed fixture.
2. `smoke.spec.ts` uses mocked API responses (workflow-gate scan detail and decision dialog, shared public reports, the recovery card after a failed route-chunk load) and never touches the registry journal. Unmocked `/api` calls 404 and the spec asserts no console errors, so a new scan-detail fetch needs a mock.
3. `publisher-setup.spec.ts` mocks GitHub-backed responses: reviewing the workflow before a draft PR, clearing a proposal on repository change, permission recovery, and separating environment configuration from an observed pre-publish review. Worker tests cover the server and GitHub contracts.

## Invariants

1. Fixture tarballs name only the package's own members: the builder packs with `COPYFILE_DISABLE=1` and `--no-xattrs` and fails if any tarball names a packing-host entry (`._*`, `__MACOSX/`, `.DS_Store`). macOS tar otherwise adds AppleDouble `._name` members and pax `xattr` records, and a bare `._package` member is itself a scanner finding.
2. The browser test checks `requests.jsonl` so authorization headers appear only on expected npm-like endpoints.
3. Public packuments and tarballs are served without a token, as public npm serves them; the journal test asserts none is ever sent one.
4. `ALLOW_INSECURE_LOCAL_REGISTRY=true` (generated config only) permits loopback HTTP registries (`localhost`, `127.0.0.1`, `::1`); non-local HTTP is still rejected and production URLs require HTTPS. Never set it in a production Wrangler config.
5. Package code is never executed: fixtures are packed tarballs treated as hostile evidence by the same Dynamic Worker sandbox path as production.
6. The generated config carries a throwaway Ed25519 `ATTESTATION_SIGNING_KEY_JWK`, regenerated on every start and never committed, so report attestations verify locally instead of returning the no-key `503`.
7. Vite ignores `.context/**`; watching harness output causes hot-reload loops that interrupt browser tests.

### Publication-monitor fixtures

| Package | Source | Purpose |
| --- | --- | --- |
| `@drydock/e2e-publication` | `test/e2e-fixtures/publication-monitor/` | One release. |
| `@drydock/e2e-post-release` | `test/e2e-fixtures/post-release-review/` (`1.0.0`, `1.1.0`) | 1.0.0 dated before any watch; 1.1.0 has a real code change. |

1. Written to `registry.json` as `publicPackages`. A version without `publishedAt` gets its publish time on first packument lookup, so it lands after the watch that finds it.
2. With `ALLOW_INSECURE_LOCAL_REGISTRY` on, the monitor and published-pair review read this loopback registry, so an alert's **Scan** runs end to end; it is not public npm, so a decision never reaches the badge.
3. The post-release test runs in its own organization because the suite spends the first organization's hourly scan budget exactly.

### Scenario contract

| Scenario | Expected |
| --- | --- |
| registry-access-failure | Admission rejected with `503`; no scan or package claim created. |
| registry-failure | Access probe passes, full artifact download fails: covers failed-review deletion after verified admission. |
| Cross-organization | A second organization cannot admit the same staged package or create a competing watch. |

The matrix is executable, not duplicated here: add a directory under `test/e2e-fixtures/scenarios/` with `scenario.json`; the suite reads `.context/e2e-registry/registry.json` and asserts it.

## Worker-owned routes locally

| Path | Served by | Note |
| --- | --- | --- |
| `/api/*`, `/webhooks/*`, `/og/*`, `/public/*` | Worker | `test/e2e/worker-routes.mjs` equals `SERVER_OWNED_PATH_PREFIXES` (`server/middleware/canonical-host.ts`); pinned by `test/dev-server-route-parity.test.mjs`. |
| Documents | Vite | Production runs the Worker first (`run_worker_first: true`) and reaches assets via `ASSETS`. |

1. A prefix missing from the list fails silently: Vite's SPA fallback answers `200` with the app shell and the handler never runs.
2. Documents stay on Vite because routing them through the Worker needs the `ASSETS` binding in the generated config and `DISABLE_SECURITY_HEADERS` (the document CSP `style-src-elem 'self'` blocks Vite's injected styles); that flag is all-or-nothing and would drop headers from `/api/*` and `/public/*`. So `assetFallbackRequest`'s `/reports/`, `/diff/`, `/dashboard/` rewrites are covered by `test/workers/`, not here.
3. `/og/*` answers `404` locally by design: it is killswitched whenever `NPM_REGISTRY` is not public npm.

## CI

1. `.github/workflows/ci.yml` runs `pnpm run test:e2e` after lint, format check, typecheck, and Vitest, after `pnpm exec playwright install --with-deps chromium`.
2. Every run uploads `.context/e2e-artifacts/` and `.context/e2e-registry/requests.jsonl` as `e2e-artifacts` (traces, screenshots, videos, journal). Locally, traces land there on failure and `implicit-node-gyp-report.png` on success.
3. Expensive scenarios run only in `chromium`; smoke projects add responsive/theme coverage without rerunning the fixture matrix.

## Change checklist

| If you change | Also |
| --- | --- |
| npm staged-publish endpoints, registry metadata handling, credential forwarding, or a browser-visible scan flow | Add or update a scenario and a journal assertion here; see [release-safety.md](./release-safety.md). |
| `SERVER_OWNED_PATH_PREFIXES` | Update `test/e2e/worker-routes.mjs`. |
| A Cloudflare binding | Add it to the generated config in `test/e2e/dev-server.mjs` (`test/env-binding-parity.test.mjs`). |
