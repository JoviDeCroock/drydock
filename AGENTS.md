# Repository guidelines

## Layout

- `server/` — Hono Worker. `index.ts` mounts routes under `/api/*`. The worker is the deploy target (`main` in `wrangler.jsonc`).
  - `routes/scan.ts` — `POST /api/v1/scan { stageId }`. Runs the full pipeline.
  - `routes/scans.ts` — `GET /api/v1/scans` (list), `GET /api/v1/scans/:id` (persisted detail).
  - `routes/github-webhooks.ts` — `POST /webhooks/github`. Public, signed by the GitHub App webhook secret; bypasses Better Auth. Persists `deployment_protection_rule` deliveries into `github_workflow_gates` and updates installation status on lifecycle events. See `docs/pypi-workflow-gate.md`.
  - `lib/sandbox.ts` — Dynamic Worker that downloads + parses a tarball; `NpmStageGateway` is the only egress allowed (staged tarball, published tarball, registry metadata).
  - `lib/review.ts` — Deterministic findings, package diff, package.json diff, risk computation. Shared types are imported by both server and UI.
  - `lib/ai-review.ts` — Workers AI JSON-mode reviewer. Wired into `scan-pipeline.ts` via `maybeRunAiReview`, but **gated by the per-organization `ai-review` Flagship flag and off by default** (planned paid-tier feature). It only runs when Flagship returns `true` for the scanning org; otherwise the pipeline records an `unavailable` AI review. Don't change the default-off gating without a feature decision.
  - `lib/registry.ts` — npm metadata fetch + previous-version selection.
  - `lib/auth.ts` — Better Auth instance (D1 + Drizzle). Auth is required for every non-auth `/api/*` endpoint.
  - `db/` — Drizzle schema + persistence helpers (scans, scan_files, scan_findings, better-auth tables).
  - `env.d.ts` — `Cloudflare.Env` bindings. Regenerate with `npm run cf-typegen` if `wrangler.jsonc` changes.
- `src/` — Preact UI served as static assets by the Worker via the assets binding.
  - `index.tsx` — entry, mounts the `preact-iso` router and lazy-loads pages.
  - `pages/` — landing, login/register, dashboard, persisted scan detail.
  - `models/` — fetch wrappers for Better Auth and scan APIs. Scan models re-use types from `server/`.
- `drizzle/` — D1 migrations.
- `test/` — Vitest specs. Pure logic tests live directly under `test/`; Worker-runtime route
  and D1 tests live under `test/workers/`; Playwright + fake-registry e2e tests live under
  `test/e2e/` and `test/e2e-fixtures/`.

## Conventions

