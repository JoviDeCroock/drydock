# Repository map

Use this map after `AGENTS.md` when a task needs ownership or command details. Read only the linked implementation or documentation layer.

## Server

- `server/index.ts` mounts the Hono Worker routes under `/api/*` and is the deploy target in `wrangler.jsonc`.
- `server/routes/scans/` owns scan HTTP behavior, split by caller intent into `lifecycle`, `decisions`, `sharing`, and `compare` and mounted by its `index.ts`.
- `server/routes/github-webhooks.ts` is the signed GitHub App webhook. It persists `deployment_protection_rule` deliveries into `github_workflow_gates`; see `workflow-gates.md` and the npm, PyPI, and VS Code gate docs.
- `server/lib/sandbox.ts` is the Dynamic Worker that downloads and parses package artifacts. `NpmStageGateway` is the only npm-token egress.
- `server/lib/review/` owns deterministic findings, package and `package.json` diffs, redaction, serialization, risk, and shared UI types. Its public entry is `server/lib/review/index.ts`.
- `server/lib/ai-review/` owns the Workers AI reviewer, wired through `server/lib/scan/pipeline.ts`.
- `server/lib/scan/` owns pipeline phases, queue jobs, input parsing, artifact persistence, report export, and release memory.
- `server/lib/public-diff/` owns anonymous `/diff` orchestration and `PublicDiffAdapter`. The atpm ecosystem resolves releases over AT Protocol; see `atpm-public-diff.md`.
- `server/lib/ecosystems/` contains one directory per ecosystem. `server/lib/ecosystems/index.ts` is the capability registry; ecosystem gate adapters live in `<id>/workflow-gate.ts`. `published-pair.ts` is ecosystem-generic: it turns any `publicDiff` capability into the credential-free `published` scan adapter.
- `server/lib/workflow-gates/` contains only shared GitHub Environment gate plumbing.
- `server/lib/auth/` owns Better Auth, organization ownership, roles, active organization, invitation tokens, and the audit-event allowlist.
- `server/lib/notify/` owns notification fan-out, Slack, and email.
- `server/lib/platform/` contains domain-free HTTP, error, retry, rate-limit, canonical JSON, text, lexer, crypto, secret-box, security-header, observability, guard, path-safety, and concurrency primitives.
- `server/db/` contains the Drizzle schema and persistence helpers. `scans.ts` is a barrel over `scan-jobs`, `scan-persist`, `scan-list`, `scan-detail`, `scan-decisions`, and `scan-risk`.

## UI, migrations, and tests

- `src/index.tsx` mounts `preact-iso`; `src/models/` reuses server types. Shared page behavior belongs in `src/features/`, including shared review UI in `src/features/review/`.
- `drizzle/` contains migrations generated from `server/db/schema.ts`.
- `test/` contains Vitest logic/Worker suites and Playwright fake-registry fixtures.
- Routes, auth, organization scoping, rate limits, D1, queues, and scan lifecycle belong in `test/workers/`.
- Sandbox/archive parsing, npm forwarding, redaction, and deterministic rules use invariant or regression tests.
- Registry behavior, staged discovery, workflow gates, and browser-visible scan flows use `test/e2e-fixtures/` and `test/e2e/local-registry.spec.ts`.

## Commands

The complete script table is in `tooling.md`.

- Iteration: `pnpm run verify:quick`.
- Commit gate: `pnpm run verify`.
- Targeted tests: `pnpm test -- <file> --project node|workers`.
- Browser tests: `pnpm run test:e2e`.
- Local app: `pnpm run dev` at `http://localhost:5173`.
- Seeded local environment: `pnpm run e2e:dev:seed`; see `e2e-test-environment.md`.
- Detection eval: `pnpm run eval`. Paid live AI comparison: `pnpm run eval:ai:live`.
- Migrations: `pnpm db:generate`; never hand-write migration SQL.
