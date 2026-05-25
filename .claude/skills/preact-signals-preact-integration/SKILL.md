---
name: preact-signals-preact-integration
description: Use when working with @preact/signals in Preact components, including useSignal, useComputed, useSignalEffect, signal unboxing/subscription boundaries, direct JSX signal rendering, DOM attribute optimization, passing signals through props or context, Show, For, useLiveSignal, and rerender behavior.
---

# Preact Signals Preact Integration

## Core Approach

In Preact, a signal is a stable box around a value. Reading `signal.value` during component render unboxes it and subscribes that component. Passing the signal object itself through props or context does not subscribe intermediate components. Passing a signal object directly as JSX text or a supported DOM attribute lets Preact own the subscription and update the DOM directly.

Use the latest unboxing point that is still correct:

| Pattern | Subscription / update boundary | Use when |
| --- | --- | --- |
| `{state.value}` in a component | The component rerenders | The component must branch, derive, or pass a plain snapshot |
| `{state}` as JSX text | The text node updates directly | The value is only displayed as text |
| `<input value={state}>` on DOM nodes | The DOM property updates directly | The property mirrors signal state |
| `<Child state={state}>` | No subscription in the parent | The child should decide how granular updates are |
| Context provides `state` | No subscription in the provider | Distant consumers should subscribe only where used |

## Component State

Create component-local signals with hooks, not `signal()` in render:

```tsx
import { useSignal, useComputed, useSignalEffect } from "@preact/signals";

function Counter() {
  const count = useSignal(0);
  const double = useComputed(() => count.value * 2);

  useSignalEffect(() => {
    console.log(count.value);
  });

  return <button onClick={() => count.value++}>{double}</button>;
}
```

Calling `signal()` in a component body creates a new signal on every render — use `useSignal()` so the signal persists across renders.

## Rendering Choices

Use `.value` when component rerender semantics are desired:

```tsx
function Counter() {
  return <p>Count: {count.value}</p>;
}
```

Pass the signal directly when direct DOM updates are desired:

```tsx
function Counter() {
  return <p>Count: {count}</p>;
}
```

Preact also supports experimental direct signal DOM attributes:

```tsx
const inputValue = signal("Ada");

function NameField() {
  return <input value={inputValue} onInput={e => (inputValue.value = e.currentTarget.value)} />;
}
```

Do not apply the React adapter limitation to Preact; React does not support signal DOM attributes, but Preact does.

Direct DOM prop optimization only applies to DOM elements. Passing a signal to a component prop just passes the signal object; the child must either render `{signal}` directly or read `signal.value`.

## Props And Context

Prefer passing signals over plain values when the receiver needs live state:

```tsx
import type { Signal } from "@preact/signals";

function Toolbar({ disabled }: { disabled: Signal<boolean> }) {
  return <button disabled={disabled}>Run</button>;
}
```

Avoid this when it only unwraps state to rewrap the same dependency in a child:

```tsx
// Over-eager: parent subscribes and rerenders before the leaf can update.
<Toolbar disabled={disabled.value} />
```

Use plain values when the receiver truly needs a snapshot, cannot accept `Signal<T>`, or should rerender as part of the parent's render contract.

Context should carry signal objects or models containing signals, not freshly-created plain objects that read `.value` in the provider:

```tsx
// Good: consumers choose their own subscription boundary.
<SessionContext.Provider value={sessionModel}>{children}</SessionContext.Provider>
```

If a consumer receives a signal prop whose identity can be replaced by the parent, use `useLiveSignal()` before storing it in a long-lived model.

## Show And For

`Show` and `For` optimize around signals. They should not be used to smuggle non-signal parent values into cached children.

```tsx
const showDetails = useSignal(false);
const items = useSignal<Item[]>([]);

function App() {
  return (
    <For each={items}>
      {item => <Item item={item} showDetails={showDetails} />}
    </For>
  );
}

function Item({ item, showDetails }: { item: Item; showDetails: Signal<boolean> }) {
  return <li>{item.id}{showDetails.value && ` - ${item.createdAt}`}</li>;
}
```

If existing `For` children do not react to parent values, pass signals down or lift the child into a component. That behavior is intentional — rerendering on arbitrary non-signal changes would remove much of `For` and `Show`'s value.

## useLiveSignal

Use `useLiveSignal` when a component receives a signal reference that may itself change, or when a one-time model constructor needs a live reactive input:

```tsx
import { useLiveSignal } from "@preact/signals/utils";

function Detail({ selected }: { selected: Signal<string> }) {
  const liveSelected = useLiveSignal(selected);
  const model = useModel(() => new DetailModel(liveSelected));
  return <DetailView model={model} />;
}
```

This guards against stale signal references when the parent swaps which signal it passes in.

## Common Mistakes

- Using `signal()` inside a component body instead of `useSignal()`.
- Expecting object property mutation to notify subscribers.
- Assuming `For` reruns children for non-signal parent variables.
- Reading `.value` in JSX when direct text-node optimization was intended.
- Passing direct signal DOM attributes in React because it worked in Preact.

## References

- Package docs: `node_modules/@preact/signals/README.md`
- Online: https://github.com/preactjs/signals/blob/main/packages/preact/README.md
- Utilities are documented in the same package README and online package README.
