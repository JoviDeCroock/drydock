/**
 * The active organization's log of unapproved publishes: every publication
 * alert in its ledger, across all packages it watches or has watched, newest
 * first. Read-only; acknowledging and reviewing stay on the watch rows.
 */
import { createModel, effect, signal } from "@preact/signals";
import { activeOrganizationId } from "./active-organization";
import { apiFetch, errorMessage } from "./api";
import type { PublicationAlertRecord } from "./package-publication";
import type { PostReleaseBadgeEffect } from "./publication-watches";

export interface PublicationAlertLogEntry extends Omit<PublicationAlertRecord, "inCurrentWatch"> {
  packageName: string;
  /** Whether the post-release decision counts on the public badge, and if not, why. */
  resolutionBadge: PostReleaseBadgeEffect | null;
  /** The package is still watched; the ledger outlives a stopped watch. */
  watched: boolean;
}

export const publicationAlertLogApiPath = "/api/v1/publication-watches/alerts";

export const PublicationAlertLogModel = createModel(() => {
  const alerts = signal<PublicationAlertLogEntry[]>([]);
  const more = signal(false);
  const loaded = signal(false);
  const error = signal<string | null>(null);
  // Only the latest request lands: a refresh after an acknowledgment must not
  // be overwritten by an older one, nor one organization's log by another's.
  let generation = 0;

  async function refresh(): Promise<void> {
    const current = ++generation;
    try {
      const data = await apiFetch<{ alerts: PublicationAlertLogEntry[]; moreAlerts: boolean }>(
        publicationAlertLogApiPath,
      );
      if (current !== generation) return;
      alerts.value = data.alerts;
      more.value = data.moreAlerts;
      error.value = null;
    } catch (err) {
      if (current === generation) error.value = errorMessage(err);
    } finally {
      if (current === generation) loaded.value = true;
    }
  }

  effect(() => {
    void activeOrganizationId.value;
    generation++;
    alerts.value = [];
    more.value = false;
    loaded.value = false;
    error.value = null;
    return () => {
      generation++;
    };
  });

  return { alerts, more, loaded, error, refresh };
});
