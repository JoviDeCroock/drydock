# Linting and formatting

## Stack

- **[oxlint](https://oxc.rs/docs/guide/usage/linter)** v1 — Rust-based ESLint replacement. Config in `.oxlintrc.json`.
- **[oxfmt](https://oxc.rs/docs/guide/usage/formatter)** v0 — Rust-based Prettier replacement. Config in `.oxfmtrc.json`.
- **[@preact/eslint-plugin-signals](https://github.com/preactjs/signals/blob/main/packages/eslint-plugin-signals/README.md)** — loaded via oxlint's `jsPlugins` (alpha) for signal-specific rules.

## Scripts

| Command                 | What it does                                       |
| ----------------------- | -------------------------------------------------- |
| `pnpm run lint`         | Run oxlint over the repo. Exit non-zero on errors. |
| `pnpm run lint:fix`     | Apply oxlint autofixes.                            |
| `pnpm run format`       | Rewrite files with oxfmt.                          |
| `pnpm run format:check` | Report files that would change without writing.    |

`pnpm lint` (the shorthand without `run`) can collide with workspace forwarding or shell wrappers — always use `pnpm run lint`.

## Banned hooks

`useState` and `useReducer` are forbidden via oxlint's `no-restricted-imports` from `preact/hooks` (and `react`, defensively). The codebase is migrating component-local state to:

- `@preact/signals` — `useSignal`, `useComputed`, `useSignalEffect`. See the [`preact-signals-preact-integration`](../.claude/skills/preact-signals-preact-integration/SKILL.md) skill.
- `createModel` / `useModel` for cohesive state-plus-actions objects. See the [`preact-signals-models-utils`](../.claude/skills/preact-signals-models-utils/SKILL.md) skill.

Reach for a signal when the state is one value; reach for a model when the state and the writes that touch it form a unit (e.g. `loading + error + items + load()`).

## Signal plugin rules

The following rules from `@preact/eslint-plugin-signals` are enforced (see [`preact-signals-eslint-plugin`](../.claude/skills/preact-signals-eslint-plugin/SKILL.md) for intent):

- `no-signal-write-in-computed` (error)
- `no-value-after-await` (error)
- `no-signal-in-component-body` (error)
- `no-conditional-value-read` (error)
- `no-signal-truthiness` (warn)

## Related skills

The `.claude/skills/` directory ships the signals/models reference set used by Claude Code during this migration:

- `preact-signals-core` — core reactivity primitives and the runtime tracking model.
- `preact-signals-preact-integration` — `useSignal`, JSX rendering choices, `Show`/`For`, `useLiveSignal`.
- `preact-signals-models-utils` — `createModel`/`useModel` patterns and state shape.
- `preact-signals-eslint-plugin` — what the rules catch.
- `preact-signals-debugging` — triage map for stale renders, missing updates, SSR issues.
