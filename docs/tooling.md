# Linting and formatting

## Stack

- **[oxlint](https://oxc.rs/docs/guide/usage/linter)** v1 — Rust-based ESLint replacement. Config in `.oxlintrc.json`.
- **[oxfmt](https://oxc.rs/docs/guide/usage/formatter)** v0 — Rust-based Prettier replacement. Config in `.oxfmtrc.json`.
- **[@preact/eslint-plugin-signals](https://github.com/preactjs/signals/blob/main/packages/eslint-plugin-signals/README.md)** — loaded via oxlint's `jsPlugins` (alpha) for signal-specific rules.

## Scripts

| Command                 | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm run lint`         | Run oxlint over the repo. Exit non-zero on errors.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `pnpm run lint:fix`     | Apply oxlint autofixes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `pnpm run format`       | Rewrite files with oxfmt.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `pnpm run format:check` | Report files that would change without writing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `pnpm run test`         | Node logic tests (`test/**`) plus D1-backed worker tests (`test/workers/**`) via `scripts/test.mjs`; the node and workers projects run as two parallel Vitest processes. Extra args go straight to Vitest: `pnpm test -- <file>` runs one file, `pnpm test -- --project workers <file>` pins the suite.                                                                                                                                                                                                                         |
| `pnpm run test:node`    | Just the node logic suite (`vitest run --project node`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `pnpm run test:workers` | Just the worker suite (`vitest run --project workers`; Miniflare D1 from `test/config/wrangler.jsonc` + `drizzle/`).                                                                                                                                                                                                                                                                                                                                                                                                            |
| `pnpm run e2e:fixtures` | Pack local E2E fixture packages and generate `.context/e2e-registry/registry.json`.                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `pnpm run e2e:dev`      | Start the fake npm staging registry plus the Vite/Worker dev server for browser testing.                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `pnpm run test:e2e`     | Run Playwright against the local fake-registry harness.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `pnpm run agent:tour`   | Run the portable local product walkthrough and write `agent-tour-output/report.md`, screenshots, traces, video, and an exported report JSON.                                                                                                                                                                                                                                                                                                                                                                                    |
| `pnpm run verify`       | Run lint + format check + typecheck + knip + tests **in parallel** (`scripts/verify.mjs`); the cheap checks finish while the worker pool runs. All five always run to completion and every failure is reported together.                                                                                                                                                                                                                                                                                                        |
| `pnpm run verify:quick` | The iteration loop (`scripts/verify.mjs --quick`): oxlint and oxfmt scoped to files changed vs the `origin/main` merge base (committed + staged + unstaged + untracked), the full typecheck (tsc cannot be scoped), knip (whole-graph; an unused export is created by _removing_ the last import, so a changed-file scope would miss the file that broke), and `vitest run --changed <merge-base>` for both projects. Skipped checks say so explicitly. Not the commit gate — run the full `pnpm run verify` before committing. |

`pnpm lint` (the shorthand without `run`) can collide with workspace forwarding or shell wrappers — always use `pnpm run lint`.

Server-risk changes have a stricter test matrix than the command table alone
can express. See [`release-safety.md`](./release-safety.md) for the expected
Worker-route, sandbox invariant, fake-registry e2e, security-corpus, and
observability coverage by change type.

## Worker-suite performance

Importing the server module graph into a fresh workerd isolate costs ~5s per
test file (every module is fetched individually over the pool's module-fallback
socket), so the suite's wall time is dominated by how often that import is
repeated — not by the tests themselves. Deliberate choices that keep it fast:

- **Pool workers are reused across test files.** `vitest.config.ts`
  sets `isolate: false` with `maxWorkers: 3`, so the module graph is imported
  once per pool worker instead of once per file. More workers means more
  redundant imports, so raising `maxWorkers` makes the suite _slower_. To keep
  the per-file clean-database semantics tests are written against,
  `test/workers/setup.ts` wipes all D1 tables and R2 objects in a `beforeAll`
  before re-applying migrations — files on a worker run sequentially, so the
  reset cannot race another file. Consequence: a worker test must not assert
  against state it did not create _within its own file_, and tests that sweep
  globally (e.g. the discovery cron) rely on that per-file reset.
- **The node project uses the `threads` pool** (per-file isolation kept, since
  several files `vi.mock` the same modules) to skip the default forks pool's
  per-file process spawn.
- **`test/config/wrangler.jsonc` has no `main`.** The worker tests don't use `SELF` —
  they `import worker from "../../server/index"` and call `worker.fetch(req, env, ctx)`
  directly. Setting `main` makes Miniflare eagerly evaluate the whole app graph
  in _every_ isolate at boot (~5s/file → most of the suite's wall time). Leaving
  it unset drops per-file boot to ~0.3s; the files that need the app still import
  it themselves. **Do not add `main` back** unless a test genuinely needs `SELF`
  or a Durable Object binding — and if one does, scope it to a separate project
  rather than taxing the whole worker suite.
- **Native scrypt for password hashing.** `server/lib/auth/index.ts` overrides Better
  Auth's KDF with `node:crypto`'s native scrypt (same params, byte-identical
  output — see `test/workers/auth-password-hash.test.ts`). On `workerd` the
  default falls back to a pure-JS scrypt that runs synchronously in the isolate;
  native scrypt is ~10× faster, which matters for production logins and for the
  auth-heavy worker tests that sign up / sign in / enroll TOTP.

Heavy, conditionally-used modules (e.g. the Vercel AI SDK behind the off-by-default
AI reviewer) are loaded with `await import(...)` past their feature gate, to keep
them out of the worker boot graph.

## Pre-commit verification

Run `pnpm run verify` before every commit, so each commit passes lint + format + typecheck + knip + tests. There is no git hook enforcing this — it is run explicitly. CI (`.github/workflows/ci.yml`) runs the same core checks and then installs Chromium and runs `pnpm run test:e2e`.

## Agent hooks

`scripts/hooks/` holds harness-agnostic hook scripts that give coding agents edit-time feedback. Each accepts the target file as `argv[2]` or as hook JSON on stdin (Claude Code's `tool_input.file_path` shape; Codex CLI's `apply_patch` patch envelope is also parsed):

- `post-edit-check.mjs` — after an Edit/Write, runs `oxfmt --check` + `oxlint` scoped to the edited file and exits 2 with a concise message on violations. Report-only by design: rewriting the file in place would invalidate the harness's file-state tracking and cause "file modified since read" friction on the next edit. It fails open (exit 0) on unparseable input, missing files, or missing binaries — `pnpm run verify` stays authoritative. The target file is never executed.
- `guard-protected-paths.mjs` — before an Edit/Write, blocks (exit 2) writes to `drizzle/**/*.sql` and `drizzle/meta/**`; migrations are generated via `pnpm db:generate` (Bash, unaffected). It only blocks clearly matched paths and fails open otherwise.

Wired for Claude Code in `.claude/settings.json` (PreToolUse/PostToolUse on `Edit|Write`) and for Codex CLI in `.codex/hooks.json` (same schema; Codex maps `Edit`/`Write` matchers onto `apply_patch` and requires trusting project hooks via `/hooks` once). Tests: `test/agent-hooks.test.mjs`.

## Banned hooks

`useState` and `useReducer` are forbidden via oxlint's `no-restricted-imports` from `preact/hooks` (and `react`, defensively). The same rule bans `preact/compat` and its subpaths by pattern: it re-exports the React hook surface signals replaced, and pulls a second component model into the bundle. The codebase is migrating component-local state to:

- `@preact/signals` — `useSignal`, `useComputed`, `useSignalEffect`. See the [`preact-signals-preact-integration`](../.claude/skills/preact-signals-preact-integration/SKILL.md) skill.
- `createModel` / `useModel` for cohesive state-plus-actions objects. See the [`preact-signals-models-utils`](../.claude/skills/preact-signals-models-utils/SKILL.md) skill.

Reach for a signal when the state is one value; reach for a model when the state and the writes that touch it form a unit (e.g. `loading + error + items + load()`).

## Signal unboxing model

Treat a signal as a stable box around a value. Passing the signal object through props, context, or a model does not subscribe the current component. Unboxing it with `.value` subscribes the current reactive scope, so unbox as late as correctness allows.

| Context                                               | Result                                                                                              |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Component render reads `signal.value`                 | That component rerenders when the signal changes.                                                   |
| `computed()` / `useComputed()` reads `signal.value`   | The computed tracks the read and recomputes when the signal changes.                                |
| `effect()` / `useSignalEffect()` reads `signal.value` | The effect tracks the read and reruns when the signal changes.                                      |
| JSX text renders `{signal}`                           | Preact binds the signal to the text node and updates it directly without rerendering the component. |
| DOM element prop receives `{signal}`                  | Preact can update the DOM property directly without rerendering the component.                      |
| Component prop or context carries `signal`            | No subscription occurs until a consumer unboxes it or renders it directly.                          |

Prefer passing `Signal<T>` to leaf components, utility components, and context consumers when they need live state. Read `.value` earlier only when the current scope needs to branch, derive a value, run an effect, validate input, or pass a plain snapshot to an API that cannot accept a signal.

## Signal plugin rules

The following rules from `@preact/eslint-plugin-signals` are enforced (see [`preact-signals-eslint-plugin`](../.claude/skills/preact-signals-eslint-plugin/SKILL.md) for intent):

- `no-signal-write-in-computed` (error)
- `no-value-after-await` (error)
- `no-signal-in-component-body` (error)
- `no-conditional-value-read` (error)
- `no-signal-truthiness` (warn)

### Local rule: `signals-local/no-signal-conditional-jsx`

A project-specific oxlint JS plugin lives in `tooling/oxlint/signals-local/` and is loaded
through `jsPlugins` in `.oxlintrc.json` under the `signals-local` alias. Its one rule
(`no-signal-conditional-jsx`, error) flags conditional rendering — a ternary or
`&&`/`||`/`??` in JSX **child** position — whose condition reads (or derives from) a
signal's `.value`, and points you at `<Show>`:

```tsx
{
  error.value ? <Alert>{error.value}</Alert> : null;
} // ❌ flagged
<Show when={error}>{(msg) => <Alert>{msg}</Alert>}</Show>; // ✅

{
  loading.value ? "Saving…" : "Save";
} // ❌ flagged (text counts too)
<Show when={loading} fallback="Save">
  Saving…
</Show>; // ✅
```

It deliberately does not flag attribute positions (a `<Show>` can't live there — use a
`useComputed`) or single derivations like `{format(size.value)}`. Detection is scope-based,
so it catches local signals (`useSignal`/`useComputed`) and `Signal<T>`-typed props but not
member-access signals (`model.count.value`) — fix those by hand. See the
[`preact-signals-no-eager-unwrap`](../.claude/skills/preact-signals-no-eager-unwrap/SKILL.md)
skill for the full set of eager-unwrap anti-patterns and fixes. Fixture and test:
`test/fixtures/oxlint-signals/` and `test/oxlint-signal-conditional-jsx.test.mjs`.

The rule ships as `error`; all existing call sites satisfy it, so every infraction fails lint.

### Local rule: `boundaries-local/no-cross-page-import`

A second local oxlint plugin, `tooling/oxlint/boundaries-local/`, machine-enforces the
AGENTS.md page-isolation rule: a file inside one page's directory
(`src/pages/<X>/…`) must never import from another page's directory — code shared by
two or more pages belongs in `src/features/`. The rule resolves relative static
imports, re-exports, and literal `import("…")` expressions; the router and pages-root
shared files (`src/pages/*.tsx`) are outside every page directory and stay
unconstrained. A dynamic import built from a variable cannot be resolved without
executing code, so it is not checked. Fixture and test:
`test/fixtures/oxlint-boundaries/` and `test/oxlint-cross-page-import.test.mjs`.

The rule ships as `error` with no existing violations, so every infraction fails lint.

### Logging boundary

`no-console` is scoped to `server/**` through an oxlint `overrides` entry, with
`server/lib/platform/observability.ts` excluded. That module's `emitOperationalEvent` is
where operational fields are redacted, so it is the only place allowed to reach the
console; a direct `console.log` in a route bypasses redaction and can put a token in the
logs. Frontend and script logging is unaffected.

### Local rule: `design-local/no-stacked-section-rule`

A third local oxlint plugin, `tooling/oxlint/design-local/`, pins the one `docs/design.md`
rule that keeps regressing by eye: `SectionLabel` draws its own trailing hairline, so a
`border-t`, `border-b`, `border-y`, or `<hr>` on the same boundary stacks a second 1px line and
reads as a double border. The rule reports the label's own class, the class of the
element that directly wraps it (a top border for a leading label or a bottom border
for a trailing label), and an immediately adjacent JSX sibling that draws a rule on
the touching edge. When a label touches its wrapper edge, that wrapper's touching
sibling is checked too, covering summary/header wrappers around the label. Logical and
conditional JSX siblings are inspected branch-by-branch, and JSX comments do not interrupt
visual adjacency. Only non-zero
border-width utilities count — directional color utilities do not create a line, an
all-sides `border` is a box outline, and zero-width utilities remove rather than draw a rule — and class names are read
from static strings, including the string arguments of a `cn(...)` call. A rule two
elements away is a spacing question and is not reported. Fixture and test:
`test/fixtures/oxlint-design/` and
`test/oxlint-stacked-section-rule.test.mjs`.

The rule ships as `error` with no existing violations, so every infraction fails lint.

### Prose invariants with static checks

Boundaries that lint rules cannot express are pinned by node-project invariant tests
that statically scan source text. The first two blank comments, strings, and detection
regexes via the non-executing JS lexer before scanning (see
`test/helpers/sanitized-source.mjs`):

- `test/ecosystem-branching-invariants.test.mjs` — routes and orchestrators
  (`server/routes/`, `server/lib/scan/`, `server/lib/public-diff/`,
  `server/lib/workflow-gates/`) must not branch on ecosystem-name literals; new
  ecosystems arrive through the `server/lib/ecosystems/` registry. Pre-existing
  justified branches live in the test's explicit allowlist.
- `test/sandbox-boundary-invariants.test.mjs` — the rendered sandbox worker reads
  only allowlisted config env keys and contains no credential lexemes, and the
  archive-parsing/deterministic-review layers contain no execution primitives.
- `test/api-auth-boundary-invariants.test.mjs` — Hono runs handlers and middleware in registration
  order, so an `app.route("/api/…")` placed above the `app.use("/api/*")` session guard
  in `server/index.ts` ships anonymous with nothing in the route file to show it; an
  `app.use()` handler can do the same by returning without `next()`. This pins the
  real `getAuthSession` guard and the exact registrations allowed above it, including
  catch-alls and non-API bootstrap routes because they can still answer an API request.
  Commented-out registrations and guards are blanked before the structural scan.
- `test/rate-limit-boundary-invariants.test.mjs` — `server/lib/platform/rate-limit.ts` is
  the only rate limiter: no other module names a `RATE_LIMIT_*` binding or queries the
  `rate_limits` table, and its `NATIVE_TIERS` table matches the `ratelimits` declarations
  in `wrangler.jsonc` and the optional bindings in `server/env.d.ts`. A tier declared in
  one place and not the other degrades silently to the D1 counter. It walks the
  filesystem rather than `git ls-files`, so a still-untracked new limiter fails `verify`.
- `test/migration-integrity.test.mjs` — migrations are the one artifact concurrent
  branches generate at the same index, and git merges the collision without complaint.
  Pins unique file indexes, a dense ordered journal whose tags carry their own index,
  journal and `.sql` files describing the same set, and a snapshot per entry. A
  migration missing from the journal never runs, surfacing in prod as a missing column.
- `test/prose-path-references.test.mjs` — every backtick-quoted repo path in tracked
  markdown (AGENTS.md, `docs/`, `.claude/skills/`) and in source comments must name a
  file that exists. Prose here navigates by path, and a rename silently breaks the
  reference, sending the next reader to a file that is gone. A path may be written
  from any root that resolves to exactly one tracked file (`routes/scans/index.ts` and
  `server/routes/scans/index.ts` both resolve today); relative paths in Markdown and source
  comments are resolved from the containing file. JavaScript and TypeScript comments are identified by
  the non-executing JS lexer, including inline and JSX comments. Paths that intentionally name something outside the repo — inside a
  package under review, inside a dependency, or in a gitignored output directory —
  are listed in the test's explicit non-repository exceptions.

## Client API helpers

Use `apiFetch` from `src/models/api.ts` for same-origin JSON requests so active organization headers and `ApiError` handling stay consistent. Use `apiJson` for JSON request bodies instead of repeating `content-type` and `JSON.stringify` at call sites. Use `errorMessage(err)` when model actions need to surface caught errors into a signal.

## Server route helpers

Use `rateLimitResponse` from `server/lib/platform/http.ts` for 429 JSON responses so `retryAfterSeconds` and `retry-after` headers stay consistent. Use `errorMessage(err)` from `server/lib/platform/errors.ts` for server-side caught-error stringification instead of repeating local branches; it also preserves `message` from Worker RPC-serialized error objects.

## Related skills

The `.claude/skills/` directory ships the canonical reference set used by Claude Code in this repo. The same skills are exposed to agents through the `.agents/skills` symlink:

Codebase-shape skills:

- [`shared-primitives`](../.claude/skills/shared-primitives/SKILL.md) — where a small helper belongs (`server/lib/platform/`, `src/features/`, an ecosystem directory), why a name has to state the context it is safe for (`escapeHtmlText` vs `escapeHtmlAttribute` vs `escapeXml`), and why hoisting obliges you to pin the primitive with direct tests.
- [`split-large-module`](../.claude/skills/split-large-module/SKILL.md) — choosing a seam, keeping a barrel, verifying a split with a declaration census rather than a green suite, and which files stay whole.

Signals and models:

- `preact-signals-preact-integration` — `useSignal`, JSX rendering choices, `Show`/`For`, `useLiveSignal`.
- `preact-signals-models-utils` — `createModel`/`useModel` patterns and state shape.
- `preact-signals-eslint-plugin` — what the rules catch.
- `preact-signals-no-eager-unwrap` — eager-unwrap anti-patterns (conditional render → `Show`, text/attr → direct signal, derivations → `useComputed`) and the local lint rule.
