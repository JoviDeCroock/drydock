import { Hono } from "hono";
import { createDb } from "../db/client";
import { recordScanEvent } from "../db/events";
import {
  deleteNpmConnection,
  getNpmConnection,
  updateNpmConnectionValidation,
  upsertNpmConnection,
} from "../db/npm-connections";
import { RateLimitError, enforceRateLimit } from "../db/rate-limit";
import {
  requireActiveOrganization,
  requireActiveOrganizationContext,
} from "../lib/auth/active-organization";
import { roleCanManageIntegrations } from "../lib/auth/roles";
import { recordProductEvent } from "../lib/platform/analytics";
import {
  allowInsecureLocalRegistry,
  decryptNpmToken,
  encryptNpmToken,
  normalizeRegistryUrl,
  publicNpmConnection,
  validateNpmCredential,
} from "../lib/ecosystems/npm/connection";
import { isValidStageId } from "../lib/ecosystems/npm/stage-id";
import { errorMessage } from "../lib/platform/errors";
import { rateLimitResponse } from "../lib/platform/http";
import { describeOperationalError, emitOperationalEvent } from "../lib/platform/observability";
import type { Bindings, Variables } from "../types";

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
    return c.json(
      { error: err instanceof Error ? errorMessage(err) : "invalid registry URL" },
      400,
    );
  }
  try {
    const db = createDb(c.env.DB);
    const session = c.get("authSession");
    const { organizationId, role } = await requireActiveOrganizationContext(c, db);
    if (!roleCanManageIntegrations(role)) return c.json({ error: "forbidden" }, 403);
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
      return rateLimitResponse(c, "npm connection save rate limit exceeded", err);
    }
    emitOperationalEvent("error", "npm_connection.upsert_failed", {
      error: describeOperationalError(err),
    });
    return c.json({ error: "failed to store npm connection" }, 500);
  }
});

npmConnectionRoutes.post("/validate", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { stageId?: unknown };
  const stageId =
    typeof body.stageId === "string" && body.stageId.trim() ? body.stageId.trim() : undefined;
  if (stageId && !isValidStageId(stageId)) return c.json({ error: "invalid stageId" }, 400);

  try {
    const db = createDb(c.env.DB);
    const session = c.get("authSession");
    const { organizationId, role } = await requireActiveOrganizationContext(c, db);
    if (!roleCanManageIntegrations(role)) return c.json({ error: "forbidden" }, 403);
    await enforceRateLimit(db, {
      key: `npm-connection:validate:${organizationId}`,
      limit: 12,
      windowMs: 10 * 60 * 1000,
    });

    const connection = await getNpmConnection(db, organizationId);
    if (!connection) return c.json({ error: "npm connection is not configured" }, 404);

    const token = await decryptNpmToken(c.env, connection);
    const validation = await validateNpmCredential(connection.registryUrl, token, {
      stageId,
      allowInsecureLocalhost: allowInsecureLocalRegistry(c.env),
    });
    const [updated] = await Promise.all([
      updateNpmConnectionValidation(db, {
        organizationId,
        validationStatus: validation.status,
        capabilities: validation.capabilities,
        validatedAt: validation.ok ? new Date() : null,
      }),
      recordScanEvent(db, {
        organizationId,
        actorUserId: session.userId,
        type: "npm_connection.validated",
        metadata: {
          ok: validation.ok,
          status: validation.status,
          capabilities: validation.capabilities,
        },
      }),
    ]);
    // The onboarding funnel's one measurable step inside the product: getting a
    // token validated is the last thing a new organization does before its
    // first review depends on an external staged publish.
    recordProductEvent(c.env, {
      name: "npm_connection.validated",
      organizationId,
      outcome: validation.ok ? "ok" : "failed",
    });

    return c.json({ validation, connection: publicNpmConnection(updated) });
  } catch (err) {
    if (err instanceof RateLimitError) {
      return rateLimitResponse(c, "npm validation rate limit exceeded", err);
    }
    emitOperationalEvent("error", "npm_connection.validation_failed", {
      error: describeOperationalError(err),
    });
    return c.json({ error: "failed to validate npm connection" }, 500);
  }
});

npmConnectionRoutes.delete("/", async (c) => {
  const db = createDb(c.env.DB);
  const session = c.get("authSession");
  const { organizationId, role } = await requireActiveOrganizationContext(c, db);
  if (!roleCanManageIntegrations(role)) return c.json({ error: "forbidden" }, 403);
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
