import { Hono } from "hono";
import {
  RateLimitError,
  createDb,
  deleteNpmConnection,
  enforceRateLimit,
  ensurePersonalOrganization,
  getNpmConnection,
  recordScanEvent,
  updateNpmConnectionValidation,
  upsertNpmConnection,
} from "../db";
import {
  decryptNpmToken,
  encryptNpmToken,
  normalizeRegistryUrl,
  publicNpmConnection,
  validateNpmCredential,
} from "../lib/npm-connection";
import type { Bindings, Variables } from "../types";

const STAGE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{5,160}$/;

export const npmConnectionRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

npmConnectionRoutes.get("/", async (c) => {
  const db = createDb(c.env.DB);
  const organizationId = await ensurePersonalOrganization(db, c.get("authSession"));
  return c.json({ connection: publicNpmConnection(await getNpmConnection(db, organizationId)) });
});

npmConnectionRoutes.post("/", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    token?: unknown;
    label?: unknown;
    registryUrl?: unknown;
  };
  const token = typeof body.token === "string" ? body.token.trim() : "";
  const label = typeof body.label === "string" && body.label.trim() ? body.label.trim().slice(0, 80) : "npm registry";
  if (!token) return c.json({ error: "npm token is required" }, 400);

  let registryUrl: string;
  try {
    registryUrl = normalizeRegistryUrl(body.registryUrl);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "invalid registry URL" }, 400);
  }

  try {
    const db = createDb(c.env.DB);
    const session = c.get("authSession");
    const organizationId = await ensurePersonalOrganization(db, session);
    await enforceRateLimit(db, { key: `npm-connection:save:${organizationId}`, limit: 20, windowMs: 60 * 60 * 1000 });
    const encrypted = await encryptNpmToken(c.env, token);
    const connection = await upsertNpmConnection(db, {
      organizationId,
      registryUrl,
      label,
      createdByUserId: session.userId,
      ...encrypted,
    });

    await recordScanEvent(db, {
      organizationId,
      actorUserId: session.userId,
      type: "npm_connection.upserted",
      metadata: {
        registryUrl,
        label,
        tokenFingerprint: encrypted.tokenFingerprint,
      },
    });

    return c.json({ connection: publicNpmConnection(connection) });
  } catch (err) {
    if (err instanceof RateLimitError) {
      return c.json(
        { error: "npm connection save rate limit exceeded", retryAfterSeconds: err.retryAfterSeconds },
        429,
        { "retry-after": String(err.retryAfterSeconds) },
      );
    }
    return c.json({ error: err instanceof Error ? err.message : "failed to store npm connection" }, 400);
  }
});

npmConnectionRoutes.post("/validate", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { stageId?: unknown };
  const stageId = typeof body.stageId === "string" && body.stageId.trim() ? body.stageId.trim() : undefined;
  if (stageId && !STAGE_ID_RE.test(stageId)) return c.json({ error: "invalid stageId" }, 400);

  try {
    const db = createDb(c.env.DB);
    const session = c.get("authSession");
    const organizationId = await ensurePersonalOrganization(db, session);
    await enforceRateLimit(db, { key: `npm-connection:validate:${organizationId}`, limit: 12, windowMs: 10 * 60 * 1000 });

    const connection = await getNpmConnection(db, organizationId);
    if (!connection) return c.json({ error: "npm connection is not configured" }, 404);

    const token = await decryptNpmToken(c.env, connection);
    const validation = await validateNpmCredential(connection.registryUrl, token, { stageId });
    const updated = await updateNpmConnectionValidation(db, {
      organizationId,
      validationStatus: validation.status,
      capabilities: validation.capabilities,
      validatedAt: validation.ok ? new Date() : null,
    });

    await recordScanEvent(db, {
      organizationId,
      actorUserId: session.userId,
      type: "npm_connection.validated",
      metadata: {
        ok: validation.ok,
        status: validation.status,
        capabilities: validation.capabilities,
      },
    });

    return c.json({ validation, connection: publicNpmConnection(updated) }, validation.ok ? 200 : 400);
  } catch (err) {
    if (err instanceof RateLimitError) {
      return c.json(
        { error: "npm validation rate limit exceeded", retryAfterSeconds: err.retryAfterSeconds },
        429,
        { "retry-after": String(err.retryAfterSeconds) },
      );
    }
    return c.json({ error: err instanceof Error ? err.message : "failed to validate npm connection" }, 400);
  }
});

npmConnectionRoutes.delete("/", async (c) => {
  const db = createDb(c.env.DB);
  const session = c.get("authSession");
  const organizationId = await ensurePersonalOrganization(db, session);
  const existing = await getNpmConnection(db, organizationId);
  await deleteNpmConnection(db, organizationId);
  if (existing) {
    await recordScanEvent(db, {
      organizationId,
      actorUserId: session.userId,
      type: "npm_connection.deleted",
      metadata: {
        registryUrl: existing.registryUrl,
        label: existing.label,
        tokenFingerprint: existing.tokenFingerprint,
      },
    });
  }
  return c.json({ ok: true });
});
