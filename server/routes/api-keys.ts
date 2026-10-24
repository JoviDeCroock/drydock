/**
 * Organization API key management (session only) and the key's own
 * introspection endpoint (API key only). Every member creates keys for
 * themselves and sees and revokes their own; owners and admins see and revoke
 * every key in the organization. See docs/api-keys.md.
 */
import { type Context, Hono } from "hono";
import { eq } from "drizzle-orm";
import {
  countActiveOrganizationApiKeys,
  deleteOrganizationApiKey,
  getApiKeyDescription,
  insertOrganizationApiKey,
  listOrganizationApiKeys,
  type OrganizationApiKey,
} from "../db/api-keys";
import { recordScanEvent } from "../db/events";
import { organizations } from "../db/schema";
import { requireActiveOrganizationContext } from "../lib/auth/active-organization";
import { userHasTwoFactor } from "../lib/auth";
import { API_KEY_ACCESS_LEVELS } from "../db/enums";
import {
  API_KEY_EXPIRY_DAYS,
  API_KEY_NAME_MAX_LENGTH,
  MAX_API_KEYS_PER_ORGANIZATION,
  generateApiKey,
  parseApiKeyAccess,
  parseApiKeyExpiry,
  parseApiKeyName,
} from "../lib/auth/api-keys";
import { requireVerifiedEmail } from "../lib/auth/email-verification";
import { roleCanManageIntegrations } from "../lib/auth/roles";
import { readJsonObject } from "../lib/platform/http";
import { guardRateLimit } from "../lib/rate-limit";
import type { Bindings, Variables } from "../types";

const DAY_MS = 24 * 60 * 60 * 1000;

export const apiKeyRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// The calling key's own identity, for `drydock whoami` and for checking a key
// before a script relies on it. Registered before `/:keyId` so it is never
// read as a key id.
apiKeyRoutes.get("/current", async (c) => {
  const apiKey = c.get("apiKey");
  if (!apiKey) {
    return c.json({ error: "this endpoint requires an API key", code: "api_key_required" }, 400);
  }
  const db = c.var.db;
  const [key, [organization]] = await Promise.all([
    getApiKeyDescription(db, apiKey.id),
    db
      .select({ id: organizations.id, name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, apiKey.organizationId))
      .limit(1),
  ]);
  if (!key || !organization) return c.json({ error: "invalid API key" }, 401);
  return c.json({
    organization,
    key: { id: apiKey.id, name: key.name, prefix: key.prefix, expiresAt: key.expiresAt },
    access: key.access,
  });
});

/**
 * Owners and admins manage every key; any other member only the keys they
 * created, which act as them alone.
 */
async function keyManagementScope(c: Context<{ Bindings: Bindings; Variables: Variables }>) {
  const db = c.var.db;
  const { organizationId, role } = await requireActiveOrganizationContext(c, db);
  const manageAll = roleCanManageIntegrations(role);
  return {
    organizationId,
    manageAll,
    scope: manageAll ? {} : { createdByUserId: c.get("authSession").userId },
  };
}

apiKeyRoutes.get("/", async (c) => {
  const db = c.var.db;
  const { organizationId, manageAll, scope } = await keyManagementScope(c);
  const keys = await listOrganizationApiKeys(db, organizationId, scope);
  return c.json({
    keys: keys.map(publicApiKey),
    manageAll,
    limit: MAX_API_KEYS_PER_ORGANIZATION,
    expiryDays: API_KEY_EXPIRY_DAYS,
    accessLevels: API_KEY_ACCESS_LEVELS,
  });
});

apiKeyRoutes.post("/", async (c) => {
  const unverified = requireVerifiedEmail(c);
  if (unverified) return unverified;
  const body = await readJsonObject<{
    name?: unknown;
    expiresInDays?: unknown;
    access?: unknown;
  }>(c);
  const name = parseApiKeyName(body.name);
  if (!name) {
    return c.json({ error: `name must be 1-${API_KEY_NAME_MAX_LENGTH} printable characters` }, 400);
  }
  const expiresInDays = parseApiKeyExpiry(body.expiresInDays);
  if (expiresInDays === null) {
    return c.json({ error: `expiresInDays must be one of ${API_KEY_EXPIRY_DAYS.join(", ")}` }, 400);
  }
  // Fixed at creation: widening a key's access means issuing a new secret.
  const access = parseApiKeyAccess(body.access);
  if (access === null) {
    return c.json({ error: `access must be one of ${API_KEY_ACCESS_LEVELS.join(", ")}` }, 400);
  }

  const db = c.var.db;
  const session = c.get("authSession");
  const { organizationId } = await keyManagementScope(c);
  // A decide_staged key's every decision needs its creator's TOTP code, so only
  // a member who can produce one may create it (docs/api-keys.md).
  if (access === "decide_staged" && !(await userHasTwoFactor(db, session.userId))) {
    return c.json(
      {
        error:
          "Turn on two-factor authentication in your account settings to create a key that records decisions.",
        code: "two_factor_enrollment_required",
      },
      403,
    );
  }
  const limited = await guardRateLimit(
    c,
    { key: `api-keys:create:${session.userId}`, limit: 20, windowMs: 60 * 60 * 1000 },
    "API key creation rate limit exceeded",
  );
  if (limited) return limited;

  const now = new Date();
  if (
    (await countActiveOrganizationApiKeys(db, organizationId, now)) >= MAX_API_KEYS_PER_ORGANIZATION
  ) {
    return c.json(
      {
        error: `an organization can hold at most ${MAX_API_KEYS_PER_ORGANIZATION} unexpired API keys`,
      },
      409,
    );
  }

  const generated = await generateApiKey();
  const id = crypto.randomUUID();
  const expiresAt = new Date(now.getTime() + expiresInDays * DAY_MS);
  await insertOrganizationApiKey(db, {
    id,
    organizationId,
    name,
    prefix: generated.prefix,
    keyHash: generated.keyHash,
    access,
    createdByUserId: session.userId,
    createdAt: now,
    expiresAt,
  });
  await recordScanEvent(db, {
    organizationId,
    actorUserId: session.userId,
    type: "organization.api_key_created",
    metadata: { name, prefix: generated.prefix, access, expiresAt: expiresAt.toISOString() },
  });
  // The only response that ever carries the secret; it is not stored.
  return c.json(
    {
      key: {
        id,
        name,
        prefix: generated.prefix,
        access,
        createdAt: now,
        expiresAt,
        lastUsedAt: null,
        createdBy: {
          userId: session.userId,
          email: session.email ?? null,
          name: session.name ?? null,
        },
      },
      token: generated.token,
    },
    201,
    { "cache-control": "no-store" },
  );
});

apiKeyRoutes.delete("/:keyId", async (c) => {
  const db = c.var.db;
  const session = c.get("authSession");
  const { organizationId, scope } = await keyManagementScope(c);
  const removed = await deleteOrganizationApiKey(db, organizationId, c.req.param("keyId"), scope);
  if (!removed) return c.json({ error: "not found" }, 404);
  await recordScanEvent(db, {
    organizationId,
    actorUserId: session.userId,
    type: "organization.api_key_revoked",
    metadata: { name: removed.name, prefix: removed.prefix },
  });
  return c.json({ ok: true });
});

function publicApiKey(key: OrganizationApiKey) {
  return {
    id: key.id,
    name: key.name,
    prefix: key.prefix,
    access: key.access,
    createdAt: key.createdAt,
    expiresAt: key.expiresAt,
    lastUsedAt: key.lastUsedAt,
    createdBy: key.createdBy,
  };
}
