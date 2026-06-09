# Repository guidelines

## Layout

- `server/` — Hono Worker. `index.ts` mounts routes under `/api/*`. The Worker is the deploy target (`main` in `wrangler.jsonc`).
  - `routes/scans.ts` — `POST /api/v1/scans { stageId }` (create queued/background scan), `GET /api/v1/scans` (list), `GET /api/v1/scans/:id` (persisted detail).
  - `routes/github-webhooks.ts` — `POST /webhooks/github`. Public, signed by the GitHub App webhook secret; bypasses Better Auth. Persists `deployment_protection_rule` deliveries into `github_workflow_gates` and updates installation status on lifecycle events. See `docs/workflow-gates.md` and `docs/npm-workflow-gate.md` (the gate machinery is ecosystem-neutral; npm vs PyPI is content-detected in `lib/workflow-gates/`).
  - `lib/sandbox.ts` — Dynamic Worker that downloads + parses a tarball; `NpmStageGateway` is the only allowed egress.
  - `lib/review.ts` — Deterministic findings, package diff, package.json diff, risk computation. Types are shared with the UI.
  - `lib/ai-review.ts` — Workers AI reviewer, wired via `scan-pipeline.ts` (`maybeRunAiReview`) but off by default (see trust boundary below).
  - `lib/registry.ts` — npm metadata fetch + previous-version selection.
  - `lib/auth.ts` — Better Auth instance (D1 + Drizzle).
  - `db/` — Drizzle schema + persistence helpers (scans, scan_files, scan_findings, better-auth tables).
  - `env.d.ts` — `Cloudflare.Env` bindings. Regenerate with `pnpm run cf-typegen` after changing `wrangler.jsonc`.
- `src/` — Preact UI served as static assets by the Worker. `index.tsx` mounts the `preact-iso` router and lazy-loads `pages/`; `models/` holds fetch wrappers that re-use `server/` types.
- `drizzle/` — D1 migrations.
- `test/` — Vitest specs. Pure logic tests under `test/`; Worker-runtime + D1 tests under `test/workers/`; Playwright + fake-registry e2e under `test/e2e/` and `test/e2e-fixtures/`.

## Conventions

- **Trust boundary:** package bytes are untrusted evidence; deterministic findings are authoritative. The AI reviewer is gated off-by-default behind the per-organization `ai-review` Flagship flag (planned paid-tier feature). When enabled it only sees changed files, treats contents as hostile, and cannot downgrade deterministic findings. Don't change the default-off gating without a feature decision.
- **Egress:** the Dynamic Worker's `globalOutbound` is `NpmStageGateway` — the only path that attaches the npm token, and only for the staged tarball endpoint. It must remain the only credentialed egress.
- Shared types live in `server/` (`server/types.ts`, `server/lib/review.ts`); the UI imports them by relative path so request/response shapes are shared at compile time.
- D1 / Better Auth are required for every non-auth `/api/*` endpoint.
- **Read [`DESIGN.md`](DESIGN.md) before any visual or UI decision.** It is the source of truth for fonts, colors, spacing, iconography (text glyphs only — no SVG icons), data viz (severity stacked bar only), state patterns, and marketing-surface rules. Its anti-patterns are prohibitions, not suggestions — don't deviate without explicit approval.
- Styling is Tailwind CSS v4 (`@tailwindcss/vite`); tokens live in `src/style.css` under `@theme`, with light/dark via `prefers-color-scheme`. Reach for primitives in `src/components/` (`Button`, `Input`, `Field`, `Badge`, `Alert`, `Card`, `PageShell`, `Eyebrow`, …) before one-off classes. No CSS-in-JS.
- We use `preact`, `preact-iso`, and `@preact/signals`. Never `preact/compat`.
- `useState`/`useReducer` are banned (oxlint `no-restricted-imports`). Component-local state goes through `useSignal`/`useComputed` or `createModel`/`useModel`. See `docs/tooling.md` and the `.claude/skills/preact-signals-*` skills.
- Comments explain _why_ — rationale, trust boundaries, concurrency/fail-closed behavior, edge cases, units, magic numbers. Don't restate what the code already says, narrate obvious control flow, or label a self-evident symbol; never leave commented-out code or stale TODOs. The codebase keeps a deliberately high signal-to-noise ratio.
- Never hand-write SQL migrations — run `pnpm db:generate` against `server/db/schema.ts`.
- Read `docs/` before starting work; update `docs/` when you finish.

## Testing

New functionality needs tests in the same change, at the narrowest useful layer; add broader coverage when behavior crosses a trust boundary:

- `server/routes/*`, auth, org scoping, rate limits, D1 persistence, queues, scan lifecycle → Worker-route tests in `test/workers/`.
- Sandbox, archive parser, npm credential forwarding, redaction, deterministic-rule changes → invariant/regression tests. The sandbox must never receive token material; `NpmStageGateway` must stay the only credentialed egress.
- npm registry behavior, staged-publish discovery, endpoint drift, browser-visible scan flows → fake-registry e2e in `test/e2e-fixtures/` and `test/e2e/local-registry.spec.ts`.
- Deterministic detection changes → security-corpus fixtures with explicit rule IDs, severity, and risk. The golden corpus (`test/security-corpus*.test.mjs`) guards regressions; the eval harness (`test/eval/`, `pnpm run eval`) measures detection quality (recall, benign FP rate, evasion robustness). See `docs/detection-eval.md`.
- Operational paths emit structured, secret-redacted events via `server/lib/observability.ts` — never log raw errors, tokens, headers, or package contents.

## Commands

- `pnpm run verify` — lint + format check + typecheck + tests. Run before every commit (CI runs the same, plus e2e). There is no git hook; run it explicitly.
- `pnpm run dev` — Vite dev server with the Cloudflare plugin (Worker at `http://localhost:5173`).
- `pnpm run lint` / `lint:fix` — oxlint. `pnpm run format` / `format:check` — oxfmt.
- `pnpm run test` — Vitest logic + Worker-runtime suites.
- `pnpm run test:e2e` — Playwright against the fake registry; required for registry, credential-forwarding, staged-publish, and scan-workflow changes. `pnpm run e2e:fixtures` / `e2e:dev` set up the harness.
- `pnpm run eval` — detection eval harness. See `docs/detection-eval.md`.
- `pnpm db:generate` — Drizzle migration from `server/db/schema.ts`.
