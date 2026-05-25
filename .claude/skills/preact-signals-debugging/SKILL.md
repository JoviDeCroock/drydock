---
name: preact-signals-debugging
description: Use when diagnosing Preact Signals bugs, stale renders, missing updates, over-eager rerenders from early unboxing, memory leaks, duplicate Preact copies, React transform misses, devtools/debug output, SSR differences, or issues that need a minimal reproduction.
---

# Preact Signals Debugging

## Core Approach

Classify the failure before editing code: core reactivity, Preact adapter, React adapter, no-build/CDN singleton, transform configuration, SSR, or devtools/debugging. Most reported issues reduce to one of those boundaries.

First locate the unboxing point. A signal update can rerun an effect, rerender a component, update a text node directly, update a DOM property directly, or do nothing reactive, depending on where `.value` or a Preact binding is used.

## Triage Checklist

1. Confirm package names and versions: `@preact/signals-core`, `@preact/signals`, `@preact/signals-react`, `@preact/signals-react-transform`, `preact`, `react`.
2. Check whether the app is Preact or React. The adapters differ.
3. Verify the signal write is an assignment to `.value`, not deep mutation.
4. Verify the subscribed `.value` read actually executes at runtime.
5. Check whether `.value` was read too early in a parent, provider, model constructor, or helper.
6. Check whether the value is rendered as `{signal}` or `{signal.value}` and whether direct DOM optimization is expected.
7. For React, verify the Babel transform or `useSignals()` is present.
8. For no-build setups, check duplicate Preact copies.
9. For SSR, remember server renders do not track rerender subscriptions.

## Fast Symptom Map

| Symptom | Likely Boundary | Next Skill |
| --- | --- | --- |
| Effect logs but component does not rerender | Adapter or duplicate Preact | `preact-signals-preact-integration` or `preact-signals-no-build` |
| Object field changed but subscribers stale | Core signal semantics | `preact-signals-core` |
| Parent rerenders when only a leaf text node should change | Signal was unboxed too early with `.value` | `preact-signals-preact-integration` |
| Context provider rerenders consumers too broadly | Provider passed a plain object built from `.value` reads | `preact-signals-preact-integration` |
| Long-lived model ignores a replaced signal prop | Model captured the old signal reference | `preact-signals-models-utils` |
| React component reads `.value` but does not update | React tracking setup | `preact-signals-react-integration` |
| Signal works in text but not `checked` or `disabled` | React DOM attribute limitation | `preact-signals-react-integration` |
| `For` children ignore parent variable changes | Cached utility children | `preact-signals-preact-integration` |
| CDN example behaves differently from npm | Version drift or duplicate Preact | `preact-signals-no-build` |

## Minimal Reproduction Standard

For upstream issues, require a small StackBlitz, CodeSandbox, CodePen, or repository. Screenshots and built output are not enough when maintainers need to inspect runtime code paths.

Keep the reproduction focused:

- one adapter;
- pinned dependency versions;
- one signal write;
- one observed stale or unexpected render;
- no unrelated app framework unless the bug is framework-specific.

## Debug Aids

- Add `preact/debug` in Preact apps for development warnings.
- Use `@preact/signals-debug` and the devtools packages when debugging graph behavior.
- In React transform work, set `DEBUG=signals:react-transform:*` to inspect transform decisions.
- Use browser tests for DOM updater behavior; unit tests can miss adapter integration problems.

## References

- Debug package if installed: `node_modules/@preact/signals-debug/README.md` (https://github.com/preactjs/signals/blob/main/packages/debug/README.md)
- Devtools: https://github.com/preactjs/signals/blob/main/packages/devtools-adapter/README.md
