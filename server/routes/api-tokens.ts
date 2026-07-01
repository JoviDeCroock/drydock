import { Hono } from "hono";
import {
  createApiToken,
  createDb,
  enforceRateLimit,
  listApiTokens,
  RateLimitError,
  recordScanEvent,
  revokeApiToken,
} from "../db";
import { requireActiveOrganizationContext } from "../lib/active-organization";
import { generateApiToken } from "../lib/api-token";
import { roleCanManageIntegrations } from "../lib/roles";
import { rateLimitResponse } from "../lib/http";
import type { Bindings, Variables } from "../types";

export const apiTokensRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

const MAX_TOKENS_PER_ORG = 25;
const MAX_TOKEN_NAME_LEN = 80;
// Cap the lifetime a caller may request; open-ended tokens are still allowed
// (omit expiresInDays) but a bounded value can't exceed a year.
const MAX_EXPIRY_DAYS = 365;

apiTokensRoutes.get("/", async (c) => {
  const db = createDb(c.env.DB);
  const { organizationId, role } = await requireActiveOrganizationContext(c, db);
  if (!roleCanManageIntegrations(role)) return c.json({ error: "forbidden" }, 403);
  const tokens = await listApiTokens(db, organizationId);
  return c.json({ tokens });
});

apiTokensRoutes.post("/", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    name?: unknown;
    expiresInDays?: unknown;
  };
  const name =
    typeof body.name === "string" && body.name.trim()
      ? body.name.trim().slice(0, MAX_TOKEN_NAME_LEN)
      : "";
  if (!name) return c.json({ error: "token name is required" }, 400);

  let expiresAt: Date | null = null;
  if (body.expiresInDays !== undefined && body.expiresInDays !== null) {
    const days = Number(body.expiresInDays);
    if (!Number.isFinite(days) || days <= 0 || days > MAX_EXPIRY_DAYS) {
      return c.json({ error: `expiresInDays must be between 1 and ${MAX_EXPIRY_DAYS}` }, 400);
    }
    expiresAt = new Date(Date.now() + Math.floor(days) * 24 * 60 * 60 * 1000);
  }

  const db = createDb(c.env.DB);
  const session = c.get("authSession");
  const { organizationId, role } = await requireActiveOrganizationContext(c, db);
  if (!roleCanManageIntegrations(role)) return c.json({ error: "forbidden" }, 403);

  try {
    await enforceRateLimit(db, {
      key: `api-token:create:${organizationId}`,
      limit: 20,
      windowMs: 60 * 60 * 1000,
    });
  } catch (err) {
    if (err instanceof RateLimitError) {
      return rateLimitResponse(c, "too many token creation attempts", err);
    }
    throw err;
  }

  const existing = await listApiTokens(db, organizationId);
  if (existing.length >= MAX_TOKENS_PER_ORG) {
    return c.json({ error: "token limit reached; revoke an existing token first" }, 409);
  }

  const generated = await generateApiToken();
  const created = await createApiToken(db, {
    organizationId,
    name,
    tokenHash: generated.tokenHash,
    tokenPrefix: generated.tokenPrefix,
    scope: "read",
    createdByUserId: session.userId,
    expiresAt,
  });

  await recordScanEvent(db, {
    organizationId,
    actorUserId: session.userId,
    scanId: null,
    type: "api_token.created",
    metadata: { tokenId: created.id, name: created.name, scope: created.scope },
  });

  // The plaintext token is returned exactly once; only its hash is stored.
  return c.json({ token: created, secret: generated.token }, 201);
});

apiTokensRoutes.delete("/:id", async (c) => {
  const db = createDb(c.env.DB);
  const session = c.get("authSession");
  const { organizationId, role } = await requireActiveOrganizationContext(c, db);
  if (!roleCanManageIntegrations(role)) return c.json({ error: "forbidden" }, 403);
  const tokenId = c.req.param("id");
  const revoked = await revokeApiToken(db, organizationId, tokenId);
  if (!revoked) return c.json({ error: "not found" }, 404);
  await recordScanEvent(db, {
    organizationId,
    actorUserId: session.userId,
    scanId: null,
    type: "api_token.revoked",
    metadata: { tokenId },
  });
  return c.json({ ok: true });
});
