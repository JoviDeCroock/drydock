import { useEffect, useLayoutEffect, useRef, type Inputs } from "preact/hooks";

/**
 * A `useEffect` for async work whose result must be dropped once its run is
 * over: `isCancelled()` turns true when `deps` change or the component
 * unmounts, so a late session check or resolver cannot route away from, or
 * write into, a page that has already gone. A route change alone does not
 * count: preact-iso keeps the previous route mounted while the next route's
 * chunk loads.
 *
 * The work stays in the passive phase, in order with the component's other
 * effects. Only the cancellation moves to a layout cleanup, because Preact 11
 * defers passive cleanup on unmount until after the next paint (longer in a
 * background tab, where requestAnimationFrame is paused) while layout cleanup
 * still runs synchronously.
 */
export function useCancellableEffect(
  effect: (isCancelled: () => boolean) => void,
  deps: Inputs,
): void {
  const run = useRef({ cancelled: false });
  useLayoutEffect(() => {
    const current = { cancelled: false };
    run.current = current;
    return () => {
      current.cancelled = true;
    };
  }, deps);
  useEffect(() => {
    const current = run.current;
    effect(() => current.cancelled);
  }, deps);
}
