import { Hono } from "hono";
import {
  RateLimitError,
  createDb,
  createOrganization,
  enforceRateLimit,
  isOrganizationOwner,
  listUserOrganizations,
  recordScanEvent,
  renameOrganization,
} from "../db";
import { requireActiveOrganization, setActiveOrganization } from "../lib/active-organization";
import type { Bindings, Variables } from "../types";

const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} _\-./]{0,79}$/u;

export const organizationsRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

organizationsRoutes.get("/", async (c) => {
  const db = createDb(c.env.DB);
  const session = c.get("authSession");
  const activeOrganizationId = await requireActiveOrganization(db, session);
  const organizations = await listUserOrganizations(db, session.userId, activeOrganizationId);
  return c.json({ activeOrganizationId, organizations });
});

organizationsRoutes.post("/", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { name?: unknown };
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return c.json({ error: "organization name is required" }, 400);
  if (!NAME_RE.test(name)) {
    return c.json(
      { error: "organization name must be 1-80 characters of letters, digits, or _-./" },
      400,
    );
  }

  try {
    const db = createDb(c.env.DB);
    const session = c.get("authSession");
    await enforceRateLimit(db, {
      key: `organizations:create:${session.userId}`,
      limit: 10,
      windowMs: 60 * 60 * 1000,
    });
    const id = await createOrganization(db, { ownerUserId: session.userId, name });
    await recordScanEvent(db, {
      organizationId: id,
      actorUserId: session.userId,
      type: "organization.created",
      metadata: { name },
    });
    return c.json({ organization: { id, name } }, 201);
  } catch (err) {
    if (err instanceof RateLimitError) {
      return c.json(
        {
          error: "organization create rate limit exceeded",
          retryAfterSeconds: err.retryAfterSeconds,
        },
        429,
        { "retry-after": String(err.retryAfterSeconds) },
      );
    }
    console.error("organization create failed", err);
    return c.json({ error: "failed to create organization" }, 500);
  }
});

organizationsRoutes.post("/:id/activate", async (c) => {
  const db = createDb(c.env.DB);
  const session = c.get("authSession");
  const organizationId = c.req.param("id");
  const activated = await setActiveOrganization(db, session, organizationId);
  if (!activated) return c.json({ error: "not found" }, 404);
  await recordScanEvent(db, {
    organizationId,
    actorUserId: session.userId,
    type: "organization.activated",
    metadata: {},
  });
  return c.json({ activeOrganizationId: organizationId });
});

organizationsRoutes.patch("/:id", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { name?: unknown };
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return c.json({ error: "organization name is required" }, 400);
  if (!NAME_RE.test(name)) {
    return c.json(
      { error: "organization name must be 1-80 characters of letters, digits, or _-./" },
      400,
    );
  }

  const db = createDb(c.env.DB);
  const session = c.get("authSession");
  const organizationId = c.req.param("id");
  const owner = await isOrganizationOwner(db, organizationId, session.userId);
  if (!owner) return c.json({ error: "not found" }, 404);
  await renameOrganization(db, organizationId, name);
  await recordScanEvent(db, {
    organizationId,
    actorUserId: session.userId,
    type: "organization.renamed",
    metadata: { name },
  });
  return c.json({ organization: { id: organizationId, name } });
});
