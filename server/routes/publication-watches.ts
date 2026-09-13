import { Hono } from "hono";
import { createDb } from "../db/client";
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
import { isValidNpmPackageName } from "../lib/ecosystems/npm/registry";
import { isRecord } from "../lib/platform/guards";
import { rateLimitResponse } from "../lib/platform/http";
import { enforceRateLimit, RateLimitError } from "../lib/platform/rate-limit";
import type { Bindings, Variables } from "../types";

export const publicationWatchRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

publicationWatchRoutes.use("*", async (c, next) => {
  c.header("cache-control", "private, no-store");
  await next();
});

publicationWatchRoutes.get("/", async (c) => {
  const db = createDb(c.env.DB);
  const organizationId = await requireActiveOrganization(c, db);
  return c.json({ watches: await listPublicationWatches(db, organizationId) });
});

publicationWatchRoutes.post("/", async (c) => {
  const db = createDb(c.env.DB);
  const organizationId = await requireActiveOrganization(c, db);
  const body: unknown = await c.req.json().catch(() => null);
  const packageName =
    isRecord(body) && typeof body.packageName === "string" ? body.packageName.trim() : "";
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

publicationWatchRoutes.get("/:id", async (c) => {
  const db = createDb(c.env.DB);
  const organizationId = await requireActiveOrganization(c, db);
  const watch = await getPublicationWatch(db, organizationId, c.req.param("id"));
  if (!watch) return c.json({ error: "not found" }, 404);
  return c.json({
    watch,
    observations: await listPublicationObservations(db, organizationId, watch.id),
  });
});

publicationWatchRoutes.delete("/:id", async (c) => {
  const db = createDb(c.env.DB);
  const organizationId = await requireActiveOrganization(c, db);
  const watch = await getPublicationWatch(db, organizationId, c.req.param("id"));
  if (!watch) return c.json({ error: "not found" }, 404);
  await deletePublicationWatch(db, organizationId, watch.id);
  return c.json({ deleted: true });
});

publicationWatchRoutes.post("/:id/check", async (c) => {
  const db = createDb(c.env.DB);
  const organizationId = await requireActiveOrganization(c, db);
  const watch = await getPublicationWatch(db, organizationId, c.req.param("id"));
  if (!watch) return c.json({ error: "not found" }, 404);
  try {
    await enforceRateLimit(c.env, {
      key: `publication-watches:check:${organizationId}`,
      limit: 6,
      windowMs: 60 * 1000,
    });
  } catch (err) {
    if (err instanceof RateLimitError) {
      return rateLimitResponse(c, "publication check rate limit exceeded", err);
    }
    throw err;
  }
  await checkNpmPublicationWatch(db, c.env, watch);
  const current = await getPublicationWatch(db, organizationId, watch.id);
  if (!current) return c.json({ error: "not found" }, 404);
  return c.json({
    watch: current,
    observations: await listPublicationObservations(db, organizationId, watch.id),
  });
});
