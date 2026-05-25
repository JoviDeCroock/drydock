# Repository guidelines

## Layout

- `server/` — Hono Worker. `index.ts` mounts routes under `/api/*`. The worker is the deploy target (`main` in `wrangler.jsonc`).
  - `routes/scan.ts` — `POST /api/v1/scan { stageId }`. Runs the full pipeline.
  - `routes/scans.ts` — `GET /api/v1/scans` (list), `GET /api/v1/scans/:id` (persisted detail).
  - `lib/sandbox.ts` — Dynamic Worker that downloads + parses a tarball; `NpmStageGateway` is the only egress allowed (staged tarball, published tarball, registry metadata).
  - `lib/review.ts` — Deterministic findings, package diff, package.json diff, risk computation. Shared types are imported by both server and UI.
  - `lib/ai-review.ts` — Workers AI JSON-mode reviewer. Currently **disabled in the pipeline**; kept on disk for a planned paid-tier re-introduction. Do not wire it back into `scan-pipeline.ts` without a feature decision.
  - `lib/registry.ts` — npm metadata fetch + previous-version selection.
  - `lib/auth.ts` — Better Auth instance (D1 + Drizzle). Auth is required for every non-auth `/api/*` endpoint.
  - `db/` — Drizzle schema + persistence helpers (scans, scan_files, scan_findings, better-auth tables).
  - `env.d.ts` — `Cloudflare.Env` bindings. Regenerate with `npm run cf-typegen` if `wrangler.jsonc` changes.
- `src/` — Preact UI served as static assets by the Worker via the assets binding.
  - `index.tsx` — entry, mounts the `preact-iso` router and lazy-loads pages.
  - `pages/` — landing, login/register, dashboard, persisted scan detail.
  - `models/` — fetch wrappers for Better Auth and scan APIs. Scan models re-use types from `server/`.
- `drizzle/` — D1 migrations.
- `test/` — Vitest specs for pure logic (no Worker runtime).

## Conventions

- Shared types live in `server/` (`server/types.ts`, `server/lib/review.ts`). UI imports them via relative path so the request/response shape is shared at compile time.
- Trust boundary: package bytes are untrusted evidence. Deterministic findings are authoritative. The AI reviewer is currently disabled (planned to return as a paid-tier feature); when it returns it will only see changed files, treat package contents as hostile evidence, and cannot downgrade deterministic findings.
- The Dynamic Worker has `globalOutbound` set to `NpmStageGateway`. The gateway is the only path through which the npm token is attached (and only for the staged tarball endpoint).
- D1 is required because Better Auth is always required for non-auth API endpoints.
- Styling is Tailwind CSS v4 via `@tailwindcss/vite`. Design tokens (colors, fonts, shadows) are declared in `src/style.css` with `@theme`, light/dark modes overridden via `prefers-color-scheme`. Reach for primitives in `src/components/` (`Button`, `Input`, `Field`, `Badge`, `Alert`, `Card`, `PageShell`, `Eyebrow`, etc.) before writing one-off classes. No CSS-in-JS.
- **Read [`DESIGN.md`](DESIGN.md) before making any visual or UI decision.** It is the source of truth for fonts, colors, spacing, iconography (text glyphs only — no SVG icons), data viz (severity stacked bar only), state patterns, and marketing-surface rules. Do not deviate without explicit user approval. Anti-patterns there are not suggestions — they're prohibitions.
- We use `preact`, `preact-iso`, and `signals`.
- `useState` and `useReducer` are banned (oxlint `no-restricted-imports` enforces it). Component-local state goes through `useSignal`/`useComputed` or `createModel`/`useModel`. See `docs/tooling.md` and the skills under `.claude/skills/preact-signals-*` (also surfaced through the `.agents/skills` symlink).
- Lint with `pnpm run lint` (oxlint) and format with `pnpm run format` (oxfmt). Configs live in `.oxlintrc.json` and `.oxfmtrc.json`.
- Before every commit, run `pnpm run verify` (lint + format check + typecheck + tests). The pre-commit hook in `.githooks/pre-commit` runs it automatically; `pnpm install` wires `core.hooksPath` for you. Don't bypass it with `--no-verify` unless you have a real reason.
- Never write SQL migrations by hand; use `pnpm db:generate` to create migrations from `server/db/schema.ts`.
- Before you start work read up on `docs/`, when you are done working update `docs/` with relevant information
- WE NEVER USE `preact/compat`

## Scripts

- `npm run dev` — Vite dev server with the Cloudflare plugin running the Worker locally at `http://localhost:5173`.
- `npm run build` — Build the UI bundle into `dist/`.
- `npm run typecheck` — `tsc --noEmit`.
- `npm run lint` / `npm run lint:fix` — oxlint over `src/`, `server/`, `test/`. Use `:fix` to apply autofixes.
- `npm run format` / `npm run format:check` — oxfmt write / check-only.
- `npm run test` — Vitest logic suite.
- `npm run verify` — runs lint, format check, typecheck, and tests in order. CI and the pre-commit hook both call this.
- `npm run db:generate` — Drizzle migration from `server/db/schema.ts`.
