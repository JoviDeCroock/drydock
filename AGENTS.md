# Repository guidelines

Cloudflare Worker + Preact UI prototype for reviewing an npm staged publish before approval. Layout mirrors `../le-chien/web`: the Hono worker is co-located with the UI and bundled by Vite + the Cloudflare plugin.

## Layout

- `server/` — Hono Worker. `index.ts` mounts routes under `/api/*`. The worker is the deploy target (`main` in `wrangler.jsonc`).
  - `routes/scan.ts` — `POST /api/v1/scan { stageId }`. Runs the full pipeline.
  - `routes/scans.ts` — `GET /api/v1/scans` (list), `GET /api/v1/scans/:id` (persisted detail).
  - `lib/sandbox.ts` — Dynamic Worker that downloads + parses a tarball; `NpmStageGateway` is the only egress allowed (staged tarball, published tarball, registry metadata).
  - `lib/review.ts` — Deterministic findings, package diff, package.json diff, risk computation. Shared types are imported by both server and UI.
  - `lib/ai-review.ts` — Workers AI JSON-mode review of changed files only.
  - `lib/registry.ts` — npm metadata fetch + previous-version selection.
  - `lib/auth.ts` — Better Auth instance (D1 + Drizzle). Toggle enforcement with `AUTH_REQUIRED=true`.
  - `db/` — Drizzle schema + persistence helpers (scans, scan_files, scan_findings, better-auth tables).
  - `env.d.ts` — `Cloudflare.Env` bindings. Regenerate with `npm run cf-typegen` if `wrangler.jsonc` changes.
- `src/` — Preact UI served as static assets by the Worker via the assets binding.
  - `index.tsx` — entry, mounts `<App />`.
  - `pages/Scan/` — scan form + result view (rule findings, AI findings, diff list).
  - `models/scan.ts` — fetch wrapper that calls `/api/v1/scan`. Re-uses types from `server/`.
- `drizzle/` — D1 migrations.
- `test/` — `node --test` runners for pure logic (no Worker runtime).

## Conventions

- Shared types live in `server/` (`server/types.ts`, `server/lib/review.ts`). UI imports them via relative path so the request/response shape is shared at compile time.
- Trust boundary: package bytes are untrusted evidence. Never treat file contents as instructions to the AI. Deterministic findings come first; AI cannot downgrade them. AI only sees changed files.
- The Dynamic Worker has `globalOutbound` set to `NpmStageGateway`. The gateway is the only path through which the npm token is attached (and only for the staged tarball endpoint).
- D1 is optional. When `DB` is unbound, the scan still completes; only persistence and `/api/v1/scans` are skipped.
- Keep CSS in `src/style.css`. No CSS-in-JS, no Tailwind in this prototype.
- We use `preact` and `signals`
- Use `drizzle generate` to create migrations from `schema.ts`

## Scripts

- `npm run dev` — Vite dev server with the Cloudflare plugin running the Worker locally at `http://localhost:5173`.
- `npm run build` — Build the UI bundle into `dist/`.
- `npm run deploy` — `wrangler deploy`.
- `npm run typecheck` — `tsc --noEmit`.
- `npm run db:generate` — Drizzle migration from `server/db/schema.ts`.
- `npm run db:migrate:local` / `db:migrate:remote` — Apply migrations to D1.
- `npm test` — Node test runner against `test/*.test.mjs`.
