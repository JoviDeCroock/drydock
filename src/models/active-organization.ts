import { signal } from "@preact/signals";

export const ACTIVE_ORG_HEADER = "x-organization-id";
// Mirrors server/lib/auth/active-organization.ts: ask the server to refuse a
// selector the caller is not a member of instead of falling back.
export const ACTIVE_ORG_STRICT_HEADER = "x-organization-strict";
const STORAGE_KEY = "drydock:active-organization-id";
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
  } catch {}
}

/**
 * The organization a page's URL names (`?org=`), while that page is open.
 * Every request the page and its sections make carries it as the active
 * organization, strictly: a non-member gets a 403, never another organization's
 * data. Null on pages whose organization is simply the remembered one.
 */
export const pinnedOrganizationId = signal<string | null>(null);

export function pinOrganization(id: string) {
  if (activeOrganizationId.peek() !== id) setActiveOrganizationId(id);
  if (pinnedOrganizationId.peek() !== id) pinnedOrganizationId.value = id;
}

export function unpinOrganization() {
  pinnedOrganizationId.value = null;
}

export function applyActiveOrganizationFromUrl() {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  const requested = url.searchParams.get(ACTIVE_ORG_QUERY_PARAM);
  if (!requested) return;
  setActiveOrganizationId(requested);
  url.searchParams.delete(ACTIVE_ORG_QUERY_PARAM);
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}
