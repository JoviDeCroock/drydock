# Staged publish sandbox prototype

Cloudflare Worker + Preact UI prototype for reviewing an npm staged publish before approval. The Hono worker is co-located with the UI and bundled by Vite + the Cloudflare plugin.

## What this proves

- Every non-auth `/api/*` endpoint requires a Better Auth session backed by Drizzle + Cloudflare D1.
- The Worker exposes authenticated `POST /api/v1/scan { stageId }` and spins up a fresh Dynamic Worker for the risky package-download/parsing step.
- The Dynamic Worker fetches the staged tarball through a locked-down gateway; it never receives the npm token.
- Direct sandbox egress is intercepted. Only expected npm registry endpoints are allowed:
  - staged tarball: `https://registry.npmjs.org/-/stage/<stage-id>/tarball`
  - package metadata JSON
  - published `.tgz` tarballs for previous-version diffing
- The sandbox gunzips/parses tarballs, returns bounded file metadata and text samples, and the parent Worker runs deterministic checks plus Workers AI JSON-mode review.
- Kimi K2.5 (`@cf/moonshotai/kimi-k2.5`) performs AI triage with a static prompt-injection-resistant system prompt and Cloudflare Workers AI prefix caching via `x-session-affinity`.
- The service diffs the staged tarball against the currently published previous version when package metadata is available.
- Package files are treated as hostile evidence. The AI prompt explicitly ignores file-contained instructions, output is schema constrained, and AI risk cannot downgrade deterministic findings.
- Review results are persisted in Cloudflare D1 through Drizzle ORM.
- `/`, `/login`, `/register`, `/dashboard`, and `/dashboard/scans/:id` are routed with `preact-iso` and lazy-loaded page modules.

## Important constraint

Cloudflare Workers/Dynamic Workers cannot spawn a shell or run the literal `npm stage download` CLI command. This prototype uses the same staged-tarball download boundary from inside the Dynamic Worker via `fetch()`, behind an egress gateway that injects npm auth outside the sandbox.

If we need to test the literal CLI command, that belongs in a separate container/VM runner. For Cloudflare, this fetch-based shape is safer and closer to the runtime we can actually deploy.

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
test/          node --test for pure logic
```

## Develop

```sh
pnpm install
cp .dev.vars.example .dev.vars
# edit .dev.vars with local secrets
pnpm dev          # vite + cloudflare plugin, http://localhost:5173
```

The Vite dev server runs the Worker locally and serves the UI at the same origin, so authenticated `fetch("/api/v1/scan")` works without CORS.

## Configuration and secrets

Local Worker secrets live in `.dev.vars` (copy from `.dev.vars.example`). Do not commit `.dev.vars`. Production secrets should be set with `pnpm wrangler secret put <NAME>`.

Worker secrets:

| Name | Required? | Purpose |
| --- | --- | --- |
| `BETTER_AUTH_SECRET` | Yes | Better Auth signing/encryption secret for sessions and cookies. Use one unique high-entropy value per environment. Without this, API auth fails closed. |
| `NPM_TOKEN` | Required for authenticated staged-publish downloads | npm registry token attached only by `NpmStageGateway` when fetching `/-/stage/<stage-id>/tarball`; it is not passed into the sandbox worker. |

Worker non-secret vars and bindings:

| Name | Where | Purpose |
| --- | --- | --- |
| `BETTER_AUTH_URL` | `.dev.vars` locally; Wrangler var in production | Canonical app origin for Better Auth, for example `http://localhost:5173` locally or your deployed Worker URL. Not a secret. |
| `NPM_REGISTRY` | `wrangler.jsonc` `vars` | npm registry base URL. Defaults to `https://registry.npmjs.org`. |
| `AI_MODEL` | `wrangler.jsonc` `vars` | Workers AI model ID. Defaults to `@cf/moonshotai/kimi-k2.5`. |
| `AI_CACHE_AFFINITY` | `wrangler.jsonc` `vars` | Stable `x-session-affinity` value for Cloudflare Workers AI prefix caching. |
| `AI`, `LOADER`, `DB` | `wrangler.jsonc` bindings | Cloudflare Workers AI, Dynamic Worker loader, and required D1 database binding. |

Generate the Better Auth secret with either command:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
# or
openssl rand -base64 32
```

Keep the value stable within an environment; rotating it invalidates existing auth sessions unless you implement Better Auth secret rotation.

## API

All endpoints below require an authenticated Better Auth session. Use the UI or Better Auth endpoints under `/api/auth/*` to sign in first.

```sh
# Run a scan
curl -X POST http://localhost:5173/api/v1/scan \
  -H 'content-type: application/json' \
  -d '{"stageId":"<stage-id>"}'

# List persisted scans
curl http://localhost:5173/api/v1/scans

# Read a persisted scan
curl http://localhost:5173/api/v1/scans/<scan-id>
```

Response includes:

- `id`, package name, staged version, previous version
- `fileCount` and `previousFileCount`
- `packageJsonDiff`
- file-level `diff`
- deterministic `ruleFindings`
- Kimi K2.5 `aiFindings`
- combined `risk`
- safety posture metadata

## Database

Schema is defined in `server/db/schema.ts`. SQL migrations live in `drizzle/` and should be generated with Drizzle Kit:

```sh
pnpm db:generate
```

Create D1 database and apply migrations:

```sh
pnpm wrangler d1 create staged-publish-review
# copy the real database_id into wrangler.jsonc
pnpm db:migrate:remote
```

## Deploy notes

1. Use Node `22.14.0+` locally for Wrangler parity with npm staged publishing tooling.
2. Install dependencies and configure secrets/production config:

   ```sh
   pnpm install
   pnpm wrangler secret put NPM_TOKEN
   pnpm wrangler secret put BETTER_AUTH_SECRET
   ```

3. Set the real D1 `database_id` and production `BETTER_AUTH_URL` in `wrangler.jsonc`, then apply migrations.
4. Build + deploy:

   ```sh
   pnpm build
   pnpm deploy
   ```

## Threat model

Defended:

- Unauthenticated access to all non-auth API endpoints.
- Malicious package content trying to prompt-inject the AI reviewer.
- Package parser trying direct Internet egress from the sandbox.
- NPM token exposure to sandbox code.
- Huge packages overwhelming AI context; samples are bounded.
- Risky changes hiding in large package output; the file diff and package metadata diff are first-class review objects.

Not defended in this spike:

- Literal `npm stage download` CLI execution inside Workers; Workers cannot spawn CLI processes.
- Perfect malware detection. This is triage, not a proof of safety.
- Deep binary analysis. Large/binary/native files are flagged for manual review.
- Full npm CLI auth edge cases around staged publish permissions.
- Production-grade RBAC, rate limiting, audit logs, async queues, and R2 artifact retention.

## Recommendation for the real build

- Keep this product centered on "what changed in this staged publish?" rather than generic package scanning.
- Add R2 storage for original tarballs and extracted artifacts.
- Move scanning to Cloudflare Queues for large packages and retryable work.
- Add line-level side-by-side diffs for text files.
- Add signed review URLs and organization/team RBAC through Better Auth.
- Keep final `npm stage approve <stage-id>` out of automation; it should remain a maintainer 2FA step.
