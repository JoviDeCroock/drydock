import type { ReadonlySignal } from "@preact/signals";

export type SignalOrValue<T> = T | ReadonlySignal<T>;

/**
 * Reads a prop that a caller may pass either as a plain value or as a signal.
 * Calling this inside a component's render makes that component the
 * subscriber, which is the point: a dialog that reads its own `open`/`status`
 * signals re-renders alone instead of the page that mounts it.
 */
export function readSignalProp<T>(value: SignalOrValue<T>): T {
  return isSignal(value) ? value.value : value;
}

function isSignal<T>(value: SignalOrValue<T>): value is ReadonlySignal<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    "value" in value &&
    "peek" in value &&
    typeof (value as { peek?: unknown }).peek === "function"
  );
}
