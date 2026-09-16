import { useSignal, type ReadonlySignal } from "@preact/signals";
import { useEffect } from "preact/hooks";

/**
 * A wall-clock signal that ticks every `intervalMs`, for "checked 2 minutes
 * ago" style labels. Read it inside the computed or component that renders the
 * label so the tick re-renders only that subscriber.
 */
export function useNow(intervalMs: number): ReadonlySignal<number> {
  const now = useSignal(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => {
      now.value = Date.now();
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}
