import { Hono } from "hono";
import { recordScanEvent } from "../db/events";
import {
  acknowledgePublicationAlert,
  listPublicationAlertsForPackage,
} from "../db/publication-alerts";
import {
  createPublicationWatch,
  deletePublicationWatch,
  getPublicationEnrollment,
  getPublicationOwnershipConflict,
  getPublicationWatch,
  getPublicationWatchByPackage,
  listPublicationObservations,
  listPublicationWatches,
  PublicationWatchLimitError,
  PublicationWatchOwnershipError,
} from "../db/publication-watches";
import {
  requireActiveOrganization,
  requireActiveOrganizationContext,
  requireOrganizationRole,
} from "../lib/auth/active-organization";
import { roleCanManageIntegrations } from "../lib/auth/roles";
import { checkNpmPublicationWatch } from "../lib/ecosystems/npm/publication-monitor";
import { reconcilePublicationWatches } from "../lib/ecosystems/npm/publication-auto-enrollment";
import { npmPublicationRegistry } from "../lib/ecosystems/npm/publication-registry";
import { isValidNpmPackageName } from "../lib/ecosystems/npm/registry";
import { readJsonObject } from "../lib/platform/http";
import { guardRateLimit } from "../lib/rate-limit";
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
  return c.json({
    watches: await listPublicationWatches(db, organizationId, npmPublicationRegistry(c.env)),
    autoEnrollment,
  });
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
  const watch = await getPublicationWatchByPackage(
    db,
    organizationId,
    packageName,
    npmPublicationRegistry(c.env),
  );
  const [enrollment, observations, ledger, ownershipConflict] = await Promise.all([
    watch
      ? Promise.resolve({ state: "watched" as const })
      : getPublicationEnrollment(db, organizationId, packageName),
    watch ? listPublicationObservations(db, organizationId, watch.id) : Promise.resolve([]),
    listPublicationAlertsForPackage(db, organizationId, packageName, watch?.id ?? null),
    getPublicationOwnershipConflict(db, organizationId, packageName, npmPublicationRegistry(c.env)),
  ]);
  return c.json({
    packageName,
    ownershipConflict,
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
    const watch = await createPublicationWatch(
      db,
      organizationId,
      packageName,
      npmPublicationRegistry(c.env),
    );
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
    if (err instanceof PublicationWatchOwnershipError)
      return c.json({ error: "This package is already assigned to another organization." }, 409);
    if (err instanceof PublicationWatchLimitError) {
      return c.json({ error: "This organization has reached its package monitoring limit." }, 409);
    }
    throw err;
  }
});

npmPublicationWatchRoutes.get("/:id", async (c) => {
  const db = c.var.db;
  const organizationId = await requireActiveOrganization(c, db);
  const watch = await getPublicationWatch(
    db,
    organizationId,
    c.req.param("id"),
    npmPublicationRegistry(c.env),
  );
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
  const watch = await getPublicationWatch(
    db,
    organizationId,
    c.req.param("id"),
    npmPublicationRegistry(c.env),
  );
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
  const watch = await getPublicationWatch(
    db,
    organizationId,
    c.req.param("id"),
    npmPublicationRegistry(c.env),
  );
  if (!watch) return c.json({ error: "not found" }, 404);
  if (watch.ownershipConflict)
    return c.json(
      { error: "Monitoring is inactive because this package is assigned to another organization." },
      409,
    );
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
  const current = await getPublicationWatch(
    db,
    organizationId,
    watch.id,
    npmPublicationRegistry(c.env),
  );
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
  const watch = await getPublicationWatch(
    db,
    organizationId,
    c.req.param("id"),
    npmPublicationRegistry(c.env),
  );
  if (!watch) return c.json({ error: "not found" }, 404);
  return c.json({
    watch,
    observations: await listPublicationObservations(db, organizationId, watch.id),
  });
});
