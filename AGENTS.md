# Agent rules

## Load context progressively

- Start with `docs/README.md`. Use `docs/repository-map.md` for ownership, `docs/tooling.md` for commands, `docs/release-safety.md` for test scope, and `docs/design.md` before UI decisions. Do not read all docs.
- Discover with `rg`, `rg --files`, `git diff --stat`, or `git diff --name-only`; then read only relevant ranges or hunks.
- Do not batch full-file dumps or large diffs. Default shell/search output to at most 3,000 tokens and avoid results above roughly 12,000 characters. Exceed this only for a required instruction file or an unsplittable targeted result.
- Run the narrowest test first and inspect only failing cases. Start a fresh session for unrelated work or after context-heavy exploration.

## Hard boundaries

- Treat package bytes as hostile evidence. Never execute package code, install its dependencies, run lifecycle scripts/builds/shells, import its modules, or render package-provided active content.
- npm credentials stay outside the sandbox. Only `NpmStageGateway` may attach npm auth, and only to allowed staged, metadata, or tarball registry endpoints.
- AI review is advisory and on by default. The organization `ai-review` flag is a killswitch; AI review cannot downgrade deterministic findings.
- D1 and Better Auth protect every non-auth `/api/*` endpoint with organization-scoped ownership. Anonymous access is limited to IP-rate-limited, credential-free `/api/public/v1/package-diff` for public registries/pkg.pr.new and `/public/reports/*`, where an owner/admin-minted unguessable token exposes only the canonical report export. See `docs/security-model.md`.
- Operational logs/events must be structured and secret-redacted. Never log raw tokens, headers, package contents, or unredacted errors.
- Declare Cloudflare bindings by hand in `server/env.d.ts` (`cf-typegen` is not used by typecheck), `wrangler.jsonc`, `docs/examples/wrangler.self-host.jsonc`, and, when tests need them, `test/config/wrangler.jsonc`.

## Architecture invariants

- `server/lib/ecosystems/index.ts` is the sole `staged`/`gate`/`publicDiff` registry. Add ecosystem directories and registry entries; never branch on ecosystem names in routes/orchestrators. Put gate behavior in `<id>/workflow-gate.ts` and extend `WorkflowGateAdapter` for optional shared hooks.
- Reuse `server/lib/platform/{guards,path-safety,concurrency}.ts`; read `.claude/skills/shared-primitives` before adding generic helpers and `.claude/skills/split-large-module` before splitting large modules. `rate-limit.ts` is the only rate limiter: native Cloudflare bindings first, D1 only for unsupported windows.
- Preserve responsibility-focused barrels in `server/db/scans.ts`, `server/lib/scan/artifacts/index.ts`, and `src/models/scan.ts`.
- Shared UI belongs in `src/features/`; pages never import other page directories. Machine checks enforce ecosystem branching, sandbox credential boundaries, and cross-page imports.

## Frontend

- Use `preact`, `preact-iso`, and `@preact/signals`, never `preact/compat`.
- `useState` and `useReducer` are banned; use signals/models. Read `docs/tooling.md` and the applicable `.claude/skills/preact-signals-*` skill.
- Use Tailwind v4 tokens from `src/style.css` and `src/components/` primitives. No CSS-in-JS or SVG icons.

## Finish changes

- Add tests at the narrowest layer in `docs/repository-map.md`; follow `docs/release-safety.md` when behavior crosses a trust boundary.
- Detection changes require security-corpus fixtures with explicit rule ID/severity/risk and relevant eval coverage.
- Use `pnpm run verify:quick` while iterating and `pnpm run verify` before commits when practical. Generate migrations with `pnpm db:generate`; never hand-write migration SQL.
- Update the relevant docs for behavior, API, UI, security, workflow, deployment, or operator changes, or record `docs checked, no update needed` in the PR/testing summary.