- Shared types live in `server/` (`server/types.ts`, `server/lib/review.ts`). UI imports them via relative path so the request/response shape is shared at compile time.
- Trust boundary: package bytes are untrusted evidence. Deterministic findings are authoritative. The AI reviewer is wired in but gated off-by-default behind the per-organization `ai-review` Flagship flag (planned paid-tier feature); when enabled it only sees changed files, treats package contents as hostile evidence, and cannot downgrade deterministic findings.
- The Dynamic Worker has `globalOutbound` set to `NpmStageGateway`. The gateway is the only path through which the npm token is attached (and only for the staged tarball endpoint).
- D1 is required because Better Auth is always required for non-auth API endpoints.
- Styling is Tailwind CSS v4 via `@tailwindcss/vite`. Design tokens (colors, fonts, shadows) are declared in `src/style.css` with `@theme`, light/dark modes overridden via `prefers-color-scheme`. Reach for primitives in `src/components/` (`Button`, `Input`, `Field`, `Badge`, `Alert`, `Card`, `PageShell`, `Eyebrow`, etc.) before writing one-off classes. No CSS-in-JS.
- **Read [`DESIGN.md`](DESIGN.md) before making any visual or UI decision.** It is the source of truth for fonts, colors, spacing, iconography (text glyphs only — no SVG icons), data viz (severity stacked bar only), state patterns, and marketing-surface rules. Do not deviate without explicit user approval. Anti-patterns there are not suggestions — they're prohibitions.
- We use `preact`, `preact-iso`, and `signals`.
- `useState` and `useReducer` are banned (oxlint `no-restricted-imports` enforces it). Component-local state goes through `useSignal`/`useComputed` or `createModel`/`useModel`. See `docs/tooling.md` and the skills under `.claude/skills/preact-signals-*` (also surfaced through the `.agents/skills` symlink).
- Lint with `pnpm run lint` (oxlint) and format with `pnpm run format` (oxfmt). Configs live in `.oxlintrc.json` and `.oxfmtrc.json`.
- Before every commit, run `pnpm run verify` (lint + format check + typecheck + tests). Run `pnpm run test:e2e` as well when changes touch npm registry behavior, staged-publish discovery, scan workflow, credential forwarding, or browser-visible review flows. The pre-commit hook in `.githooks/pre-commit` runs `verify` automatically; `pnpm install` wires `core.hooksPath` for you. Don't bypass it with `--no-verify` unless you have a real reason.
- New functionality needs tests in the same change. Use the narrowest useful layer, then add
  broader coverage when the behavior crosses a trust boundary:
  - `server/routes/*`, auth, organization scoping, rate limits, D1 persistence, queues, and
    scan lifecycle behavior require Worker-route tests in `test/workers/`.
  - Sandbox, archive parser, npm credential forwarding, redaction, and deterministic-rule
    changes require invariant/regression tests. The sandbox must never receive token material,
    and `NpmStageGateway` must remain the only credentialed egress path.
  - npm registry behavior, staged-publish discovery, endpoint drift, or browser-visible scan
    workflow changes require fake-registry e2e coverage in `test/e2e-fixtures/` and
    `test/e2e/local-registry.spec.ts`.
  - Deterministic detection changes require security-corpus fixtures with explicit expected
    rule IDs, severity, and risk. The golden corpus (`test/security-corpus*.test.mjs`) protects
    against regressions; the eval harness (`test/eval/`, `pnpm run eval`) measures detection
    quality (recall, benign FP rate, evasion robustness) over truth-labeled hard cases. Add
    frontier misses to `cases-frontier/` and benign hard-negatives to `cases-benign/`; only
    regression metrics are gated. See `docs/detection-eval.md`.
  - Operational paths should emit structured, secret-redacted observability events through
    `server/lib/observability.ts`; do not log raw errors, tokens, headers, or package contents.
- Never write SQL migrations by hand; use `pnpm db:generate` to create migrations from `server/db/schema.ts`.
- Before you start work read up on `docs/`, when you are done working update `docs/` with relevant information
- WE NEVER USE `preact/compat`

## Scripts

- `npm run dev` — Vite dev server with the Cloudflare plugin running the Worker locally at `http://localhost:5173`.
- `npm run build` — Build the UI bundle into `dist/`.
- `npm run typecheck` — `tsc --noEmit`.
- `npm run lint` / `npm run lint:fix` — oxlint over `src/`, `server/`, `test/`. Use `:fix` to apply autofixes.
- `npm run format` / `npm run format:check` — oxfmt write / check-only.
- `npm run test` — Vitest logic suite plus Worker-runtime tests.
- `npm run e2e:fixtures` — Pack fake-registry fixture packages into `.context/e2e-registry/`.
- `npm run e2e:dev` — Start the fake npm staging registry plus the local Worker dev server.
- `npm run test:e2e` — Run Playwright against the fake-registry harness; required for registry, credential-forwarding, staged-publish, and scan-workflow changes.
- `npm run eval` — Detection eval harness: measures recall, benign false-positive rate, and evasion robustness over the security corpus, and writes a report to `.context/eval/`. Reuses production detection so it can't drift. See `docs/detection-eval.md`.
- `npm run verify` — runs lint, format check, typecheck, and tests in order. CI and the pre-commit hook both call this.
- `npm run db:generate` — Drizzle migration from `server/db/schema.ts`.
