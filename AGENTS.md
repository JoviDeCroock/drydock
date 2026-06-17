# Repository guidelines

## Layout

- `server/` — Hono Worker. `index.ts` mounts routes under `/api/*`. The Worker is the deploy target (`main` in `wrangler.jsonc`).
  - `routes/scans.ts` — `POST /api/v1/scans { stageId }`, `GET /api/v1/scans`, `GET /api/v1/scans/:id`.
  - `routes/github-webhooks.ts` — public signed GitHub App webhook endpoint. Persists `deployment_protection_rule` deliveries into `github_workflow_gates`; see `docs/workflow-gates.md`, `docs/npm-workflow-gate.md`, and `docs/pypi-workflow-gate.md`.
  - `lib/sandbox.ts` — Dynamic Worker that downloads/parses package artifacts. `NpmStageGateway` is the only npm-token egress.
  - `lib/review.ts` — deterministic findings, package/package.json diffing, risk computation, and shared UI types.
  - `lib/ai-review.ts` — Workers AI reviewer, wired via `scan-pipeline.ts` and default-off behind the `ai-review` Flagship flag.
  - `lib/adapters/` — ecosystem-specific registry/artifact behavior for npm, PyPI, and workflow gates.
  - `db/` — Drizzle schema and persistence helpers for scans, findings, artifacts, workflow gates, and Better Auth.
- `src/` — Preact UI. `index.tsx` mounts `preact-iso`; `models/` re-use `server/` types.
- `drizzle/` — D1 migrations generated from `server/db/schema.ts`.
- `docs/` — reference docs. Start with `docs/README.md` and read only the relevant layer.
- `test/` — Vitest logic/Worker suites plus Playwright fake-registry e2e fixtures.

## Non-negotiable boundaries

- Package bytes are hostile evidence. Never execute package code, install dependencies, run lifecycle scripts, import modules, run builds, invoke shells, or render package-provided active content.
- npm credentials stay outside the sandbox. Only `NpmStageGateway` may attach npm auth, only for allowed staged/metadata/tarball registry endpoints.
- The AI reviewer is advisory and default-off behind the per-organization `ai-review` flag. It cannot downgrade deterministic findings.
- D1/Better Auth are required for every non-auth `/api/*` endpoint; resource ownership must be organization-scoped.
- Operational logs/events must be structured and secret-redacted. Never log raw tokens, headers, package contents, or unredacted errors.

## UI and frontend conventions

- Read `DESIGN.md` before visual or UI decisions. It is the source of truth for fonts, colors, spacing, iconography, data viz, state patterns, and marketing-surface rules.
- Tailwind CSS v4 tokens live in `src/style.css`; prefer primitives in `src/components/` before one-off classes. No CSS-in-JS and no SVG icons.
- Use `preact`, `preact-iso`, and `@preact/signals`; never `preact/compat`.
- `useState`/`useReducer` are banned. Use `useSignal`, `useComputed`, `createModel`, and `useModel`. See `docs/tooling.md` and `.claude/skills/preact-signals-*`.

## Testing

New functionality needs tests at the narrowest useful layer; add broader coverage when behavior crosses a trust boundary:

- Routes, auth, org scoping, rate limits, D1 persistence, queues, scan lifecycle → `test/workers/`.
- Sandbox/archive parsing/npm credential forwarding/redaction/deterministic rules → invariant or regression tests; the sandbox must never receive token material.
- Registry behavior, staged-publish discovery, workflow gates, browser-visible scan flows → fake-registry e2e in `test/e2e-fixtures/` and `test/e2e/local-registry.spec.ts`.
- Detection changes → security corpus fixtures with explicit rule IDs/severity/risk, plus eval coverage when relevant. See `docs/security-detection-corpus.md` and `docs/detection-eval.md`.

## Commands

- `pnpm run verify` — lint + format check + typecheck + tests; run before every commit when practical.
- `pnpm run dev` — Vite dev server with the Cloudflare plugin (`http://localhost:5173`).
- `pnpm run lint` / `pnpm run lint:fix` — oxlint.
- `pnpm run format` / `pnpm run format:check` — oxfmt.
- `pnpm run typecheck` — TypeScript typecheck.
- `pnpm run test` — Vitest logic + Worker-runtime suites.
- `pnpm run test:e2e` — Playwright fake-registry e2e.
- `pnpm run eval` — detection eval harness.
- `pnpm db:generate` — generate Drizzle migrations; never hand-write SQL migrations.

## Documentation expectations

Use `docs/README.md` to select relevant docs instead of reading all of `docs/`. Before finishing behavior, API, UI, security, workflow, deployment, or operator changes, update the relevant docs or note `docs checked, no update needed` in the PR summary/testing notes.
