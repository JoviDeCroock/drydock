import { signal } from "@preact/signals";

export const ACTIVE_ORG_HEADER = "x-organization-id";
const STORAGE_KEY = "drydock:active-organization-id";
// Notification emails deep-link with `?org=<id>` so a link opens the organization
// the alert is about — not whichever org this browser last had active.
const ACTIVE_ORG_QUERY_PARAM = "org";

function readStored(): string | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export const activeOrganizationId = signal<string | null>(readStored());

export function setActiveOrganizationId(id: string | null) {
  activeOrganizationId.value = id;
  if (typeof localStorage === "undefined") return;
  try {
    if (id) localStorage.setItem(STORAGE_KEY, id);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // localStorage may be blocked; in-memory signal still updates.
  }
}

/**
 * Adopt an `?org=<id>` deep-link into the stored active organization, then strip
 * the param from the URL. Notification emails append it so their links (Settings,
 * a scan report, a release gate) land on the organization the email is about
 * rather than whatever org this browser last used.
 *
 * The id is trusted only as an optimistic starting point: it sets the header the
 * next request sends, and `OrganizationModel.load()` re-points to a real
 * membership if it isn't one the user belongs to. We drop the param afterwards so
 * a later list reload (rename, delete, gate refresh) can't snap the org back to
 * the link's value after the user has switched away. No-op outside the browser
 * and when the param is absent.
 */
export function applyActiveOrganizationFromUrl() {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  const requested = url.searchParams.get(ACTIVE_ORG_QUERY_PARAM);
  if (!requested) return;
  setActiveOrganizationId(requested);
  url.searchParams.delete(ACTIVE_ORG_QUERY_PARAM);
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}
