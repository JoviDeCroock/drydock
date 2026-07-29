import { signal } from "@preact/signals";

// Reviewers who publish from npm's web UI open the staged-packages page after
// every decision. Remembering the choice per browser turns a repeated click into
// a one-time one; it is a UI convenience only, so localStorage is the right home
// (no server state, nothing org-scoped, nothing worth syncing across devices).
const STORAGE_KEY = "drydock:open-npm-after-decision";

function readStored(): boolean {
  if (typeof localStorage === "undefined") return false;
  try {
    return localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export const openNpmAfterDecision = signal<boolean>(readStored());

export function setOpenNpmAfterDecision(next: boolean) {
  openNpmAfterDecision.value = next;
  if (typeof localStorage === "undefined") return;
  try {
    if (next) localStorage.setItem(STORAGE_KEY, "true");
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // localStorage may be blocked; the in-memory signal still holds for this session.
  }
}
