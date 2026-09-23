import { Hono } from "hono";
import { acknowledgePublicationAlert } from "../db/publication-alerts";
import {
  createPublicationWatch,
  deletePublicationWatch,
  getPublicationWatch,
  listPublicationObservations,
  listPublicationWatches,
  PublicationWatchLimitError,
} from "../db/publication-watches";
import { requireActiveOrganization } from "../lib/auth/active-organization";
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
  return c.json({ watches: await listPublicationWatches(db, organizationId), autoEnrollment });
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

npmPublicationWatchRoutes.delete("/:id", async (c) => {
  const db = c.var.db;
  const organizationId = await requireActiveOrganization(c, db);
  const watch = await getPublicationWatch(db, organizationId, c.req.param("id"));
  if (!watch) return c.json({ error: "not found" }, 404);
  await deletePublicationWatch(db, organizationId, watch.id);
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
  await checkNpmPublicationWatch(db, c.env, watch);
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
