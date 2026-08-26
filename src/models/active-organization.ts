import { signal } from "@preact/signals";

export const ACTIVE_ORG_HEADER = "x-organization-id";
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

export function applyActiveOrganizationFromUrl() {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  const requested = url.searchParams.get(ACTIVE_ORG_QUERY_PARAM);
  if (!requested) return;
  setActiveOrganizationId(requested);
  url.searchParams.delete(ACTIVE_ORG_QUERY_PARAM);
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}
