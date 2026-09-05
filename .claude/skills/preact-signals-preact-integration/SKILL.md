---
name: preact-signals-preact-integration
description: Choose Preact signal ownership and subscription boundaries in components, props, context, effects, and cached Show/For children.
---

# Preact signal integration

Use this skill for component integration. For model lifetime/actions, read [models and utilities](../preact-signals-models-utils/SKILL.md); for a rendering rewrite, read [no eager unwrap](../preact-signals-no-eager-unwrap/SKILL.md). Load the one that owns the question.

Use `useSignal`, `useComputed`, and `useSignalEffect` for component-local signal lifetime. Calling `signal()`, `computed()`, or `effect()` directly in render recreates state/subscriptions. Ordinary factories and model constructors can use the non-hook APIs.

## Choose the subscription owner

A `.value` read subscribes the active reactive scope. Pass a signal through props/context when the consumer should own that subscription; render `{signal}` for direct text updates or bind it to a supported DOM attribute. Read a snapshot when an API requires a plain value or the component actually owns the render decision.

A signal passed to a component is an object, not an automatically unwrapped prop. Inspect the receiver: DOM-forwarding primitives can preserve direct binding, while a component with a plain `boolean` or `string` contract needs the value. Keep context models stable rather than constructing plain aggregates that subscribe the provider.

`Show` and `For` cache children; arbitrary plain parent values captured by those children are not live dependencies. Pass signals through to a child component or put reads inside the intended reactive boundary. A changed signal value and a replaced signal object are different updates: use `useLiveSignal` from `@preact/signals/utils` when a long-lived consumer must track replacement inputs.

Update signal arrays/objects by assigning a new reference. Keep computed callbacks free of writes and effects. Check that subscriptions/resources follow their owner lifetime and dispose imperative subscriptions when that lifetime ends.

For API details, inspect the installed repository dependency's `node_modules/@preact/signals/README.md` and source/types. This repository uses the Preact adapter; React adapter restrictions and examples are not interchangeable.
