# Staged publish sandbox prototype

Cloudflare Worker + Preact UI prototype for reviewing an npm staged publish before approval. The Hono worker is co-located with the UI and bundled by Vite + the Cloudflare plugin — same shape as `../le-chien/web`.

## What this proves

- The public Worker exposes `POST /api/v1/scan { stageId }` and spins up a fresh Dynamic Worker for the risky package-download/parsing step.
- The Dynamic Worker fetches the staged tarball through a locked-down gateway; it never receives the npm token.
- Direct sandbox egress is intercepted. Only expected npm registry endpoints are allowed:
  - staged tarball: `https://registry.npmjs.org/-/stage/<stage-id>/tarball`
  - package metadata JSON
  - published `.tgz` tarballs for previous-version diffing
- The sandbox gunzips/parses tarballs, returns bounded file metadata and text samples, and the parent Worker runs deterministic checks plus Workers AI JSON-mode review.
- The service diffs the staged tarball against the currently published previous version when package metadata is available.
- Package files are treated as hostile evidence. The AI prompt explicitly ignores file-contained instructions and the output is schema constrained.
- Review results can be persisted in Cloudflare D1 through Drizzle ORM.
- Auth is wired through Better Auth and can be enforced for `/api/v1/*` by setting `AUTH_REQUIRED=true`.

## Important constraint

Cloudflare Workers/Dynamic Workers cannot spawn a shell or run the literal `npm stage download` CLI command. This prototype uses the same staged-tarball download boundary from inside the Dynamic Worker via `fetch()`, behind an egress gateway that injects npm auth outside the sandbox.

If we need to test the literal CLI command, that belongs in a separate container/VM runner. For Cloudflare, this fetch-based shape is safer and closer to the runtime we can actually deploy.

## Layout

```
server/        Hono worker (deploy target — main in wrangler.jsonc)
  index.ts     Mounts /api/* routes, applies security headers, gates /api/v1/*
  routes/      scan.ts (POST), scans.ts (list + detail)
  lib/         sandbox, review (rules + diff), ai-review, registry, auth
  db/          Drizzle schema + persistence helpers
src/           Preact UI served as static assets by the worker
  pages/Scan/  Scan form + result view (rule findings, AI findings, diff list)
  models/      Fetch wrappers that talk to /api/* (re-use server types)
drizzle/       D1 migrations
index.html     Vite entry
test/          node --test for pure logic
```

## Develop

```sh
pnpm install
pnpm dev          # vite + cloudflare plugin, http://localhost:5173
```

The Vite dev server runs the Worker locally and serves the UI at the same origin, so `fetch("/api/v1/scan")` works without CORS.

## API

```sh
# Run a scan
curl -X POST http://localhost:5173/api/v1/scan \
  -H 'content-type: application/json' \
  -d '{"stageId":"<stage-id>"}'

# List persisted scans (requires D1)
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
- Workers AI `aiFindings`
- `risk`
- safety posture metadata

## Database

Schema is defined in `server/db/schema.ts`. Initial SQL migration is in `drizzle/0000_initial.sql`.

Create D1 database and apply migration:

```sh
pnpm wrangler d1 create staged-publish-sandbox-prototype
# copy the real database_id into wrangler.jsonc
pnpm db:migrate:remote
```

## Deploy notes

1. Use Node `22.14.0+` locally for Wrangler parity with npm staged publishing tooling.
2. Install dependencies and configure secrets:

   ```sh
   pnpm install
   pnpm wrangler secret put NPM_TOKEN
   pnpm wrangler secret put BETTER_AUTH_SECRET
   ```

3. Set the real D1 `database_id` in `wrangler.jsonc` and apply the migration.
4. Build + deploy:

   ```sh
   pnpm build
   pnpm deploy
   ```

## Threat model

Defended:

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

## Verdict: PARTIAL

### What worked

- The Cloudflare architecture is viable if we treat staged download as a registry tarball fetch inside a Dynamic Worker.
- Dynamic Worker egress control is the right trust boundary: block default egress and route only expected npm requests through a parent-owned gateway.
- Version diffing materially improves review quality: maintainers see what changed, not just what exists.
- Prompt-injection resistance is mostly an application discipline: deterministic findings first, hostile-file framing, bounded JSON input, schema output, and no AI authority to approve.

### What didn't

- The literal npm CLI command cannot run in a Worker runtime.

### Recommendation for the real build

- Keep this product centered on "what changed in this staged publish?" rather than generic package scanning.
- Add R2 storage for original tarballs and extracted artifacts.
- Move scanning to Cloudflare Queues for large packages and retryable work.
- Add line-level side-by-side diffs for text files.
- Add signed review URLs and organization/team RBAC through Better Auth.
- Keep final `npm stage approve <stage-id>` out of automation; it should remain a maintainer 2FA step.
