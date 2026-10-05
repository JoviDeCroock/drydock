import type { ComponentChildren } from "preact";
import { useRef } from "preact/hooks";
import { LocationProvider, useLocation, useRoute, type RouteProps } from "preact-iso";

type LocationHook = ReturnType<typeof useLocation>;

/**
 * preact-iso's `Route`, with the page's location scoped to the route.
 *
 * The Router keeps the page being left mounted until the next route's lazy
 * chunk arrives. Through `useLocation` that page would otherwise re-render
 * against the next page's URL (an invite reading its token from `/login`), and
 * its late writes (a `?path=` sync, a resolver's redirect) would land on the
 * next page. Inside a scoped route the page keeps the location it was last
 * current for, and `route()` is dropped once the browser has moved to another
 * path, which also covers a late callback that captured `location` earlier.
 */
export function ScopedRoute(props: RouteProps<Record<string, unknown>>) {
  const Component = props.component;
  return (
    <RouteLocationScope>
      <Component {...props} />
    </RouteLocationScope>
  );
}

function RouteLocationScope({ children }: { children: ComponentChildren }) {
  const live = useLocation();
  // The Router hands the page being left its last match, so this is the path
  // the route was rendered for, and only differs from `live.path` once the
  // browser has started navigating to another route.
  const { path } = useRoute();
  const scoped = useRef<{ live: LocationHook; value: LocationHook } | null>(null);
  if (live.path === path && scoped.current?.live !== live) {
    scoped.current = { live, value: { ...live, route: routeWhileAt(path, live.route) } };
  }
  return (
    <LocationProvider.ctx.Provider value={scoped.current?.value ?? live}>
      {children}
    </LocationProvider.ctx.Provider>
  );
}

function routeWhileAt(path: string, route: LocationHook["route"]): LocationHook["route"] {
  return (url, replace) => {
    // `window.location` moves synchronously on a link click, `route()`, or
    // Back/Forward, before the Router re-renders; matches preact-iso's `path`.
    const browserPath = window.location.pathname.replace(/\/+$/g, "") || "/";
    if (browserPath === path) route(url, replace);
  };
}
