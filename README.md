# Staged Publish Review

Cloudflare-first SaaS for reviewing package release artifacts before a maintainer approves publication. The npm path downloads a staged npm tarball through a sandboxed boundary, selects a tag-aware published baseline, runs deterministic supply-chain checks, optionally asks Cloudflare Workers AI for constrained triage behind a per-organization Flagship gate, and persists a human-readable review report.

The approval step remains outside this product: maintainers approve with `npm stage approve <stage-id>` or npmjs.com, including npm's required 2FA challenge.

## Product direction

This repository is moving from prototype to real product. The current implementation already proves the core sandbox/review flow; the product direction is:

- **SaaS, organization-scoped.** Scans belong to an organization boundary. RBAC is intentionally deferred for the first production slice, but the data model should keep organization ownership explicit.
- **Per-organization npm credentials.** Production SaaS should not use a deployment-wide npm token. Each organization will connect its own npm credential, scoped as narrowly as npm permits, and the credential will only be used by the gateway that talks to npm.
- **Manual publish approval.** The product reviews and explains a staged publish. It does not run `npm stage approve`, does not bypass npm 2FA, and does not become the final publisher.
- **Two operating modes.** npm uses registry-stage mode: Drydock reviews npm-staged bytes before the maintainer approves in npm. Ecosystems without a staged artifact use workflow-gate mode: a GitHub Environment deployment-protection rule blocks the publish job while Drydock reviews the built release artifacts. PyPI is the first workflow-gate ecosystem (built wheel/sdist artifacts); the gate plumbing is ecosystem-neutral. See [`docs/workflow-gates.md`](docs/workflow-gates.md).
- **AI review default-off.** Cloudflare Workers AI review is wired into the pipeline, but it is gated by the per-organization Flagship `ai-review` flag and defaults to unavailable. Deterministic findings are the review authority unless a complete, schema-valid AI review is enabled; AI remains advisory and cannot downgrade deterministic findings.
- **Safe artifact defaults.** Do not retain raw tarballs by default in SaaS. Persist redacted summaries, manifests, diffs, findings, and report metadata. Raw artifact retention may become an explicit short-TTL organization setting later.
- **Signed reports later.** Prepare report data to be canonical and signable, but do not launch public signed report generation yet.

Use the docs by layer:

- [`docs/architecture.md`](docs/architecture.md) — runtime shape, trust boundaries, adapters, APIs.
- [`docs/security-model.md`](docs/security-model.md) — non-negotiable security posture and known gaps.
- [`docs/production-roadmap.md`](docs/production-roadmap.md) — remaining product slices, with closed work collapsed.
- [`docs/workflow-gates.md`](docs/workflow-gates.md) — workflow-gate product mode: ecosystem-neutral GitHub Environment gate contract, with PyPI as the first ecosystem.
- [`docs/release-safety.md`](docs/release-safety.md), [`docs/security-detection-corpus.md`](docs/security-detection-corpus.md), [`docs/detection-eval.md`](docs/detection-eval.md), and [`docs/e2e-test-environment.md`](docs/e2e-test-environment.md) — change safety, detection quality, and local verification.

## Current capabilities

- Every non-auth `/api/*` endpoint requires a Better Auth session backed by Drizzle + Cloudflare D1.
- The Worker exposes authenticated scan APIs and spins up a fresh Dynamic Worker for risky package-download/parsing work.
- The Dynamic Worker fetches staged tarballs through a locked-down gateway; it never receives the npm token.
- Direct sandbox egress is intercepted. Only expected npm registry endpoints are allowed:
  - staged tarball: `https://registry.npmjs.org/-/stage/<stage-id>/tarball`
  - package metadata JSON
  - published `.tgz` tarballs for previous-version diffing
- The sandbox parser can also parse ZIP wheel artifacts for the PyPI workflow-gate path. GitHub App install/callback, deployment-protection webhooks, release-target mapping, queue-driven gate review, and workbench approve/reject controls are implemented; hosted GitHub/PyPI validation and report-level artifact digest persistence remain before broad use.
- The sandbox gunzips/parses tarballs, returns bounded file metadata and text samples, and the parent Worker runs deterministic checks.
- AI triage (Workers AI JSON-mode review of targeted changed-file evidence) is wired but default-off behind the per-organization Flagship `ai-review` flag. When disabled, scans record AI review as unavailable and rely on deterministic findings.
- The service diffs the staged tarball against a tag-aware baseline when package metadata is available. See [`docs/diff-baseline.md`](docs/diff-baseline.md) for the registry metadata constraints and comparison strategy.
- Package files are treated as hostile evidence even with AI disabled — file previews are escaped/redacted before persistence, and the planned AI reviewer will not downgrade deterministic findings when it returns.
- Review results are persisted in Cloudflare D1 through Drizzle ORM.
- Persisted scans are scoped to the authenticated user's personal organization, and scan completion/view actions are recorded as audit events.
- `/`, `/login`, `/register`, `/dashboard`, and `/dashboard/scans/:id` are routed with `preact-iso` and lazy-loaded page modules.

## npm staged publishing boundary

