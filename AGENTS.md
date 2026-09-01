# Agent rules

## Load context progressively

- Start with `docs/README.md`. Use `docs/repository-map.md` for ownership, `docs/tooling.md` for commands, `docs/release-safety.md` for test scope, and `docs/design.md` before UI decisions. Do not read all docs.
- Keep shell and search output under roughly 3,000 tokens; read ranges and hunks, not whole files. Start a fresh session for unrelated work.

## Comments

- Comment only for non-obvious rationale, security or trust-boundary constraints, external quirks, and invariants the code cannot express. Do not restate the code, narrate control flow, repeat types or assertions, or duplicate nearby documentation.
- In tests, behavior belongs in the test name and assertions. Comment only when fixture setup or ordering has a non-obvious reason.

## Hard boundaries

- Treat package bytes as hostile evidence. Never execute package code, install its dependencies, run lifecycle scripts/builds/shells, import its modules, or render package-provided active content.
- npm credentials stay outside the sandbox. Only `NpmStageGateway` may attach npm auth, and only to allowed staged, metadata, or tarball registry endpoints.
- AI review is advisory and on by default. The organization `ai-review` flag is a killswitch; AI review cannot downgrade deterministic findings.
- Every non-auth `/api/*` endpoint requires a Better Auth session and organization-scoped ownership; UI state is never an authority. `docs/security-model.md` enumerates the anonymous surfaces — adding one is a security decision.
- Never log raw tokens, headers, package contents, or unredacted errors. Server logging goes through `emitOperationalEvent`, which redacts the fields it is handed.
- Declare Cloudflare bindings by hand in `server/env.d.ts` (`cf-typegen` is not used by typecheck), `wrangler.jsonc`, `docs/examples/wrangler.self-host.jsonc`, and, when tests need them, `test/config/wrangler.jsonc`.

## Architecture invariants

- `server/lib/ecosystems/index.ts` is the sole `staged`/`gate`/`publicDiff` registry. Add ecosystem directories and registry entries; put gate behavior in `<id>/workflow-gate.ts` and extend `WorkflowGateAdapter` for optional shared hooks.
- Reuse `server/lib/platform/{guards,path-safety,concurrency}.ts`; read `.claude/skills/shared-primitives` before adding generic helpers and `.claude/skills/split-large-module` before splitting large modules.
- Preserve responsibility-focused barrels in `server/db/scans.ts`, `server/lib/scan/artifacts/index.ts`, and `src/models/scan.ts`.
- Shared UI belongs in `src/features/`.

## Frontend

- Use `preact`, `preact-iso`, and `@preact/signals`. Component-local state is signals and models, never hooks — read `docs/tooling.md` and the applicable `.claude/skills/preact-signals-*` skill.
- Use Tailwind v4 tokens from `src/style.css` and `src/components/` primitives. No CSS-in-JS or SVG icons.

## Finish changes

- Add tests at the narrowest layer in `docs/repository-map.md`; follow `docs/release-safety.md` when behavior crosses a trust boundary.
- Detection changes require security-corpus fixtures with explicit rule ID/severity/risk and relevant eval coverage.
- Use `pnpm run verify:quick` while iterating and `pnpm run verify` before commits when practical. Generate migrations with `pnpm db:generate`.
- Update the relevant docs for behavior, API, UI, security, workflow, deployment, or operator changes, or record `docs checked, no update needed` in the PR/testing summary.
