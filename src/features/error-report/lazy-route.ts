import { lazy } from "preact-iso";

type RouteModule<T> = { default: T };

/**
 * `lazy()` from preact-iso caches a rejected import, and its Router only awaits
 * fulfilment, so a failed chunk load — typically a tab left open across a
 * deploy that removed its hashed assets — silently leaves the previous page or
 * a blank screen. Resolving to a component that rethrows turns the failure
 * into a render error that `AppErrorBoundary` catches, and its Reload fetches
 * the current assets.
 */
export function lazyRoute<T>(load: () => Promise<RouteModule<T>>): T {
  return lazy(surfaceLoadFailure(load));
}

// Load failures are recorded by identity rather than recognised by message:
// each browser words a failed dynamic import differently.
const routeLoadFailures = new WeakSet<object>();

/** Whether `error` is a route chunk that failed to load, as opposed to a page that threw. */
export function isRouteLoadFailure(error: unknown): boolean {
  return typeof error === "object" && error !== null && routeLoadFailures.has(error);
}

export function surfaceLoadFailure<T>(
  load: () => Promise<RouteModule<T>>,
): () => Promise<RouteModule<T>> {
  return () =>
    load().catch((error: unknown) => {
      if (typeof error === "object" && error !== null) routeLoadFailures.add(error);
      const rethrow = () => {
        throw error;
      };
      return { default: rethrow as T };
    });
}