Cloudflare Workers/Dynamic Workers cannot spawn a shell or run the literal `npm stage download` CLI command. This product uses the same staged-tarball download boundary from inside the Dynamic Worker via `fetch()`, behind an egress gateway that injects npm auth outside the sandbox.

npm staged publishing has an explicit manual approval step:

- `npm stage publish` submits a package to staging and can be used from CI/trusted publishing flows.
- `npm stage download <stage-id>` lets maintainers inspect the staged tarball.
- `npm stage approve <stage-id>` publishes the staged package and requires 2FA.
- Trusted publishing/OIDC supports publishing and staged publishing, but npm's interactive stage review/approve operations still require maintainer authentication/proof of presence.

That makes this product a review workbench, not an approval bot.

## Layout

```text
server/        Hono worker (deploy target — main in wrangler.jsonc)
  index.ts     Mounts /api/* routes, applies security headers, requires Better Auth for non-auth API routes
  routes/      scan.ts (POST), scans.ts (list + detail)
  lib/         sandbox, review (rules + diff), ai-review, registry, auth
  db/          Drizzle schema + persistence helpers
src/           Preact UI served as static assets by the worker
  index.tsx    preact-iso router with lazy-loaded pages
  pages/       Landing, Auth login/register, Dashboard, persisted scan detail
  models/      Fetch wrappers that talk to /api/* (re-use server types)
drizzle/       D1 migrations generated from server/db/schema.ts
docs/          Architecture, security, roadmap, and UI implementation notes
test/          Vitest specs for pure logic
packages/      Publishable test packages, including @pracht/experiments
```

## Develop

```sh
pnpm install
cp .dev.vars.example .dev.vars
# edit .dev.vars with local secrets
pnpm test         # Vitest logic suite
pnpm dev          # vite + cloudflare plugin, http://localhost:5173
pnpm test:e2e     # Playwright + local fake npm staging registry
```

The Vite dev server runs the Worker locally and serves the UI at the same origin, so authenticated `fetch("/api/v1/scans")` works without CORS.

For deterministic browser testing without real npm staged publishes, use the local E2E harness in [`docs/e2e-test-environment.md`](docs/e2e-test-environment.md). It packs fixture packages, runs a fake npm staging registry, starts the Worker locally, and writes inspectable screenshots/traces/journals under `.context/`.

## Configuration and secrets

Local Worker secrets live in `.dev.vars` (copy from `.dev.vars.example`). Do not commit `.dev.vars`. Production secrets should be set with `pnpm wrangler secret put <NAME>`.

Current implementation secrets:

| Name                             | Required? | Purpose                                                                                                                                                 |
| -------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET`             | Yes       | Better Auth signing/encryption secret for sessions and cookies. Use one unique high-entropy value per environment. Without this, API auth fails closed. |
| `NPM_CONNECTIONS_ENCRYPTION_KEY` | Yes       | Dedicated secret key material used to encrypt per-organization npm connection tokens. Do not reuse `BETTER_AUTH_SECRET`.                                |

Worker non-secret vars and bindings:

| Name                 | Where                                           | Purpose                                                                                                                      |
| -------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `BETTER_AUTH_URL`    | `.dev.vars` locally; Wrangler var in production | Canonical app origin for Better Auth, for example `http://localhost:5173` locally or your deployed Worker URL. Not a secret. |
| `NPM_REGISTRY`       | `wrangler.jsonc` `vars`                         | npm registry base URL. Defaults to `https://registry.npmjs.org`.                                                             |
| `AI_CACHE_AFFINITY`  | `wrangler.jsonc` `vars`                         | Stable `x-session-affinity` value for Cloudflare Workers AI prefix caching.                                                  |
| `AI`, `LOADER`, `DB` | `wrangler.jsonc` bindings                       | Cloudflare Workers AI, Dynamic Worker loader, and required D1 database binding.                                              |
| `SCAN_QUEUE`         | `wrangler.jsonc` Queue binding                  | Optional in local dev; production async scan queue. Configure retry/DLQ policy before private beta.                          |
| `COMPARE_CACHE`      | `wrangler.jsonc` KV binding                     | Cache for parsed published package versions used by alternate-version compare views.                                         |

