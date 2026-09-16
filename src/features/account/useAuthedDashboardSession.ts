import { useEffect } from "preact/hooks";
import { useSignal, type ReadonlySignal } from "@preact/signals";
import { useLocation } from "preact-iso";
import { rememberDashboardReturnUrl } from "../../lib/query-state";
import { sessionModel, type AuthSession } from "../../models/auth";

/** Where an unauthenticated visit to `url` is sent, so signing in returns there. */
export function loginRedirectPath(url: string): string {
  return `/login?returnTo=${encodeURIComponent(url)}`;
}

/**
 * The session guard every authenticated dashboard page runs on mount: load the
 * session, bounce to `/login` (keeping the destination in `returnTo`) when
 * there is none, and only then run the page's own organization-scoped loads.
 *
 * `onReady` receives `isCancelled` because the page's loads usually chain
 * across several awaits; checking it between them keeps a route change from
 * writing a stale response into a model that is about to be disposed.
 * `deps` re-runs the whole guard, which a detail page keys on its route param.
 */
export function useAuthedDashboardSession({
  onReady,
  deps = [],
  rememberReturnUrl = true,
}: {
  onReady?: (session: AuthSession, isCancelled: () => boolean) => void | Promise<void>;
  deps?: unknown[];
  // The list surfaces remember themselves as the review's back link; a detail
  // page must not, or its own URL would become the place "back" leads.
  rememberReturnUrl?: boolean;
}): ReadonlySignal<boolean> {
  const location = useLocation();
  const sessionChecked = useSignal(false);

  useEffect(() => {
    if (rememberReturnUrl) rememberDashboardReturnUrl(location.url);
  }, [location.url, rememberReturnUrl]);

  useEffect(() => {
    let cancelled = false;
    const isCancelled = () => cancelled;
    void (async () => {
      const session = await sessionModel.load();
      if (cancelled) return;
      if (!session) {
        location.route(loginRedirectPath(location.url), true);
        return;
      }
      sessionChecked.value = true;
      await onReady?.(session, isCancelled);
    })();
    return () => {
      cancelled = true;
    };
  }, deps);

  return sessionChecked;
}
