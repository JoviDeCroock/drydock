import { useSignal, useComputed } from "@preact/signals";
import type { Signal } from "@preact/signals";

// --- Should be flagged: conditional rendering driven by a signal ----------

export function TernaryNull() {
  const error = useSignal<string | null>(null);
  return <div>{error.value ? <span>{error.value}</span> : null}</div>;
}

export function TernaryBothJsx() {
  const authed = useSignal(false);
  return <div>{authed.value ? <a>dash</a> : <a>login</a>}</div>;
}

export function LogicalAnd() {
  const open = useSignal(false);
  return <div>{open.value && <section>panel</section>}</div>;
}

export function DerivedNegation() {
  const loading = useSignal(false);
  return <div>{!loading.value ? <span>ready</span> : null}</div>;
}

export function DerivedComparison() {
  const items = useSignal<number[]>([]);
  return <div>{items.value.length > 0 && <ul>list</ul>}</div>;
}

export function ComputedDriven() {
  const count = useSignal(0);
  const hasItems = useComputed(() => count.value > 0);
  return <div>{hasItems.value ? <ul>list</ul> : null}</div>;
}

export function SignalProp({ flag }: { flag: Signal<boolean> }) {
  return <div>{flag.value ? <b>on</b> : null}</div>;
}

// Conditional *text* is flagged too — the fix is the same `<Show fallback>`.
export function ConditionalText() {
  const loading = useSignal(false);
  return <button>{loading.value ? "Saving…" : "Save"}</button>;
}

// --- Should NOT be flagged -------------------------------------------------

// Plain (non-signal) condition.
export function PlainBoolean({ folder }: { folder: boolean }) {
  return <div>{folder ? <span>dir</span> : null}</div>;
}

// The *test* is non-reactive; a branch merely selects a signal value. This is a
// value selection, not signal-driven conditional rendering.
export function ValueSelection({ useError }: { useError: boolean }) {
  const error = useSignal("");
  return <div>{useError ? error.value : "ok"}</div>;
}

// Signal condition but in an attribute position (cannot host a <Show>).
export function AttributeTernary() {
  const loading = useSignal(false);
  return <input disabled={loading.value ? true : false} />;
}

// Signal rendered directly — the good pattern.
export function DirectSignal() {
  const name = useSignal("Ada");
  return <div>{name}</div>;
}
