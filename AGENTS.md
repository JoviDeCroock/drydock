# Repository guidelines

## Layout

- `server/` — Hono Worker. `index.ts` mounts routes under `/api/*`. The Worker is the deploy target (`main` in `wrangler.jsonc`).
  - `routes/scans.ts` — `POST /api/v1/scans { stageId }`, `GET /api/v1/scans`, `GET /api/v1/scans/:id`.
  - `routes/github-webhooks.ts` — public signed GitHub App webhook endpoint. Persists `deployment_protection_rule` deliveries into `github_workflow_gates`; see `docs/workflow-gates.md`, `docs/npm-workflow-gate.md`, `docs/pypi-workflow-gate.md`, and `docs/vscode-workflow-gate.md`.
  - `lib/sandbox.ts` — Dynamic Worker that downloads/parses package artifacts. `NpmStageGateway` is the only npm-token egress.
  - `lib/review/` — deterministic findings (`rules/`), package/package.json diffing, redaction, serialization, risk computation, and shared UI types. `lib/review/index.ts` is the public entry.
  - `lib/ai-review/` — Workers AI reviewer, wired via `lib/scan/pipeline.ts` and on by default behind the `ai-review` Flagship killswitch.
  - `lib/scan/` — scan lifecycle: pipeline and phases, queue job, input parsing, artifact persistence, report export, release memory.
  - `lib/public-diff/` — anonymous `/diff` orchestration and the `PublicDiffAdapter` contract.
  - `lib/ecosystems/` — one directory per ecosystem (npm, PyPI, VS Code) plus `index.ts`, the single registry declaring which release paths each supports (`staged` / `gate` / `publicDiff`). Add an ecosystem by adding a directory and a registry entry — never by branching on the ecosystem name in a route or orchestrator.
  - `lib/workflow-gates/` — shared GitHub Environment gate plumbing only; ecosystem gate adapters live in `lib/ecosystems/<id>/workflow-gate.ts`. When one ecosystem needs extra behavior here, add an optional method to `WorkflowGateAdapter` instead of branching on the ecosystem name.
  - `lib/auth/` — Better Auth wiring, ownership, roles, active organization, invitation tokens, audit-event allowlist.
  - `lib/notify/` — outbound messaging: notification fan-out, Slack, email.
  - `lib/platform/` — domain-free infrastructure: HTTP helpers, errors, fetch retry, JSON canonicalization, text utils, the non-executing JS lexer, crypto, secret box, security headers, observability.
  - `db/` — Drizzle schema and persistence helpers for scans, findings, artifacts, workflow gates, and Better Auth.
- `src/` — Preact UI. `index.tsx` mounts `preact-iso`; `models/` re-use `server/` types; `features/` holds code shared by more than one page (a page must never import from another page's directory).
- `drizzle/` — D1 migrations generated from `server/db/schema.ts`.
- `docs/` — reference docs. Start with `docs/README.md` and read only the relevant layer.
- `test/` — Vitest logic/Worker suites plus Playwright fake-registry e2e fixtures.

## Non-negotiable boundaries

- Package bytes are hostile evidence. Never execute package code, install dependencies, run lifecycle scripts, import modules, run builds, invoke shells, or render package-provided active content.
- npm credentials stay outside the sandbox. Only `NpmStageGateway` may attach npm auth, only for allowed staged/metadata/tarball registry endpoints.
- The AI reviewer is advisory and on by default; the per-organization `ai-review` flag is a killswitch that disables it. It cannot downgrade deterministic findings.
- D1/Better Auth are required for every non-auth `/api/*` endpoint; resource ownership must be organization-scoped. Two anonymous exceptions, both credential-free and IP rate-limited (see `docs/security-model.md`): the `/api/public/v1/package-diff` endpoints, which serve only public-registry and pkg.pr.new preview data; and `/public/reports/*`, where an unguessable share token minted by an owner/admin is the capability and the response is the scan's canonical report export and nothing else.
- Operational logs/events must be structured and secret-redacted. Never log raw tokens, headers, package contents, or unredacted errors.

## UI and frontend conventions

- Read `docs/design.md` before visual or UI decisions. It is the source of truth for fonts, colors, spacing, iconography, data viz, state patterns, and marketing-surface rules.
- Tailwind CSS v4 tokens live in `src/style.css`; prefer primitives in `src/components/` before one-off classes. No CSS-in-JS and no SVG icons.
- Code used by two or more pages belongs in `src/features/`, not in one page's folder. The scan workbench and the anonymous `/diff` page share `src/features/review/`; see `docs/ui.md`.
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
