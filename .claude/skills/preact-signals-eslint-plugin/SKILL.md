---
name: preact-signals-eslint-plugin
description: Diagnose or change Signals lint behavior in Drydock’s Oxlint setup, including local rule coverage and static-analysis limits.
---

# Signals lint in Drydock

The repository uses Oxlint with `@preact/eslint-plugin-signals` plus local rules under `tooling/oxlint/signals-local/`. Read `.oxlintrc.json` for active configuration and `docs/tooling.md` for rule ownership and test commands. Do not introduce a parallel ESLint configuration to fix an Oxlint diagnostic.

## Interpret the diagnostic

| Rule | Correctness question |
| --- | --- |
| `no-signal-write-in-computed` | Is a derivation mutating its dependencies? |
| `no-value-after-await` | Was a dependency read after reactive tracking ended? |
| `no-signal-truthiness` | Is a signal object being treated as its boolean value? |
| `no-signal-in-component-body` | Is render recreating state or a subscription? |
| `no-conditional-value-read` | Does a non-reactive guard hide a tracked dependency? |
| `signals-local/no-signal-conditional-jsx` | Should a JSX condition subscribe inside `Show`? |

Inspect the reactive scope and intended behavior before choosing a fix. For guarded computeds, reading required signals before branching can preserve tracking. For async code, decide which values are snapshots and which must remain live; blindly moving reads before `await` can change semantics.

Oxlint's available type information and the plugins' alias/data-flow analysis are limited. A missing diagnostic does not prove a model-member read or cross-function flow is correct. Consult the installed `node_modules/@preact/eslint-plugin-signals/README.md` and source for supported options and actual detection behavior.

For a rule change, add a failing misuse fixture and a valid counterexample in the owning fixture suite. The local JSX rule uses `test/fixtures/oxlint-signals/` and `test/oxlint-signal-conditional-jsx.test.mjs`. Verify both diagnostics and valid code; do not weaken a rule globally to silence one call site without establishing why it is wrong.
