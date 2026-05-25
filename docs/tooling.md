# Linting and formatting

## Stack

- **[oxlint](https://oxc.rs/docs/guide/usage/linter)** v1 — Rust-based ESLint replacement. Config in `.oxlintrc.json`.
- **[oxfmt](https://oxc.rs/docs/guide/usage/formatter)** v0 — Rust-based Prettier replacement. Config in `.oxfmtrc.json`.
- **[@preact/eslint-plugin-signals](https://github.com/preactjs/signals/blob/main/packages/eslint-plugin-signals/README.md)** — loaded via oxlint's `jsPlugins` (alpha) for signal-specific rules.

## Scripts

| Command                  | What it does                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------- |
| `pnpm run lint`          | Run oxlint over the repo. Exit non-zero on errors.                                                      |
| `pnpm run lint:fix`      | Apply oxlint autofixes.                                                                                 |
| `pnpm run signals:check` | Run the repo-specific signal boundary check over `src/**/*.tsx`.                                        |
| `pnpm run format`        | Rewrite files with oxfmt.                                                                               |
| `pnpm run format:check`  | Report files that would change without writing.                                                         |
| `pnpm run test`          | Node logic tests (`test/**`) plus D1-backed worker tests (`test/workers/**`) via `vitest-pool-workers`. |
| `pnpm run test:node`     | Just the node logic suite.                                                                              |
| `pnpm run test:workers`  | Just the worker suite (Miniflare D1 from `wrangler.test.jsonc` + `drizzle/`).                           |
| `pnpm run verify`        | Run lint + signal boundary check + format check + typecheck + tests, in order.                          |

`pnpm lint` (the shorthand without `run`) can collide with workspace forwarding or shell wrappers — always use `pnpm run lint`.

## Pre-commit hook

`pnpm install` runs a `prepare` script that points `git config core.hooksPath` at `.githooks/`. The `.githooks/pre-commit` script then runs `pnpm run verify`, so every commit on this repo must pass lint + format + typecheck + tests. CI (`.github/workflows/ci.yml`) runs the same `verify` pipeline.

If a commit must skip the hook, pass `git commit --no-verify` — only do that when the gate is broken for reasons unrelated to your change.

## Banned hooks

`useState` and `useReducer` are forbidden via oxlint's `no-restricted-imports` from `preact/hooks` (and `react`, defensively). The codebase is migrating component-local state to:

- `@preact/signals` — `useSignal`, `useComputed`, `useSignalEffect`. See the [`preact-signals-preact-integration`](../.claude/skills/preact-signals-preact-integration/SKILL.md) skill.
- `createModel` / `useModel` for cohesive state-plus-actions objects. See the [`preact-signals-models-utils`](../.claude/skills/preact-signals-models-utils/SKILL.md) skill.

Reach for a signal when the state is one value; reach for a model when the state and the writes that touch it form a unit (e.g. `loading + error + items + load()`).

## Signal plugin rules

The following rules from `@preact/eslint-plugin-signals` are the repo's correctness floor and must stay enabled (see [`preact-signals-eslint-plugin`](../.claude/skills/preact-signals-eslint-plugin/SKILL.md) for intent):

- `no-signal-write-in-computed` (error)
- `no-value-after-await` (error)
- `no-signal-in-component-body` (error)
- `no-conditional-value-read` (error)
- `no-signal-truthiness` (warn)

## Signal boundary check

`pnpm run signals:check` runs [`scripts/check-signal-boundaries.mjs`](../scripts/check-signal-boundaries.mjs). This prototype catches locally-created signals that are unboxed too early in native DOM JSX:

- DOM text such as `<span>{count.value}</span>` should usually be `<span>{count}</span>`.
- DOM props such as `<input value={query.value}>` should usually be `<input value={query}>`.

The check intentionally does not block every `.value` read. Parent components still need `.value` for branching, deriving values, calling APIs that expect plain values, and passing deliberate snapshots. For an intentional snapshot at a DOM boundary, add `// signals-boundary-ok: <reason>` on the same or previous line.

## Signal review checklist

- Is the official signal lint-rule floor still enabled?
- Where is each signal unboxed, and does that scope need to subscribe?
- Could a DOM text node, DOM prop, leaf component, or context consumer receive the signal object instead?
- Are async effects reading `.value` before `await`, or intentionally using `untracked()` after it?
- Are object and array signal updates assigning a new `.value` reference?

## Related skills

The `.claude/skills/` directory ships the signals/models reference set used by Claude Code during this migration:

- `preact-signals-core` — core reactivity primitives and the runtime tracking model.
- `preact-signals-preact-integration` — `useSignal`, JSX rendering choices, `Show`/`For`, `useLiveSignal`.
- `preact-signals-models-utils` — `createModel`/`useModel` patterns and state shape.
- `preact-signals-eslint-plugin` — what the rules catch.
- `preact-signals-debugging` — triage map for stale renders, missing updates, SSR issues.
