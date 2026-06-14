# Contributing to Drydock

Thanks for your interest in contributing. This guide covers getting set up,
the checks we expect to pass, and the conventions that keep the codebase
coherent. For the deeper architectural rules, read
[`AGENTS.md`](AGENTS.md) and [`docs/`](docs/) — this file is the short version.

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Getting started

Prerequisites: **Node 22+** and **pnpm** (the repo pins a version via
`packageManager`; `corepack enable` will use it).

```bash
git clone https://github.com/JoviDeCroock/drydock.git
cd drydock
pnpm install
cp .dev.vars.example .dev.vars   # then fill in the local secrets it documents
pnpm run dev                     # Worker + UI at http://localhost:5173
```

`.dev.vars` is gitignored — never commit real secrets. To run a full
self-hosted deployment, see [`docs/self-hosting.md`](docs/self-hosting.md).

## Before you push

Run the full local gate — CI runs the same thing (plus e2e):

```bash
pnpm run verify   # lint + format check + typecheck + tests
```

If your change touches the npm registry path, credential forwarding,
staged-publish discovery, or any browser-visible scan flow, also run the
end-to-end suite against the fake registry:

```bash
pnpm run test:e2e
```

## Testing expectations

New functionality needs tests in the **same change**, at the narrowest useful
layer. Add broader coverage when behavior crosses a trust boundary:

- `server/routes/*`, auth, org scoping, rate limits, D1 persistence, queues,
  scan lifecycle → Worker-route tests in `test/workers/`.
- Sandbox, archive parser, npm credential forwarding, redaction → invariant /
  regression tests. The sandbox must never receive token material, and
  `NpmStageGateway` must remain the only credentialed egress.
- npm registry behavior, staged-publish discovery, endpoint drift → fake-registry
  e2e in `test/e2e-fixtures/` and `test/e2e/`.
- Deterministic detection changes → security-corpus fixtures with explicit rule
  IDs, severity, and risk. See [`docs/detection-eval.md`](docs/detection-eval.md).

## Conventions

A few that trip people up — the rest live in [`AGENTS.md`](AGENTS.md) and
[`DESIGN.md`](DESIGN.md):

- **Trust boundary:** package bytes are untrusted evidence; deterministic
  findings are authoritative. The AI reviewer is gated off by default and can
  never downgrade a deterministic finding. Don't change that default without a
  feature decision.
- **Egress:** `NpmStageGateway` is the only credentialed egress and only for the
  staged tarball endpoint. Keep it that way.
- **State:** `useState` / `useReducer` are banned (enforced by lint). Use
  `@preact/signals` (`useSignal` / `useComputed`) or `createModel` / `useModel`.
  We use `preact`, never `preact/compat`.
- **UI:** Tailwind v4 with tokens in `src/style.css`; reach for the primitives in
  `src/components/` before one-off classes. Text glyphs only — no SVG icons.
  Read [`DESIGN.md`](DESIGN.md) before any visual change.
- **Migrations:** never hand-write SQL. Edit `server/db/schema.ts` and run
  `pnpm db:generate`.
- **Comments** explain _why_, not _what_. No commented-out code or stale TODOs.
- **Docs:** read `docs/` before starting; update `docs/` when you finish.

## Commits and pull requests

- Keep PRs focused; one logical change per PR.
- Make sure `pnpm run verify` passes before opening the PR.
- Write a clear description of _what_ changed and _why_. Link any related issue
  (`Fixes #123`).
- If your change crosses a trust boundary (sandbox, credentials, egress, auth),
  call that out explicitly so reviewers know where to look.

## Reporting security issues

Do **not** open a public issue for vulnerabilities. Follow
[`SECURITY.md`](SECURITY.md) for private disclosure.
