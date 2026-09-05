---
name: preact-signals-models-utils
description: Design or debug Drydock signal models, action boundaries, constructor inputs, useModel lifetime, and disposal.
---

# Signal models and lifetime

Use a model when state and its actions form a cohesive unit. Keep a single independent value in a signal. Models expose signals and actions, including nested signal/action objects, so consumers retain control of subscription boundaries.

```tsx
import { createModel, signal, computed, useModel } from "@preact/signals";

const CountModel = createModel((initialCount: number) => {
  const count = signal(initialCount);
  const double = computed(() => count.value * 2);
  return {
    count,
    double,
    increment() {
      count.value++;
    },
  };
});

function Counter() {
  const model = useModel(() => new CountModel(5));
  return <button onClick={model.increment}>{model.double}</button>;
}
```

`createModel` wraps actions as batched and untracked calls. `useModel` owns an instance for the component lifetime and disposes it on unmount. A no-argument constructor can be passed directly; wrap constructors with arguments in a factory.

## Inputs and async state

Changing the factory passed to `useModel` does not recreate the model. Constructor arguments are initial snapshots unless they are reactive inputs. If a model must follow future input changes, accept a signal and read it in a computed/effect. If the parent may replace the signal object, adapt it with `useLiveSignal` from `@preact/signals/utils` before handing it to the long-lived model.

Keep derived state in computed signals and writes in actions/effects. Async methods should keep data, loading, and error state coherent; account for overlapping requests or disposal when the flow permits them. Do not assume batching or dependency tracking spans an `await`.

For rendering and `Show`/`For` child caching, use [Preact integration](../preact-signals-preact-integration/SKILL.md). Inspect the installed `node_modules/@preact/signals/README.md` and source/types when lifecycle or action semantics matter; do not infer them from a React utility example.
