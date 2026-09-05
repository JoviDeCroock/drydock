---
name: preact-signals-no-eager-unwrap
description: Write or refactor signal-backed JSX with Show, computed values, and direct bindings while preserving live props and component contracts.
---

# Signal rendering boundaries

Preserve behavior while moving subscriptions to the smallest scope that needs them. A `.value` read in render subscribes that component. Event-handler reads and plain-value API boundaries are different; do not mechanically remove every read.

| Render use | Preferred boundary |
| --- | --- |
| Signal-backed conditional | `<Show when={condition} fallback={...}>...</Show>` |
| Derived/negated condition | `Show` with `when={() => ...}` or a computed signal |
| Text or supported DOM attribute mirrors a signal | Pass the signal directly |
| Text/attribute derived from signals | `useComputed`, then pass the computed signal |
| Component prop requiring a plain snapshot | Keep the value read at that contract boundary |

## Conditional children

```tsx
import { Show } from "@preact/signals/utils";

<Show when={error}>
  {(message) => <Alert tone="critical">{message}</Alert>}
</Show>

<Show when={loading} fallback="Save">Saving…</Show>
```

Do not pass `when={signal.value}`. Move reads in the old branch into the intended boundary: a function child, child component, computed, or direct binding. Plain JSX children are evaluated by the parent, so leaving their reads there defeats the move. Cached `Show`/`For` children must not rely on unrelated plain parent values to refresh.

For a thunk condition with ambiguous generic inference, use a typed computed or an explicit `Show<T>`. Check falsey behavior during conversion: `count.value && <X/>` displays `0` for zero, while `Show` selects its fallback.

## Derivations and prop contracts

```tsx
const inputMode = useComputed(() => (useBackup.value ? "text" : "numeric"));
<Input inputmode={inputMode} />
```

A computed tracks signals, not changes to a captured plain prop. Keep the component read when it owns that update, or make the changing input reactive using `useLiveSignal`. A lint-clean extraction can still leave a stale prop.

Native DOM attributes and primitives that forward them (such as `Input` and `Button`) support direct signals. Inspect other components' prop types and implementation: a plain-value `Select` or `Dialog` contract still needs `.value`. Widen a primitive only when its intended API should support a live signal.

The local `signals-local/no-signal-conditional-jsx` rule covers local signal conditions in JSX child position; it does not prove member-access/model signals or prop flows are correct. Rule ownership and fixtures are in `docs/tooling.md`. Use [Signals lint](../preact-signals-eslint-plugin/SKILL.md) when changing or diagnosing lint, rather than loading it for every JSX edit.
