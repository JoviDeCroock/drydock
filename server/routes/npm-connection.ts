import { Hono } from "hono";
import {
  RateLimitError,
  createDb,
  deleteNpmConnection,
  enforceRateLimit,
  getNpmConnection,
  recordScanEvent,
  updateNpmConnectionValidation,
  upsertNpmConnection,
} from "../db";
import { requireActiveOrganization } from "../lib/active-organization";
import {
  allowInsecureLocalRegistry,
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
  const organizationId = await requireActiveOrganization(c, db);
  return c.json({ connection: publicNpmConnection(await getNpmConnection(db, organizationId)) });
});

npmConnectionRoutes.post("/", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    token?: unknown;
    label?: unknown;
    registryUrl?: unknown;
  };
  const token = typeof body.token === "string" ? body.token.trim() : "";
  const label =
    typeof body.label === "string" && body.label.trim()
      ? body.label.trim().slice(0, 80)
      : "npm registry";
  if (!token) return c.json({ error: "npm token is required" }, 400);

  let registryUrl: string;
  try {
    registryUrl = normalizeRegistryUrl(body.registryUrl, {
      allowInsecureLocalhost: allowInsecureLocalRegistry(c.env),
    });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "invalid registry URL" }, 400);
  }
  try {
    const db = createDb(c.env.DB);
    const session = c.get("authSession");
    const organizationId = await requireActiveOrganization(c, db);
    const [, encrypted] = await Promise.all([
      enforceRateLimit(db, {
        key: `npm-connection:save:${organizationId}`,
        limit: 20,
        windowMs: 60 * 60 * 1000,
      }),
      encryptNpmToken(c.env, token),
    ]);
    const [connection] = await Promise.all([
      upsertNpmConnection(db, {
        organizationId,
        registryUrl,
        label,
        createdByUserId: session.userId,
        ...encrypted,
      }),
      recordScanEvent(db, {
        organizationId,
        actorUserId: session.userId,
        type: "npm_connection.upserted",
        metadata: {
          registryUrl,
          label,
          tokenFingerprint: encrypted.tokenFingerprint,
        },
      }),
    ]);

    return c.json({ connection: publicNpmConnection(connection) });
  } catch (err) {
    if (err instanceof RateLimitError) {
      return c.json(
        {
          error: "npm connection save rate limit exceeded",
          code: "rate_limited",
          retryAfterSeconds: err.retryAfterSeconds,
        },
        429,
        { "retry-after": String(err.retryAfterSeconds) },
      );
    }
    console.error("npm connection upsert failed", err);
    return c.json({ error: "failed to store npm connection" }, 400);
  }
});

npmConnectionRoutes.post("/validate", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { stageId?: unknown };
  const stageId =
    typeof body.stageId === "string" && body.stageId.trim() ? body.stageId.trim() : undefined;
  if (stageId && !STAGE_ID_RE.test(stageId)) return c.json({ error: "invalid stageId" }, 400);

  try {
    const db = createDb(c.env.DB);
    const session = c.get("authSession");
    const organizationId = await requireActiveOrganization(c, db);
    await enforceRateLimit(db, {
      key: `npm-connection:validate:${organizationId}`,
      limit: 12,
      windowMs: 10 * 60 * 1000,
    });

    const connection = await getNpmConnection(db, organizationId);
    if (!connection)
      return c.json({ error: "npm connection is not configured", code: "token_missing" }, 404);

    const token = await decryptNpmToken(c.env, connection);
    const validation = await validateNpmCredential(connection.registryUrl, token, {
      stageId,
      allowInsecureLocalhost: allowInsecureLocalRegistry(c.env),
    });
    const [updated] = await Promise.all([
      updateNpmConnectionValidation(db, {
        organizationId,
        validationStatus: validation.status,
        capabilities: { ...validation.capabilities, reasons: validation.reasons },
        validatedAt: validation.ok ? new Date() : null,
      }),
      recordScanEvent(db, {
        organizationId,
        actorUserId: session.userId,
        type: "npm_connection.validated",
        metadata: {
          ok: validation.ok,
          status: validation.status,
          reasons: validation.reasons,
          capabilities: validation.capabilities,
        },
      }),
    ]);

    return c.json({ validation, connection: publicNpmConnection(updated) });
  } catch (err) {
    if (err instanceof RateLimitError) {
      return c.json(
        {
          error: "npm validation rate limit exceeded",
          code: "rate_limited",
          retryAfterSeconds: err.retryAfterSeconds,
        },
        429,
        { "retry-after": String(err.retryAfterSeconds) },
      );
    }
    console.error("npm connection validation failed", err);
    return c.json({ error: "failed to validate npm connection", code: "validation_failed" }, 400);
  }
});

npmConnectionRoutes.delete("/", async (c) => {
  const db = createDb(c.env.DB);
  const session = c.get("authSession");
  const organizationId = await requireActiveOrganization(c, db);
  const existing = await getNpmConnection(db, organizationId);
  await Promise.all([
    deleteNpmConnection(db, organizationId),
    existing
      ? recordScanEvent(db, {
          organizationId,
          actorUserId: session.userId,
          type: "npm_connection.deleted",
          metadata: {
            registryUrl: existing.registryUrl,
            label: existing.label,
            tokenFingerprint: existing.tokenFingerprint,
          },
        })
      : Promise.resolve(),
  ]);
  return c.json({ ok: true });
});
