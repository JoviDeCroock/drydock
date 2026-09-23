import { Hono } from "hono";
import { recordScanEvent } from "../db/events";
import {
  acknowledgePublicationAlert,
  findObservationAlert,
  linkPublicationAlertReview,
  listPublicationAlertsForPackage,
  unlinkPublicationAlertReview,
} from "../db/publication-alerts";
import {
  createPublicationWatch,
  deletePublicationWatch,
  getPublicationEnrollment,
  getPublicationWatch,
  getPublicationWatchByPackage,
  listPublicationObservations,
  listPublicationWatches,
  PublicationWatchLimitError,
} from "../db/publication-watches";
import {
  requireActiveOrganization,
  requireActiveOrganizationContext,
  requireOrganizationRole,
} from "../lib/auth/active-organization";
import { roleCanManageIntegrations } from "../lib/auth/roles";
import {
  checkNpmPublicationWatch,
  recordPublishedReleaseDigests,
} from "../lib/ecosystems/npm/publication-monitor";
import { reconcilePublicationWatches } from "../lib/ecosystems/npm/publication-auto-enrollment";
import { npmPublicationRegistry } from "../lib/ecosystems/npm/publication-registry";
import { isValidNpmPackageName } from "../lib/ecosystems/npm/registry";
import { readJsonObject } from "../lib/platform/http";
import {
  ORGANIZATION_SCAN_LIMIT,
  ORGANIZATION_SCAN_WINDOW_MS,
  guardRateLimit,
} from "../lib/rate-limit";
import { createPreparedScan, enqueuePreparedScan, preparePublishedScan } from "../lib/scan/start";
import { deletePendingScanJob } from "../db/scans";
import type { Bindings, Variables } from "../types";

export const npmPublicationWatchRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

npmPublicationWatchRoutes.use("*", async (c, next) => {
  c.header("cache-control", "private, no-store");
  await next();
});

npmPublicationWatchRoutes.get("/", async (c) => {
  const db = c.var.db;
  const organizationId = await requireActiveOrganization(c, db);
  const autoEnrollment = await reconcilePublicationWatches(
    db,
    organizationId,
    npmPublicationRegistry(c.env),
  );
  return c.json({ watches: await listPublicationWatches(db, organizationId), autoEnrollment });
});

// One package's monitoring state for the package page. Read-only: unlike the
// list, it never reconciles enrollment, and the package name is a filter over
// this organization's rows, never an authority. `{.+}` keeps a scoped name's
// `/`.
npmPublicationWatchRoutes.get("/packages/:name{.+}", async (c) => {
  const packageName = c.req.param("name").trim();
  if (!isValidNpmPackageName(packageName)) {
    return c.json({ error: "Enter a valid public npm package name." }, 400);
  }
  const db = c.var.db;
  const { organizationId, role } = await requireActiveOrganizationContext(c, db);
  const watch = await getPublicationWatchByPackage(db, organizationId, packageName);
  const [enrollment, observations, ledger] = await Promise.all([
    watch
      ? Promise.resolve({ state: "watched" as const })
      : getPublicationEnrollment(db, organizationId, packageName),
    watch ? listPublicationObservations(db, organizationId, watch.id) : Promise.resolve([]),
    listPublicationAlertsForPackage(db, organizationId, packageName, watch?.id ?? null),
  ]);
  return c.json({
    packageName,
    watch,
    observations,
    alerts: ledger.alerts,
    moreAlerts: ledger.more,
    enrollment,
    viewer: { canStop: roleCanManageIntegrations(role) },
  });
});

npmPublicationWatchRoutes.post("/", async (c) => {
  const db = c.var.db;
  const organizationId = await requireActiveOrganization(c, db);
  const body = await readJsonObject<{ packageName: unknown }>(c);
  const packageName = typeof body.packageName === "string" ? body.packageName.trim() : "";
  if (!isValidNpmPackageName(packageName)) {
    return c.json({ error: "Enter a valid public npm package name." }, 400);
  }
  try {
    const watch = await createPublicationWatch(db, organizationId, packageName);
    // Enrollment also clears a persisted opt-out, so it is audited alongside
    // the stop it can undo.
    await recordScanEvent(db, {
      organizationId,
      actorUserId: c.get("authSession").userId,
      type: "publication_watch.started",
      metadata: { packageName: watch.packageName },
    });
    return c.json({ watch }, 201);
  } catch (err) {
    if (err instanceof PublicationWatchLimitError) {
      return c.json({ error: "This organization has reached its package monitoring limit." }, 409);
    }
    throw err;
  }
});

npmPublicationWatchRoutes.get("/:id", async (c) => {
  const db = c.var.db;
  const organizationId = await requireActiveOrganization(c, db);
  const watch = await getPublicationWatch(db, organizationId, c.req.param("id"));
  if (!watch) return c.json({ error: "not found" }, 404);
  return c.json({
    watch,
    observations: await listPublicationObservations(db, organizationId, watch.id),
  });
});

// Stopping deletes the observation window (unacknowledged alerts included) and
// persists an opt-out that automatic enrollment honors, so it is gated like
// the other integrations that decide what Drydock watches, and audited.
npmPublicationWatchRoutes.delete("/:id", async (c) => {
  const db = c.var.db;
  const { organizationId } = await requireOrganizationRole(c, db, roleCanManageIntegrations);
  const watch = await getPublicationWatch(db, organizationId, c.req.param("id"));
  if (!watch) return c.json({ error: "not found" }, 404);
  if (!(await deletePublicationWatch(db, organizationId, watch.id))) {
    return c.json({ error: "not found" }, 404);
  }
  await recordScanEvent(db, {
    organizationId,
    actorUserId: c.get("authSession").userId,
    type: "publication_watch.stopped",
    metadata: { packageName: watch.packageName },
  });
  return c.json({ deleted: true });
});

