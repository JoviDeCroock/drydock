import { computed, signal } from "@preact/signals";
import { activeOrganizationId } from "./active-organization";

/**
 * Whether the dashboard's getting-started funnel is finished for an
 * organization, in this browser.
 *
 * Two things finish it and both land here: the reader dismissing the panel, and
 * the funnel completing (a first decision recorded). Completion is stored for
 * the same reason dismissal is — an organization that is past onboarding should
 * not pay for the "has anything been decided?" probe on every dashboard load.
 *
 * "Done" means "do not open this panel again", not "hide it right now": the
 * panel that is already on screen when the last step ticks stays up so the tick
 * can be seen. The session-scoped open latch below outlives the dashboard route,
 * so a reader can open the scan, decide, and return to see that final tick.
 *
 * Keyed by organization because the funnel is per-organization: someone who has
 * onboarded one organization and then creates a second still needs the panel
 * there. It is a UI convenience with no server meaning, so localStorage is the
 * right home — nothing to sync, nothing to migrate, nothing worth a column.
 */
const STORAGE_KEY = "drydock:getting-started-done";

function readStored(): Record<string, true> {
  if (typeof localStorage === "undefined") return {};
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return {};
  }
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const entries = Object.entries(parsed as Record<string, unknown>).filter(
      ([, value]) => value === true,
    );
    return Object.fromEntries(entries) as Record<string, true>;
  } catch {
    return {};
  }
}

// Organizations finished in this session. Writes go to both here and storage:
// this signal is what makes the computed below reactive (so the module needs no
// import-time read, and stays testable without module resets), and it is also
// the fallback when localStorage is blocked and the write silently does nothing.
const doneThisSession = signal<Record<string, true>>({});

// The active organization can be unknown — the organizations request failed,
// say. Dismissing still has to work, but there is no key to file it under and
// nothing worth persisting, so that case is tracked separately and for this
// session only.
const doneWithoutOrganization = signal(false);

// `undefined` means closed; `null` is a real latch for the rare state where the
// active organization could not be resolved. Keeping this outside the dashboard
// component preserves an open panel while the reader visits a scan detail page.
const openForOrganization = signal<string | null | undefined>(undefined);

export const gettingStartedDone = computed<boolean>(() => {
  const session = doneThisSession.value;
  const withoutOrganization = doneWithoutOrganization.value;
  const organizationId = activeOrganizationId.value;
  if (!organizationId) return withoutOrganization;
  return session[organizationId] === true || readStored()[organizationId] === true;
});

export const gettingStartedPanelOpen = computed<boolean>(() => {
  const organizationId = openForOrganization.value;
  const activeId = activeOrganizationId.value;
  return organizationId !== undefined && organizationId === activeId;
});

export function openGettingStartedPanel(organizationId: string | null): void {
  openForOrganization.value = organizationId;
}

export function closeGettingStartedPanel(): void {
  openForOrganization.value = undefined;
}

/**
 * Stop opening the getting-started panel for the active organization. Called by
 * the panel's dismiss control and when the funnel's last step ticks.
 */
export function markGettingStartedDone(): void {
  const organizationId = activeOrganizationId.peek();
  if (!organizationId) {
    doneWithoutOrganization.value = true;
    return;
  }
  doneThisSession.value = { ...doneThisSession.peek(), [organizationId]: true };
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...readStored(), [organizationId]: true }));
  } catch {
    // Storage may be blocked; the in-session map above still holds for this tab.
  }
}
