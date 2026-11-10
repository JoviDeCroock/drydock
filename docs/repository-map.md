# Repository map

Where each behavior lives, which tests pin it, and which doc explains it. Load one row, not the file.

## Server

| Area | Owner | Tests | Doc |
| --- | --- | --- | --- |
| Route mounting, session guard, anonymous-mount order | `server/index.ts` (deploy target in `wrangler.jsonc`; re-exports `scheduled` and `queue`) | `test/api-auth-boundary-invariants.test.mjs` | [`security-model.md`](./security-model.md) |
| Request middleware | `server/middleware/`: security headers, canonical host + static fallback (`SERVER_OWNED_PATH_PREFIXES`), CSRF origin, auth IP rate limit, organization API-key auth (`server/middleware/api-key-auth.ts`, [`api-keys.md`](./api-keys.md)), `c.var.db` | `test/workers/` | [`security-model.md`](./security-model.md) |
| Cron | `server/scheduled.ts`: staged-publish discovery, audit/auth-row/rate-limit pruning | `test/workers/` | [`architecture.md`](./architecture.md#scheduled-discovery) |
| Queue consumer | `server/queue.ts` (`SCAN_QUEUE`: scan, workflow-gate, and dependency-review messages) | `test/workers/` | [`architecture.md`](./architecture.md#scan-pipeline) |
| Rate limits | `server/lib/rate-limit.ts` (`enforceRateLimit`, `guardRateLimit`) over `server/lib/platform/rate-limit.ts` + D1 fallback `server/db/rate-limits.ts` | `test/rate-limit-boundary-invariants.test.mjs` | [`security-model.md`](./security-model.md#rate-limiting) |
| Scan HTTP | `server/routes/scans/` (`lifecycle`, `decisions`, `sharing`, `compare`, mounted by `index.ts`) | `test/workers/` | [`architecture.md`](./architecture.md#scan-pipeline) |
| Scan pipeline | `server/lib/scan/` (phases, queue job, input parsing, `start.ts`, artifacts, export, release memory) | `test/scan-pipeline.test.mjs` | [`architecture.md`](./architecture.md#scan-pipeline), [`artifact-storage.md`](./artifact-storage.md) |
| Sandbox + archive parsing | `server/lib/sandbox.ts`, `server/lib/tar-parser.js`; `NpmStageGateway` is the only npm-token egress | `test/sandbox-boundary-invariants.test.mjs`, `test/tar-parser.test.mjs` | [`sandbox-parser.md`](./sandbox-parser.md) |
| Deterministic review | `server/lib/review/` (rules, diffs, redaction, risk, serialization; entry `index.ts`) | `test/review.test.mjs`, `test/risk.test.mjs`, corpus | [`security-detection-corpus.md`](./security-detection-corpus.md) |
| AI review + Clef screen | `server/lib/ai-review/` (`injection-screen.ts`, `clef.ts`), wired via `server/lib/scan/pipeline.ts` | `test/ai-review-*.test.mjs` | [`ai-review-eval.md`](./ai-review-eval.md) |
| Ecosystems | `server/lib/ecosystems/<id>/`; registry `server/lib/ecosystems/index.ts`; gate adapters `<id>/workflow-gate.ts`; `published-pair.ts` | `test/ecosystem-registry.test.ts`, `test/ecosystem-branching-invariants.test.mjs` | [`architecture.md`](./architecture.md#ecosystems-and-capabilities) |
| Public `/diff` | `server/lib/public-diff/`, `server/routes/public-diff.ts` | `test/workers/` | [`public-diff.md`](./public-diff.md), [`atpm.md`](./atpm.md) |
| Public MCP endpoint (anonymous) | `server/routes/public-mcp.ts` (transport boundary), `server/lib/public-mcp.ts` (tools over the public package-diff router) | `test/workers/` | [`agent-package-review.md`](./agent-package-review.md) |
| `drydock` CLI | `cli/` (dependency-free, over the API-key surface; `cli/README.md`); `cli/src/main.mjs` takes process access as an injected `io`; JSDoc-typechecked by `cli/tsconfig.json` | `test/cli.test.ts` (fake fetch), `test/workers/cli.test.ts` (real Worker) | [`api-keys.md`](./api-keys.md) |
| Workflow gates | `server/lib/workflow-gates/` (shared plumbing only), webhook `server/routes/github-webhooks.ts` → `github_workflow_gates` | `test/workers/`, e2e | [`workflow-gates.md`](./workflow-gates.md) |
| Dependency review | `server/lib/dependency-review/` (webhook parsing, `lockfiles/` and source placement, registry config, pin and mirror proofs, hold policy and age fallback, multi-pass progress, age rechecks, check-run rendering, GitHub calls, queue job, `flag.ts`), `server/db/dependency-reviews.ts`, `server/routes/dependency-reviews.ts`; webhook `pull_request` / `check_run` / `check_suite` → `dependency_reviews` | `test/dependency-review-*.test.ts`, `test/workers/dependency-review-*.test.ts`, `test/e2e/dependency-review.spec.ts` | [`dependency-review.md`](./dependency-review.md), [`dependency-review-sources.md`](./dependency-review-sources.md) |
| Auth, orgs, roles, audit allowlist | `server/lib/auth/` | `test/workers/` | [`organization-members.md`](./organization-members.md), [`audit-log.md`](./audit-log.md) |
| Notifications | `server/lib/notify/` (fan-out, Slack, email) | `test/workers/` | [`slack-notifications.md`](./slack-notifications.md) |
| Domain-free primitives | `server/lib/platform/` (HTTP, errors, retry, rate limit, canonical JSON, text, lexer, crypto, secret box, headers, observability, guards, path safety, concurrency) | unit tests in `test/` | `shared-primitives` skill |
| Persistence | `server/db/` (Drizzle schema + helpers). `scans.ts` is a barrel over `scan-jobs`, `scan-persist`, `scan-list`, `scan-detail`, `scan-decisions`, `scan-registry-status`, `scan-overview`, `scan-package-releases`, `scan-risk`; `scan-share` is imported directly; leaves: `enums.ts`, `scan-status.ts`, `scan-query.ts` | `test/workers/` | [`artifact-storage.md`](./artifact-storage.md) |
| Bindings | `server/env.d.ts` (hand-maintained; not `cf-typegen`) | `test/env-binding-parity.test.mjs` | [`self-hosting.md`](./self-hosting.md) |

## UI, migrations, tests

| Area | Owner | Doc |
| --- | --- | --- |
| App shell | `src/index.tsx` (`preact-iso`); `src/models/` reuses server types | [`ui.md`](./ui.md) |
| Shared page behavior | `src/features/` (review UI in `src/features/review/`) | [`ui.md`](./ui.md), [`design.md`](./design.md) |
| Coding-agent quickstart | `src/pages/Agents/`, `src/features/agent-quickstart/` (setup prompts + project instruction shared with Docs); static `public/llms.txt`, `public/agents/*.md` | [`agent-package-review.md`](./agent-package-review.md) |
| User-facing docs page | `src/pages/Docs/index.tsx` | keep aligned with this folder |
| Migrations | `drizzle/`, generated from `server/db/schema.ts` by `pnpm db:generate`; never hand-written | — |

## Where a new test goes

| Change touches | Test location |
| --- | --- |
| Pure logic (even in `server/`) | `test/*.test.ts` |
| Routes, auth, org scoping, rate limits, D1, queues, scan lifecycle (needs Miniflare) | `test/workers/`; fixtures from `test/workers/helpers/` (`seed.ts`, `app.ts`, `auth-http.ts`, `gate.ts`) |
| Archive/fetch doubles | `test/helpers/` (local copies rejected by `test/test-helper-invariants.test.mjs`) |
| Sandbox parsing, npm forwarding, redaction, deterministic rules | invariant or regression tests in `test/` |
| Registry behavior, staged discovery, workflow gates, browser-visible scan flows | `test/e2e-fixtures/` + `test/e2e/local-registry.spec.ts` |

New tests are `.test.ts`; existing `.test.mjs` files stay. Required layer per change type: [`release-safety.md`](./release-safety.md).

## Commands

Complete script table: [`tooling.md`](./tooling.md).

| Need | Command |
| --- | --- |
| After an edit | `pnpm run verify:file <path...>` |
| While iterating | `pnpm run verify:quick` |
| Before commit | `pnpm run verify` |
| One test file | `pnpm test -- <file> --project node\|workers` |
| Browser tests | `pnpm run test:e2e` |
| Local app (needs `.dev.vars`) | `pnpm run dev` → `http://localhost:5173` |
| Seeded local app, no credentials | `pnpm run e2e:dev:seed` ([`e2e-test-environment.md`](./e2e-test-environment.md)) |
| Detection eval | `pnpm run eval` |
| Paid live AI / Clef evals | `pnpm run eval:ai:live`, `pnpm run eval:clef:live` |
| Migration | `pnpm db:generate` |
