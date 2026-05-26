import { Hono } from "hono";
import {
  RateLimitError,
  countRecentScanEvents,
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
const SUSPICIOUS_USE_WINDOW_MS = 15 * 60 * 1000;
const SUSPICIOUS_USE_THRESHOLD = 3;

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
    const previous = await getNpmConnection(db, organizationId);
    const isRotate = Boolean(previous);
    const registryChanged = previous ? previous.registryUrl !== registryUrl : false;
    const connection = await upsertNpmConnection(db, {
      organizationId,
      registryUrl,
      label,
      createdByUserId: session.userId,
      ...encrypted,
    });
    const auditEvents: Promise<unknown>[] = [
      recordScanEvent(db, {
        organizationId,
        actorUserId: session.userId,
        type: isRotate ? "npm_connection.rotated" : "npm_connection.created",
        metadata: {
          registryUrl,
          label,
          tokenFingerprint: encrypted.tokenFingerprint,
          ...(isRotate && previous
            ? {
                previousTokenFingerprint: previous.tokenFingerprint,
                previousValidationStatus: previous.validationStatus,
              }
            : {}),
        },
      }),
    ];
    if (registryChanged && previous) {
      auditEvents.push(
        recordScanEvent(db, {
          organizationId,
          actorUserId: session.userId,
          type: "npm_connection.registry_changed",
          metadata: {
            previousRegistryUrl: previous.registryUrl,
            registryUrl,
            tokenFingerprint: encrypted.tokenFingerprint,
          },
        }),
      );
    }
    await Promise.all(auditEvents);

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
    const wasValid = connection.validationStatus === "valid";
    const isDowngrade = wasValid && validation.status !== "valid";
    const updated = await updateNpmConnectionValidation(db, {
      organizationId,
      validationStatus: validation.status,
      capabilities: { ...validation.capabilities, reasons: validation.reasons },
      validatedAt: validation.ok ? new Date() : null,
    });
    const auditEvents: Promise<unknown>[] = [
      recordScanEvent(db, {
        organizationId,
        actorUserId: session.userId,
        type: validation.ok ? "npm_connection.validated" : "npm_connection.validation_failed",
        metadata: {
          ok: validation.ok,
          status: validation.status,
          reasons: validation.reasons,
          capabilities: validation.capabilities,
          ...(stageId ? { probedStageSource: "caller" } : {}),
        },
      }),
    ];
    if (isDowngrade) {
      auditEvents.push(
        recordScanEvent(db, {
          organizationId,
          actorUserId: session.userId,
          type: "npm_connection.validation_downgraded",
          metadata: {
            previousStatus: "valid",
            status: validation.status,
            reasons: validation.reasons,
            tokenFingerprint: connection.tokenFingerprint,
          },
        }),
      );
    }
    await Promise.all(auditEvents);

    if (!validation.ok) {
      const [recentFailures, recentSuspicious] = await Promise.all([
        countRecentScanEvents(db, {
          organizationId,
          type: "npm_connection.validation_failed",
          windowMs: SUSPICIOUS_USE_WINDOW_MS,
        }),
        countRecentScanEvents(db, {
          organizationId,
          type: "npm_connection.suspicious_use",
          windowMs: SUSPICIOUS_USE_WINDOW_MS,
        }),
      ]);
      if (recentFailures >= SUSPICIOUS_USE_THRESHOLD && recentSuspicious === 0) {
        await recordScanEvent(db, {
          organizationId,
          actorUserId: session.userId,
          type: "npm_connection.suspicious_use",
          metadata: {
            reason: "repeated_validation_failures",
            failureCount: recentFailures,
            windowMs: SUSPICIOUS_USE_WINDOW_MS,
            status: validation.status,
            tokenFingerprint: connection.tokenFingerprint,
          },
        });
      }
    }

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
