import type { AppDb } from "../../../db/client";
import {
  claimPublicationAlertDelivery,
  listUnnotifiedPublicationAlerts,
  markPublicationAlertNotified,
  releasePublicationAlertClaim,
  type PublicationAlertStatus,
} from "../../../db/publication-alerts";
import {
  claimReleaseCoverageNotice,
  getPublicationWatch,
  claimWatchCoverageNotice,
  listUnnotifiedReleaseCoverageGaps,
  releaseReleaseCoverageNotice,
  releaseWatchCoverageNotice,
} from "../../../db/publication-watches";
import { npmPublicationRegistry } from "./publication-registry";
import { notifyPublicationCoverageGap, notifyPublicationDiscrepancy } from "../../notify";
import type { NotificationDeliveryOutcome } from "../../notify/deliver";
import { emitOperationalEvent } from "../../platform/observability";

// Longer than any single delivery (email plus a Slack post with its own
// timeout), so only a delivery that died holds a claim past it.
const ALERT_DELIVERY_LEASE_MS = 5 * 60_000;

type Watch = { id: string; organizationId: string; packageName: string };

export interface PendingAlert {
  version: string;
  status: PublicationAlertStatus;
  reason: string | null;
}

/**
 * Whether a delivery settled the notice: some channel accepted it, or the
 * organization has nowhere to send it (logged, because retrying cannot help).
 * `failed` leaves it for a later check.
 */
async function settles(
  env: Cloudflare.Env,
  db: AppDb,
  watch: Watch,
  send: () => Promise<NotificationDeliveryOutcome>,
): Promise<boolean> {
  const context = { organizationId: watch.organizationId, watchId: watch.id };
  try {
    const current = await getPublicationWatch(
      db,
      watch.organizationId,
      watch.id,
      npmPublicationRegistry(env),
    );
    if (!current || current.ownershipConflict || current.managementPending) return false;
    const outcome = await send();
    if (outcome === "failed") {
      emitOperationalEvent("warn", "npm.publication_monitor.notification_failed", context);
      return false;
    }
    if (outcome === "no_destination") {
      emitOperationalEvent("warn", "npm.publication_monitor.notification_undeliverable", context);
    }
    return true;
  } catch {
    emitOperationalEvent("warn", "npm.publication_monitor.notification_failed", context);
    return false;
  }
}

/**
 * Send one alert whose delivery claim this check holds (the check that created
 * it holds it from creation). A failed delivery releases the claim, so the next
 * check tries again; the redrive below skips what this check already tried.
 */
export async function deliverPublicationAlert(
  env: Cloudflare.Env,
  db: AppDb,
  watch: Watch,
  alert: PendingAlert,
) {
  const key = {
    organizationId: watch.organizationId,
    packageName: watch.packageName,
    version: alert.version,
  };
  const delivered = await settles(env, db, watch, () =>
    notifyPublicationDiscrepancy({ env, db, ...key, status: alert.status, reason: alert.reason }),
  );
  try {
    if (delivered) await markPublicationAlertNotified(db, key);
    else await releasePublicationAlertClaim(db, key);
  } catch {
    // Unmarked, the alert is redriven once its claim lease lapses.
    emitOperationalEvent("warn", "npm.publication_monitor.notification_state_failed", {
      organizationId: watch.organizationId,
      watchId: watch.id,
    });
  }
}

/**
 * Alert rows are committed before delivery is attempted, and a settled
 * observation is never re-examined, so anything left unsent gets another
 * chance here rather than being lost with the isolate that failed to send it.
 * Each alert is claimed first, so an overlapping check cannot send it twice.
 */
export async function redeliverPendingAlerts(
  env: Cloudflare.Env,
  db: AppDb,
  watch: Watch,
  attempted: ReadonlySet<string>,
  now: Date,
) {
  let pending: Awaited<ReturnType<typeof listUnnotifiedPublicationAlerts>>;
  try {
    pending = await listUnnotifiedPublicationAlerts(db, {
      organizationId: watch.organizationId,
      packageName: watch.packageName,
      watchId: watch.id,
    });
  } catch {
    return;
  }
  for (const alert of pending) {
    // One attempt per alert per check; a delivery that just failed waits for
    // the next check rather than hammering a transport that is down.
    if (attempted.has(alert.version)) continue;
    const claimed = await claimPublicationAlertDelivery(
      db,
      {
        organizationId: watch.organizationId,
        packageName: watch.packageName,
        version: alert.version,
      },
      now,
      ALERT_DELIVERY_LEASE_MS,
    ).catch(() => false);
    if (!claimed) continue;
    await deliverPublicationAlert(env, db, watch, alert);
  }
}

/**
 * Tell the organization, once per gap, that the monitor cannot establish a
 * verdict: the package-wide gap recorded on the watch, and each release whose
 * bytes could not be verified for longer than the gap threshold. Claims make
 * overlapping checks send each notice once; a failed delivery gives its claim
 * back for a later check.
 */
export async function notifyCoverageGaps(env: Cloudflare.Env, db: AppDb, watch: Watch, now: Date) {
  const base = { env, db, organizationId: watch.organizationId, packageName: watch.packageName };
  const reason = await claimWatchCoverageNotice(db, watch, now);
  if (reason) {
    const sent = await settles(env, db, watch, () =>
      notifyPublicationCoverageGap({ ...base, version: null, reason }),
    );
    if (!sent) await releaseWatchCoverageNotice(db, watch, now);
  }
  for (const gap of await listUnnotifiedReleaseCoverageGaps(db, watch, now)) {
    const key = { organizationId: watch.organizationId, observationId: gap.id };
    if (!(await claimReleaseCoverageNotice(db, key, now))) continue;
    const sent = await settles(env, db, watch, () =>
      notifyPublicationCoverageGap({ ...base, version: gap.version, reason: gap.reason ?? "" }),
    );
    if (!sent) await releaseReleaseCoverageNotice(db, key, now);
  }
}
