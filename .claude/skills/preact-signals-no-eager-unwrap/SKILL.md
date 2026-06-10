---
name: preact-signals-no-eager-unwrap
description: Use when writing or reviewing Preact components that render signals — to avoid eagerly unwrapping `signal.value` in the component body for conditional rendering, text nodes, or attributes. Covers Show/Show-fallback, direct signal rendering, useComputed for derivations, the DOM-attribute vs plain-prop distinction, and the local `signals-local/no-signal-conditional-jsx` lint rule.
---

# Preact Signals: don't eagerly unwrap

## Core idea

Reading `signal.value` in a component body subscribes the **whole component**, so any
change re-renders everything — even parts that didn't change. Unbox as late as possible:
push the read down to a `<Show>` boundary, a `useComputed`, or a direct DOM/text binding so
only the affected subtree updates. See [`preact-signals-preact-integration`] for the
underlying "unbox late" model.

"Eager unwrapping" is any `signal.value` read in the render body used only to feed JSX:
a conditional, a text node, or an attribute. Each one has a tighter replacement.

## The four anti-patterns and their fixes

| You wrote | Replace with | Why |
| --- | --- | --- |
| `{cond.value ? <A/> : <B/>}` / `{cond.value && <A/>}` | `<Show when={cond} fallback={<B/>}>…</Show>` | conditional rendering → boundary component |
| `{cond.value ? "Saving…" : "Save"}` (text) | `<Show when={cond} fallback="Save">Saving…</Show>` | a two-way toggle is still conditional rendering |
| `{count}` where `count` is `count.value` only as a text child | `{count}` (pass the signal) | Preact owns the text-node subscription |
| `{format(size.value)}` / `{trigger(open.value)}` (a derivation) | `const text = useComputed(() => format(size.value)); {text}` | a single derivation → computed, rendered directly |
| `<input value={name.value} />` (DOM / `Input` / `Button`) | `<input value={name} />` | direct DOM binding, no component re-render |
| `disabled={busy.value ? a : b}` (attribute, can't host `<Show>`) | `const d = useComputed(() => busy.value ? a : b); disabled={d}` | attribute-position derivation → computed |

The headline mistake is the first row. There's a lint rule for it (below).

## Conditional rendering → `<Show>`

```tsx
import { Show } from "@preact/signals/utils";

// ❌ eager: the component re-renders whenever `error` changes
{error.value ? <Alert tone="critical">{error.value}</Alert> : null}

// ✅ only the <Show> boundary re-renders; the child fn receives the unwrapped value
<Show when={error}>{(message) => <Alert tone="critical">{message}</Alert>}</Show>

// ✅ two-way / else branch via fallback
<Show when={loading} fallback="Save">Saving…</Show>

// ✅ derived condition → thunk (NOT `when={derivedBoolean.value}`)
<Show when={() => items.value.length > 0}>{() => <List items={items.value} />}</Show>
```

Rules of thumb:

- `when={signal}` when the condition is exactly a signal's truthiness. `when={() => …}` for a
  derived/compound/negated condition. Never `when={signal.value}` — that unwraps in the parent.
- **Move every signal read that was inside the branch into the boundary** — use a function child
  `{(v) => …}`, a `useComputed`, or pass the signal directly. If you leave `{x.value}` in plain
  (non-function) children, it reads in the *parent* render and the read goes stale once the parent
  stops re-rendering. `<Show>` only re-runs children when `when` re-runs.
- `Show`'s child function receives `NonNullable<T>` of the `when` value, so
  `when={user}` (a `Signal<User | null>`) gives you `(user: User) => …`.

## A single derivation → `useComputed` (not `<Show>`)

A `<Show>` is for *choosing what to render*. A value you compute from a signal and render once
is a derivation — lift it into a `useComputed` and render the computed directly:

```tsx
// ❌ reads open.value in the body
{trigger(open.value)}

// ✅ the computed reads it inside its own boundary
const triggerContent = useComputed(() => trigger(open.value));
{triggerContent}
```

This also covers attribute-position derivations, which can't host a `<Show>`:

```tsx
const inputMode = useComputed(() => (useBackup.value ? "text" : "numeric"));
<Input inputmode={inputMode} />
```

⚠️ Don't wrap a derivation that closes over a **plain prop** in `useComputed` — the computed only
recomputes when its tracked *signals* change, so a changed prop goes stale. Either read the prop
in the body (accept the re-render) or make it reactive with `useLiveSignal`.

## Text and attribute nodes → pass the signal

When a signal is only displayed/bound, pass the box, not the value:

```tsx
<p>{name}</p>                  // not {name.value}
<input value={name} />         // not value={name.value}
<button disabled={busy} />     // not disabled={busy.value}
<button aria-expanded={open} />
```

**This only works for DOM elements and components that spread to a DOM node** (in this repo:
`Input`, `Button` — both spread `...props` onto a real element, and `@preact/signals` augments
JSX so DOM attributes accept `Signal<T>`).

It does **not** work for components with plain-typed props that read the value themselves:

- `Select` (`value: string`), `Dialog` (`open: boolean`) — passing a signal is a type error and
  wouldn't be reactive. Leave these as `.value` reads.
- If a primitive *should* take a signal, widen its prop to `ComponentChildren` / `Signal<T>`
  rather than unwrapping at every call site (e.g. `Field`'s `label` was widened to
  `ComponentChildren` so it can take a computed).

## Gotchas

- **`Show` generic inference** fails through a thunk `when` + a typed function child (you get
  `Object`). Drive those `Show`s from a `useComputed` instead — the `Signal<T>` form infers
  cleanly: `const at = useComputed(() => …number|null…); <Show when={at}>{(at) => …}</Show>`.
  Or annotate explicitly: `<Show<Foo | null> when={() => …}>`.
- **`no-conditional-value-read`** fires if a `useComputed` reads `signal.value` behind a guard
  that doesn't itself read a signal (e.g. `if (!localVar) … signal.value`). Read every signal
  **unconditionally at the top** of the computed, then branch on the locals.
- **`&&` with a numeric signal**: `{count.value && <X/>}` renders `0` when count is 0;
  `<Show when={count}>` correctly renders the fallback instead. Converting fixes the footgun.
- **Models / member-access signals** (`model.count.value`) are caught by these same patterns, but
  the lint rule below can't *detect* them (no type info under oxlint) — apply by hand.

## Lint rule

`signals-local/no-signal-conditional-jsx` (local plugin in
`tooling/oxlint/signals-local/`, wired through `jsPlugins` in `.oxlintrc.json`) flags conditional
rendering — ternary or `&&`/`||`/`??` in JSX child position — whose condition reads a **local**
signal's `.value`. It does not flag attribute positions (no `<Show>` there) or single derivations.
Run `pnpm run lint`. Fixture + test: `test/fixtures/oxlint-signals/` and
`test/oxlint-signal-conditional-jsx.test.mjs`.

## References

- [`preact-signals-preact-integration`] — unboxing boundaries, `Show`/`For`, DOM optimization.
- [`preact-signals-models-utils`] — `createModel`/`useModel`, passing signals without unwrapping.
- [`preact-signals-eslint-plugin`] — the upstream correctness rules these conventions complement.