Generate the Better Auth secret with either command:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
# or
openssl rand -base64 32
```

Keep the value stable within an environment; rotating it invalidates existing auth sessions unless you implement Better Auth secret rotation.

## API

All endpoints below require an authenticated Better Auth session. Use the UI or Better Auth endpoints under `/api/auth/*` to sign in first.

Current scan API:

```sh
# Create a queued/background scan and return immediately with a scan ID
curl -X POST http://localhost:5173/api/v1/scans \
  -H 'content-type: application/json' \
  -d '{"stageId":"<stage-id>"}'

# List persisted scans
curl http://localhost:5173/api/v1/scans

# Read status/report detail for a persisted scan
curl http://localhost:5173/api/v1/scans/<scan-id>

# Export a completed scan's report as canonical, stable-ordered JSON (download)
curl http://localhost:5173/api/v1/scans/<scan-id>/report.json

# List published versions that can be compared against the staged release
curl http://localhost:5173/api/v1/scans/<scan-id>/versions

# Compare the staged release to another published version
curl 'http://localhost:5173/api/v1/scans/<scan-id>/compare?version=<version>'

# Fetch one prior-version file sample for the diff workbench
curl 'http://localhost:5173/api/v1/scans/<scan-id>/compare/file?version=<version>&path=<path>'
```

`POST /api/v1/scans` uses Cloudflare Queues when `SCAN_QUEUE` is bound. In local environments without the queue binding it schedules the same job with `executionCtx.waitUntil()` and stores `pending`/`running`/`complete`/`failed` status in D1.

Implemented npm connection API:

```sh
# Read public metadata for the current organization's npm connection
curl http://localhost:5173/api/v1/npm-connection

# Store or rotate the current organization's encrypted npm connection
curl -X POST http://localhost:5173/api/v1/npm-connection \
  -H 'content-type: application/json' \
  -d '{"token":"npm_...","label":"maintainer token","registryUrl":"https://registry.npmjs.org"}'

# Validate the stored credential with npm's registry auth endpoint
curl -X POST http://localhost:5173/api/v1/npm-connection/validate

# Optionally also validate staged-tarball access for a real stage ID
curl -X POST http://localhost:5173/api/v1/npm-connection/validate \
  -H 'content-type: application/json' \
  -d '{"stageId":"<stage-id>"}'

# Remove the stored connection
curl -X DELETE http://localhost:5173/api/v1/npm-connection
```

Credential validation checks registry auth, staged-list access, and — when a caller supplies a real stage ID — staged-view plus ranged staged-tarball access. A read-only granular npm token reaches the currently required staged endpoints, so broader token scope is not required by the current implementation.

Scan response/report data includes:

- `id`, package name, staged version, previous version
- `fileCount` and `previousFileCount`
- `packageJsonDiff`
- file-level `diff`
- deterministic `ruleFindings`
- combined `risk` (deterministic-only while AI review is disabled)
- safety posture metadata

## Database

Schema is defined in `server/db/schema.ts`. SQL migrations live in `drizzle/` and should be generated with Drizzle Kit. Scans are owned by an organization/user boundary (`organizations`, `organization_members`, `scans.organization_id`, `scans.owner_user_id`), audit events are stored in `scan_events`, npm credentials in `npm_connections`, and lightweight abuse buckets in `rate_limits`.

```sh
pnpm db:generate
```

Create D1 database and apply migrations:

```sh
pnpm wrangler d1 create staged-publish-review
# copy the real database_id into wrangler.jsonc
pnpm db:migrate:remote
```

Never write SQL migrations by hand; update `server/db/schema.ts` and generate migrations with Drizzle Kit.

## Deploy notes

1. Use Node `22.14.0+` locally for Wrangler parity with npm staged publishing tooling.
2. Install dependencies and configure secrets/production config:

   ```sh
   pnpm install
   pnpm wrangler secret put BETTER_AUTH_SECRET
   pnpm wrangler secret put NPM_CONNECTIONS_ENCRYPTION_KEY
   ```

3. Create production resources and replace placeholder IDs in `wrangler.jsonc`:
   - D1 database: `pnpm wrangler d1 create staged-publish-review`
   - Scan queue: `pnpm wrangler queues create staged-publish-review-scans`
   - Scan dead-letter queue: `pnpm wrangler queues create staged-publish-review-scans-dlq`
   - Compare cache KV namespace: `pnpm wrangler kv namespace create COMPARE_CACHE`
   - Keep the Queue consumer `max_retries` / `dead_letter_queue` settings in `wrangler.jsonc` aligned with `MAX_SCAN_JOB_ATTEMPTS` in `server/lib/scan-job.ts`.
4. Set the real D1 `database_id`, KV namespace `id`, and production `BETTER_AUTH_URL`, then apply migrations.
5. Build + deploy:

   ```sh
   pnpm build
   pnpm deploy
   ```

## Security posture summary

Defended today:

- Unauthenticated access to all non-auth API endpoints.
- Package parser trying direct Internet egress from the sandbox.
- NPM token exposure to sandbox code.
- Huge packages overwhelming review surfaces; file samples are bounded.
- Risky changes hiding in large package output; the file diff and package metadata diff are first-class review objects.
- Cross-user scan reads through personal-organization scoping.
- Basic D1-backed rate limits for scan creation and npm credential save/validation.

Product requirements before SaaS launch:

- Production verification of async scan retry and dead-letter behavior.
- Durable report rendering from persisted data.
- Expanded abuse controls and operator metrics.
- Safer artifact storage in R2 for derived/redacted artifacts.
- Clear token validation and rotation flows.
- More complete audit events.

Not defended/implemented yet:

- Literal `npm stage download` CLI execution inside Workers; Workers cannot spawn CLI processes.
- Production-grade team RBAC.
- Public signed reports.
- Perfect malware detection. This is triage, not a proof of safety.
- Deep binary/native analysis. Large/binary/native files are flagged for manual review.
- Raw tarball evidence retention. This is intentionally not a default SaaS behavior.