npmPublicationWatchRoutes.post("/:id/check", async (c) => {
  const db = c.var.db;
  const organizationId = await requireActiveOrganization(c, db);
  const watch = await getPublicationWatch(db, organizationId, c.req.param("id"));
  if (!watch) return c.json({ error: "not found" }, 404);
  const limited = await guardRateLimit(
    c,
    { key: `publication-watches:check:${organizationId}`, limit: 10, windowMs: 60 * 1000 },
    "publication check rate limit exceeded",
  );
  if (limited) return limited;
  try {
    await checkNpmPublicationWatch(db, c.env, watch);
  } catch {
    // The check recorded its failure on the watch (`check_failed`), which the
    // response below carries, so the page never reads a failed check as coverage.
  }
  const current = await getPublicationWatch(db, organizationId, watch.id);
  if (!current) return c.json({ error: "not found" }, 404);
  return c.json({
    watch: current,
    observations: await listPublicationObservations(db, organizationId, watch.id),
  });
});

npmPublicationWatchRoutes.post("/:id/observations/:observationId/acknowledge", async (c) => {
  const db = c.var.db;
  const organizationId = await requireActiveOrganization(c, db);
  const session = c.get("authSession");
  const acknowledged = await acknowledgePublicationAlert(db, {
    organizationId,
    watchId: c.req.param("id"),
    observationId: c.req.param("observationId"),
    actorUserId: session.userId,
  });
  if (!acknowledged) return c.json({ error: "not found" }, 404);
  const watch = await getPublicationWatch(db, organizationId, c.req.param("id"));
  if (!watch) return c.json({ error: "not found" }, 404);
  return c.json({
    watch,
    observations: await listPublicationObservations(db, organizationId, watch.id),
  });
});

// Review the published bytes of an alerted release after the fact: the same
// published-pair review `POST /api/v1/scans` starts, of the observed version
// against the version the monitor recorded it following, linked to the alert
// so the decision on it resolves the alert. One review per alert: a second
// request opens the first. Same role and scan budget as starting any review.
npmPublicationWatchRoutes.post("/:id/observations/:observationId/review", async (c) => {
  const db = c.var.db;
  const organizationId = await requireActiveOrganization(c, db);
  const session = c.get("authSession");
  const target = {
    organizationId,
    watchId: c.req.param("id"),
    observationId: c.req.param("observationId"),
  };
  const alert = await findObservationAlert(db, target);
  if (!alert) return c.json({ error: "not found" }, 404);
  if (alert.reviewScanId) return c.json({ scanId: alert.reviewScanId, started: false }, 200);

  const limited = await guardRateLimit(
    c,
    {
      key: `scan:${organizationId}`,
      limit: ORGANIZATION_SCAN_LIMIT,
      windowMs: ORGANIZATION_SCAN_WINDOW_MS,
    },
    "scan rate limit exceeded",
  );
  if (limited) return limited;

  const prepared = await preparePublishedScan(c, {
    ecosystem: "npm",
    packageName: alert.packageName,
    version: alert.version,
    baselineVersion: alert.previousVersion,
  });
  if ("error" in prepared) return prepared.error;
  // The registry resolves exactly the coordinates it was asked about; a
  // review of anything else must never be linked to this alert.
  if (prepared.packageName !== alert.packageName || prepared.version !== alert.version) {
    return c.json({ error: "the registry resolved a different release" }, 409);
  }

  const scanId = crypto.randomUUID();
  const created = await createPreparedScan(db, {
    scanId,
    organizationId,
    ownerUserId: session.userId,
    prepared,
  });
  if (!created) return c.json({ error: "failed to create scan" }, 500);
  const linked = await linkPublicationAlertReview(db, {
    alertId: alert.id,
    organizationId,
    scanId,
    actorUserId: session.userId,
    packageName: alert.packageName,
    version: alert.version,
  });
  if (!linked) {
    // A concurrent request linked its review first. This one was never
    // queued, so remove it and open the one that won.
    await deletePendingScanJob(db, scanId, organizationId);
    const current = await findObservationAlert(db, target);
    if (!current?.reviewScanId) return c.json({ error: "not found" }, 404);
    return c.json({ scanId: current.reviewScanId, started: false }, 200);
  }
  try {
    await enqueuePreparedScan(c, db, {
      scanId,
      organizationId,
      actorUserId: session.userId,
      prepared,
    });
  } catch (err) {
    // A review that never reached the queue would stay pending forever and
    // hold the alert's one link, hiding Scan. Unlink it and remove it.
    await unlinkPublicationAlertReview(db, { alertId: alert.id, organizationId, scanId });
    await deletePendingScanJob(db, scanId, organizationId);
    throw err;
  }
  // The decision is bound to the bytes the monitor saw npm publish. A release
  // with no Drydock record was never downloaded, so hash it now, off the
  // request path; the decision tries again if this has not landed by then.
  c.executionCtx.waitUntil(
    recordPublishedReleaseDigests(db, c.env, {
      organizationId,
      packageName: alert.packageName,
      version: alert.version,
    }),
  );
  return c.json({ scanId, started: true }, 202);
});
