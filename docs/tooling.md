# Linting and formatting

## Stack

- **[oxlint](https://oxc.rs/docs/guide/usage/linter)** v1 — Rust-based ESLint replacement. Config in `.oxlintrc.json`.
- **[oxfmt](https://oxc.rs/docs/guide/usage/formatter)** v0 — Rust-based Prettier replacement. Config in `.oxfmtrc.json`.
- **[@preact/eslint-plugin-signals](https://github.com/preactjs/signals/blob/main/packages/eslint-plugin-signals/README.md)** — loaded via oxlint's `jsPlugins` (alpha) for signal-specific rules.

## Scripts

| Command                 | What it does                                                                                                                                                                                                      |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm run lint`         | Run oxlint over the repo. Exit non-zero on errors.                                                                                                                                                                |
| `pnpm run lint:fix`     | Apply oxlint autofixes.                                                                                                                                                                                           |
| `pnpm run format`       | Rewrite files with oxfmt.                                                                                                                                                                                         |
| `pnpm run format:check` | Report files that would change without writing.                                                                                                                                                                   |
| `pnpm run test`         | Node logic tests (`test/**`) plus D1-backed worker tests (`test/workers/**`) in one Vitest run via the `node`/`workers` projects (root `vitest.config.ts`), so the fast node suite overlaps the slow worker pool. |
| `pnpm run test:node`    | Just the node logic suite (`vitest run --project node`).                                                                                                                                                          |
| `pnpm run test:workers` | Just the worker suite (`vitest run --project workers`; Miniflare D1 from `wrangler.test.jsonc` + `drizzle/`).                                                                                                     |
| `pnpm run e2e:fixtures` | Pack local E2E fixture packages and generate `.context/e2e-registry/registry.json`.                                                                                                                               |
| `pnpm run e2e:dev`      | Start the fake npm staging registry plus the Vite/Worker dev server for browser testing.                                                                                                                          |
| `pnpm run test:e2e`     | Run Playwright against the local fake-registry harness.                                                                                                                                                           |
| `pnpm run verify`       | Run lint + format check + typecheck + tests **in parallel** (`scripts/verify.mjs`); the cheap checks finish while the worker pool runs. All four always run to completion and every failure is reported together. |

`pnpm lint` (the shorthand without `run`) can collide with workspace forwarding or shell wrappers — always use `pnpm run lint`.

Server-risk changes have a stricter test matrix than the command table alone
can express. See [`release-safety.md`](./release-safety.md) for the expected
Worker-route, sandbox invariant, fake-registry e2e, security-corpus, and
observability coverage by change type.

## Worker-suite performance

The `workers` Vitest project runs every test file in its own Miniflare isolate,
so anything paid per file is paid ~24×. Two deliberate choices keep it fast:

- **`wrangler.test.jsonc` has no `main`.** The worker tests don't use `SELF` —
  they `import worker from "../../server/index"` and call `worker.fetch(req, env, ctx)`
  directly. Setting `main` makes Miniflare eagerly evaluate the whole app graph
  in _every_ isolate at boot (~5s/file → most of the suite's wall time). Leaving
  it unset drops per-file boot to ~0.3s; the files that need the app still import
  it themselves. **Do not add `main` back** unless a test genuinely needs `SELF`
  or a Durable Object binding — and if one does, scope it to a separate project
  rather than taxing all 24 files.
- **Native scrypt for password hashing.** `server/lib/auth.ts` overrides Better
  Auth's KDF with `node:crypto`'s native scrypt (same params, byte-identical
  output — see `test/workers/auth-password-hash.test.ts`). On `workerd` the
  default falls back to a pure-JS scrypt that runs synchronously in the isolate;
  native scrypt is ~10× faster, which matters for production logins and for the
  auth-heavy worker tests that sign up / sign in / enroll TOTP.

Heavy, conditionally-used modules (e.g. the Vercel AI SDK behind the off-by-default
AI reviewer) are loaded with `await import(...)` past their feature gate, to keep
them out of the worker boot graph.

## Pre-commit verification

Run `pnpm run verify` before every commit, so each commit passes lint + format + typecheck + tests. There is no git hook enforcing this — it is run explicitly. CI (`.github/workflows/ci.yml`) runs the same core checks and then installs Chromium and runs `pnpm run test:e2e`.

## Production deploys

`.github/workflows/deploy.yml` deploys the Worker to production. It runs on
every push to `main` and on demand via `workflow_dispatch` (Actions → Deploy →
"Run workflow", or `gh workflow run deploy.yml`). A `deploy-production`
concurrency group serializes runs without cancelling an in-flight deploy, so a
deploy is never killed between applying migrations and uploading the Worker.

Two jobs:

1. **verify** — same setup as CI, runs `pnpm run verify`.
2. **deploy** — `needs: verify` and runs in the `production` GitHub
   Environment, so repo-level environment protection rules (required
   reviewers, branch restrictions) can gate it. Steps, in order:
   1. `pnpm run db:migrate:remote` — applies pending D1 migrations to the
      remote `staged-publish-review` database **before** the new Worker code
      goes live. Worker code must therefore stay backward compatible with a
      schema one migration ahead. This step also deliberately runs before the
      build: `vite build` writes a redirected Wrangler config
      (`.wrangler/deploy/config.json` → `dist/**/wrangler.json`) that later
      wrangler invocations resolve instead of the checked-in `wrangler.jsonc`,
      and migrations need the source config's `migrations_dir: "drizzle"`.
   2. `pnpm run build` — the Cloudflare Vite plugin bundles the Worker and the
      prerendered UI assets into `dist/` and emits the redirected Wrangler
      config. A bare `wrangler deploy` against `wrangler.jsonc` cannot work:
      its `assets` block has no `directory`; only the build output provides
      one.
   3. `pnpm run deploy` — `wrangler deploy`, which picks up the redirected
      config and uploads the built Worker, assets, cron triggers, queue
      consumers, and routes.

### Required repo secrets

Configure these as repository (or `production` environment) secrets before the
first run — the workflow cannot be exercised without them:

- `CLOUDFLARE_API_TOKEN` — minimum permissions:
  - Account → **Workers Scripts: Edit** (upload Worker + assets, crons,
    bindings)
  - Account → **D1: Edit** (apply migrations)
  - Account → **Queues: Edit** (register the `staged-publish-review-scans`
    consumer)
  - Zone `resynapse.dev` → **Workers Routes: Edit** (the
    `drydock.resynapse.dev` custom-domain routes)

  If a deploy fails with a permissions error, Cloudflare's "Edit Cloudflare
  Workers" token template plus D1 Edit and Queues Edit is the known-good
  superset.

- `CLOUDFLARE_ACCOUNT_ID` — the Cloudflare account id. Required in
  non-interactive CI whenever the token can see more than one account.

## Banned hooks

`useState` and `useReducer` are forbidden via oxlint's `no-restricted-imports` from `preact/hooks` (and `react`, defensively). The codebase is migrating component-local state to:

- `@preact/signals` — `useSignal`, `useComputed`, `useSignalEffect`. See the [`preact-signals-preact-integration`](../.claude/skills/preact-signals-preact-integration/SKILL.md) skill.
- `createModel` / `useModel` for cohesive state-plus-actions objects. See the [`preact-signals-models-utils`](../.claude/skills/preact-signals-models-utils/SKILL.md) skill.

Reach for a signal when the state is one value; reach for a model when the state and the writes that touch it form a unit (e.g. `loading + error + items + load()`).

## Signal unboxing model

Treat a signal as a stable box around a value. Passing the signal object through props, context, or a model does not subscribe the current component. Unboxing it with `.value` subscribes the current reactive scope, so unbox as late as correctness allows.

| Context                                               | Result                                                                                              |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Component render reads `signal.value`                 | That component rerenders when the signal changes.                                                   |
| `computed()` / `useComputed()` reads `signal.value`   | The computed tracks the read and recomputes when the signal changes.                                |
| `effect()` / `useSignalEffect()` reads `signal.value` | The effect tracks the read and reruns when the signal changes.                                      |
| JSX text renders `{signal}`                           | Preact binds the signal to the text node and updates it directly without rerendering the component. |
| DOM element prop receives `{signal}`                  | Preact can update the DOM property directly without rerendering the component.                      |
| Component prop or context carries `signal`            | No subscription occurs until a consumer unboxes it or renders it directly.                          |

Prefer passing `Signal<T>` to leaf components, utility components, and context consumers when they need live state. Read `.value` earlier only when the current scope needs to branch, derive a value, run an effect, validate input, or pass a plain snapshot to an API that cannot accept a signal.

## Signal plugin rules

The following rules from `@preact/eslint-plugin-signals` are enforced (see [`preact-signals-eslint-plugin`](../.claude/skills/preact-signals-eslint-plugin/SKILL.md) for intent):

- `no-signal-write-in-computed` (error)
- `no-value-after-await` (error)
- `no-signal-in-component-body` (error)
- `no-conditional-value-read` (error)
- `no-signal-truthiness` (warn)

## Client API helpers

Use `apiFetch` from `src/models/api.ts` for same-origin JSON requests so active organization headers and `ApiError` handling stay consistent. Use `apiJson` for JSON request bodies instead of repeating `content-type` and `JSON.stringify` at call sites. Use `errorMessage(err)` when model actions need to surface caught errors into a signal.

## Server route helpers

Use `rateLimitResponse` from `server/lib/http.ts` for 429 JSON responses so `retryAfterSeconds` and `retry-after` headers stay consistent. Use `errorMessage(err)` from `server/lib/errors.ts` for server-side caught-error stringification instead of repeating local branches; it also preserves `message` from Worker RPC-serialized error objects.

## Related skills

The `.claude/skills/` directory ships the canonical signals/models reference set used by Claude Code during this migration. The same skills are exposed to agents through the `.agents/skills` symlink:

- `preact-signals-core` — core reactivity primitives and the runtime tracking model.
- `preact-signals-preact-integration` — `useSignal`, JSX rendering choices, `Show`/`For`, `useLiveSignal`.
- `preact-signals-models-utils` — `createModel`/`useModel` patterns and state shape.
- `preact-signals-eslint-plugin` — what the rules catch.
- `preact-signals-debugging` — triage map for stale renders, missing updates, SSR issues.
