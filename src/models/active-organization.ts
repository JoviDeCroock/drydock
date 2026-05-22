import { signal } from "@preact/signals";

export const ACTIVE_ORG_HEADER = "x-organization-id";
const STORAGE_KEY = "drydock:active-organization-id";

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
