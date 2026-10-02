import { useLayoutEffect, type Inputs } from "preact/hooks";

/**
 * An effect for async work whose result must be dropped once its component
 * leaves the tree: a session check or resolver that lands after a route change
 * must not route, redirect, or write state the user has already navigated away
 * from. `isCancelled()` turns true when `deps` change or the component unmounts.
 *
 * It runs as a layout effect because Preact 11 defers `useEffect` cleanup on
 * unmount until after the next paint, which leaves a `cancelled` flag false for
 * a frame, and for longer in a background tab where requestAnimationFrame is
 * paused. Layout-effect cleanup still runs synchronously on unmount.
 */
export function useCancellableEffect(
  effect: (isCancelled: () => boolean) => void,
  deps: Inputs,
): void {
  useLayoutEffect(() => {
    let cancelled = false;
    effect(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, deps);
}
