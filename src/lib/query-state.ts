import { useEffect, useRef } from "preact/hooks";
import { useSignalEffect, type Signal } from "@preact/signals";
import { useLocation } from "preact-iso";

export type QueryUpdates = Record<string, string | null | undefined>;

const DASHBOARD_RETURN_URL_KEY = "drydock.dashboard-return-url";

export function buildQueryUrl(updates: QueryUpdates): string {
  const params = new URLSearchParams(window.location.search);
  for (const [key, value] of Object.entries(updates)) {
    if (value === null || value === undefined || value === "") {
      params.delete(key);
    } else {
      params.set(key, value);
    }
  }
  const search = params.toString();
  return window.location.pathname + (search ? `?${search}` : "");
}

export function currentLocationKey(): string {
  return window.location.pathname + window.location.search;
}

export function rememberDashboardReturnUrl(url = currentLocationKey()) {
  if (typeof window === "undefined") return;
  const normalized = normalizeDashboardReturnUrl(url);
  if (normalized) window.sessionStorage.setItem(DASHBOARD_RETURN_URL_KEY, normalized);
}

export function getDashboardReturnUrl(): string {
  if (typeof window === "undefined") return "/dashboard";
  const stored = window.sessionStorage.getItem(DASHBOARD_RETURN_URL_KEY);
  return normalizeDashboardReturnUrl(stored) ?? "/dashboard";
}

function normalizeDashboardReturnUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url, window.location.origin);
    if (parsed.origin !== window.location.origin) return null;
    if (parsed.pathname !== "/dashboard") return null;
    return parsed.pathname + parsed.search;
  } catch {
    return null;
  }
}

export interface QuerySignalOptions<T> {
  /** Query-param name in the URL. */
  name: string;
  /** Map the raw query-string value (undefined when absent) to T. */
  parse: (raw: string | undefined) => T;
  /** Map T back to a string; return null to omit the param. */
  serialize: (value: T) => string | null;
  /** Debounce URL writes by N ms. Useful for text inputs. */
  debounceMs?: number;
}

/**
 * Bridges a Signal<T> to a URL query param. Works with any signal —
 * component-local (`useSignal`) or model-owned (`model.someSignal`).
 *
 * On mount and on every URL change, the signal is set from the URL via
 * `parse`. After mount, signal writes are mirrored to the URL via
 * `serialize` + `replaceState`. The first signal→URL run is skipped so a
 * stale default value doesn't clobber the URL before the URL→signal
 * sync gets a chance to run.
 */
export function useQuerySignal<T>(signal: Signal<T>, options: QuerySignalOptions<T>) {
  const location = useLocation();
  const { name, parse, serialize, debounceMs } = options;
  const skipNextWrite = useRef(true);

  const urlRaw = location.query[name];
  useEffect(() => {
    const parsed = parse(urlRaw);
    if (parsed !== signal.peek()) {
      skipNextWrite.current = true;
      signal.value = parsed;
    }
  }, [urlRaw]);

  useSignalEffect(() => {
    const serialized = serialize(signal.value);
    if (skipNextWrite.current) {
      skipNextWrite.current = false;
      return;
    }
    const write = () => {
      const next = buildQueryUrl({ [name]: serialized });
      if (next !== currentLocationKey()) location.route(next, true);
    };
    if (!debounceMs) {
      write();
      return;
    }
    const timer = window.setTimeout(write, debounceMs);
    return () => window.clearTimeout(timer);
  });
}
