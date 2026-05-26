# Linting and formatting

## Stack

- **[oxlint](https://oxc.rs/docs/guide/usage/linter)** v1 — Rust-based ESLint replacement. Config in `.oxlintrc.json`.
- **[oxfmt](https://oxc.rs/docs/guide/usage/formatter)** v0 — Rust-based Prettier replacement. Config in `.oxfmtrc.json`.
- **[@preact/eslint-plugin-signals](https://github.com/preactjs/signals/blob/main/packages/eslint-plugin-signals/README.md)** — loaded via oxlint's `jsPlugins` (alpha) for signal-specific rules.

## Scripts

| Command                 | What it does                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------- |
| `pnpm run lint`         | Run oxlint over the repo. Exit non-zero on errors.                                                      |
| `pnpm run lint:fix`     | Apply oxlint autofixes.                                                                                 |
| `pnpm run format`       | Rewrite files with oxfmt.                                                                               |
| `pnpm run format:check` | Report files that would change without writing.                                                         |
| `pnpm run test`         | Node logic tests (`test/**`) plus D1-backed worker tests (`test/workers/**`) via `vitest-pool-workers`. |
| `pnpm run test:node`    | Just the node logic suite.                                                                              |
| `pnpm run test:workers` | Just the worker suite (Miniflare D1 from `wrangler.test.jsonc` + `drizzle/`).                           |
| `pnpm run e2e:fixtures` | Pack local E2E fixture packages and generate `.context/e2e-registry/registry.json`.                     |
| `pnpm run e2e:dev`      | Start the fake npm staging registry plus the Vite/Worker dev server for browser testing.                |
| `pnpm run test:e2e`     | Run Playwright against the local fake-registry harness.                                                 |
| `pnpm run verify`       | Run lint + format check + typecheck + tests, in order.                                                  |

`pnpm lint` (the shorthand without `run`) can collide with workspace forwarding or shell wrappers — always use `pnpm run lint`.

## Pre-commit hook

`pnpm install` runs a `prepare` script that points `git config core.hooksPath` at `.githooks/`. The `.githooks/pre-commit` script then runs `pnpm run verify`, so every commit on this repo must pass lint + format + typecheck + tests. CI (`.github/workflows/ci.yml`) runs the same core checks and then installs Chromium and runs `pnpm run test:e2e`.

If a commit must skip the hook, pass `git commit --no-verify` — only do that when the gate is broken for reasons unrelated to your change.

## Banned hooks

`useState` and `useReducer` are forbidden via oxlint's `no-restricted-imports` from `preact/hooks` (and `react`, defensively). The codebase is migrating component-local state to:

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

## Related skills

The `.claude/skills/` directory ships the canonical signals/models reference set used by Claude Code during this migration. The same skills are exposed to agents through the `.agents/skills` symlink:

- `preact-signals-core` — core reactivity primitives and the runtime tracking model.
- `preact-signals-preact-integration` — `useSignal`, JSX rendering choices, `Show`/`For`, `useLiveSignal`.
- `preact-signals-models-utils` — `createModel`/`useModel` patterns and state shape.
- `preact-signals-eslint-plugin` — what the rules catch.
- `preact-signals-debugging` — triage map for stale renders, missing updates, SSR issues.
