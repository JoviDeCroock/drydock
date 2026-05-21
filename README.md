# Staged publish sandbox prototype

Cloudflare Worker prototype for reviewing an npm staged publish before approval.

## What this proves

- The public Worker accepts a `stageId` and spins up a fresh Dynamic Worker for the risky package-download/parsing step.
- The Dynamic Worker fetches the staged tarball through a locked-down gateway; it never receives the npm token.
- Direct sandbox egress is intercepted. Only expected npm registry endpoints are allowed:
  - staged tarball: `https://registry.npmjs.org/-/stage/<stage-id>/tarball`
  - package metadata JSON
  - published `.tgz` tarballs for previous-version diffing
- The sandbox gunzips/parses tarballs, returns bounded file metadata and text samples, and the parent Worker runs deterministic checks plus Workers AI JSON-mode review.
- The service diffs the staged tarball against the currently published previous version when package metadata is available.
- Package files are treated as hostile evidence. The AI prompt explicitly ignores file-contained instructions and the output is schema constrained.
- Review results can be persisted in Cloudflare D1 through Drizzle ORM.
- Auth is wired through Better Auth and can be enforced for `/api/*` by setting `AUTH_REQUIRED=true`.
- `/` serves a small Preact review UI for submitting scans and exploring changed files safely.

## Important constraint

Cloudflare Workers/Dynamic Workers cannot spawn a shell or run the literal `npm stage download` CLI command. This prototype uses the same staged-tarball download boundary from inside the Dynamic Worker via `fetch()`, behind an egress gateway that injects npm auth outside the sandbox.

If we need to test the literal CLI command, that belongs in a separate container/VM runner. For Cloudflare, this fetch-based shape is safer and closer to the runtime we can actually deploy.

## Architecture

```text
Maintainer browser
  -> Worker / Preact UI
  -> Better Auth session check for /api/* when AUTH_REQUIRED=true
  -> POST /api/scans { stageId }
  -> Dynamic Worker sandbox downloads staged tarball through gateway
  -> Parent Worker fetches npm metadata and asks sandbox to parse previous published tarball
  -> deterministic policy + version diff + Workers AI JSON-mode analysis
  -> Drizzle ORM persists scan, files, and findings in D1
```

Security boundaries:

- `NPM_TOKEN` stays in the parent Worker secret environment.
- Dynamic Worker receives no token and no broad egress.
- Gateway only forwards expected npm registry requests.
- File previews are rendered as escaped text by the app. Package-provided HTML, JS, SVG, and images are not executed.
- AI sees bounded snippets of changed files and deterministic findings; package contents are hostile evidence, not instructions.

## API

Create and run a scan:

```sh
curl -X POST https://<worker>/api/scans \
  -H 'content-type: application/json' \
  -d '{"stageId":"<stage-id>"}'
```

Legacy route is also kept:

```sh
curl -X POST https://<worker>/scan \
  -H 'content-type: application/json' \
  -d '{"stageId":"<stage-id>"}'
```

List persisted scans:

```sh
curl https://<worker>/api/scans
```

Read a persisted scan:

```sh
curl https://<worker>/api/scans/<scan-id>
```

Response includes:

- `id`
- package name, staged version, previous version
- `fileCount` and `previousFileCount`
- `packageJsonDiff`
- file-level `diff`
- deterministic `ruleFindings`
- Workers AI `aiFindings`
- `risk`
- safety posture metadata

## Web UI

Open `/` after deploy.

The Preact UI supports:

- entering a stage ID
- running a scan
- risk summary
- finding list
- changed-file list
- safe text-only preview area

The current UI is intentionally minimal. For production, replace the CDN-style Preact module import with a bundled asset pipeline and add authenticated persisted scan browsing.

## Database

Schema is defined in:

- `src/db/schema.ts`

Initial SQL migration is in:

- `drizzle/0000_initial.sql`

Tables:

- `scans`
- `scan_files`
- `scan_findings`
- Better Auth tables:
  - `user`
  - `session`
  - `account`
  - `verification`

Create D1 database and apply migration:

```sh
pnpm wrangler d1 create staged-publish-sandbox-prototype
# copy the real database_id into wrangler.jsonc
pnpm wrangler d1 execute staged-publish-sandbox-prototype --remote --file ./drizzle/0000_initial.sql
```

## Deploy notes

1. Use Node `22.14.0+` locally for Wrangler parity with npm staged publishing tooling.
2. Install dependencies:

   ```sh
   pnpm install
   ```

3. Configure secrets:

   ```sh
   pnpm wrangler secret put NPM_TOKEN
   pnpm wrangler secret put BETTER_AUTH_SECRET
   ```

4. Set the real D1 `database_id` in `wrangler.jsonc`.
5. Apply the D1 migration.
6. Deploy:

   ```sh
   pnpm run deploy
   ```

## Threat model

Defended:

- Malicious package content trying to prompt-inject the AI reviewer.
- Package parser trying direct Internet egress from the sandbox.
- NPM token exposure to sandbox code.
- Huge packages overwhelming AI context; samples are bounded.
- Browser execution of package-provided HTML/JS/SVG; previews are text-only.
- Risky changes hiding in large package output; changed files and package metadata diffs are first-class review objects.

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
- The Preact UI is a prototype shell; persisted file sample retrieval and side-by-side text diffs still need a production UI pass.

### Recommendation for the real build

- Keep this product centered on “what changed in this staged publish?” rather than generic package scanning.
- Add R2 storage for original tarballs and extracted artifacts.
- Move scanning to Cloudflare Queues for large packages and retryable work.
- Add line-level side-by-side diffs for text files.
- Add signed review URLs and organization/team RBAC through Better Auth.
- Keep final `npm stage approve <stage-id>` out of automation; it should remain a maintainer 2FA step.
