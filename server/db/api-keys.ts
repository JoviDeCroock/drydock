import { and, asc, count, eq, gt, isNull, lt, or } from "drizzle-orm";
import type { AppDb } from "./client";
import type { ApiKeyAccess } from "./enums";
import { recordScanEvent } from "./events";
import type { ApiKeyPrincipal } from "../lib/auth/api-keys";
import { organizationApiKeys, organizationMembers, user } from "./schema";

export interface OrganizationApiKey {
  id: string;
  name: string;
  prefix: string;
  access: ApiKeyAccess;
  createdAt: Date;
  expiresAt: Date;
  lastUsedAt: Date | null;
  createdBy: { userId: string; email: string | null; name: string | null };
}

export interface ApiKeyAuthRecord {
  id: string;
  organizationId: string;
  name: string;
  prefix: string;
  access: ApiKeyAccess;
  createdByUserId: string;
  expiresAt: Date;
  lastUsedAt: Date | null;
}

export async function listOrganizationApiKeys(
  db: AppDb,
  organizationId: string,
): Promise<OrganizationApiKey[]> {
  const rows = await db
    .select({
      id: organizationApiKeys.id,
      name: organizationApiKeys.name,
      prefix: organizationApiKeys.prefix,
      access: organizationApiKeys.access,
      createdAt: organizationApiKeys.createdAt,
      expiresAt: organizationApiKeys.expiresAt,
      lastUsedAt: organizationApiKeys.lastUsedAt,
      createdByUserId: organizationApiKeys.createdByUserId,
      creatorEmail: user.email,
      creatorName: user.name,
    })
    .from(organizationApiKeys)
    .leftJoin(user, eq(user.id, organizationApiKeys.createdByUserId))
    .where(eq(organizationApiKeys.organizationId, organizationId))
    .orderBy(asc(organizationApiKeys.createdAt), asc(organizationApiKeys.id));
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    access: row.access,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    lastUsedAt: row.lastUsedAt,
    createdBy: {
      userId: row.createdByUserId,
      email: row.creatorEmail ?? null,
      name: row.creatorName ?? null,
    },
  }));
}

/** Unexpired keys only: an expired key stays listed until revoked but holds no slot. */
export async function countActiveOrganizationApiKeys(
  db: AppDb,
  organizationId: string,
  now: Date,
): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(organizationApiKeys)
    .where(
      and(
        eq(organizationApiKeys.organizationId, organizationId),
        gt(organizationApiKeys.expiresAt, now),
      ),
    );
  return row?.value ?? 0;
}

export async function insertOrganizationApiKey(
  db: AppDb,
  input: {
    id: string;
    organizationId: string;
    name: string;
    prefix: string;
    keyHash: string;
    access: ApiKeyAccess;
    createdByUserId: string;
    createdAt: Date;
    expiresAt: Date;
  },
): Promise<void> {
  await db.insert(organizationApiKeys).values({ ...input, lastUsedAt: null });
}

/** The deleted key's name, or null when no such key belongs to the organization. */
export async function deleteOrganizationApiKey(
  db: AppDb,
  organizationId: string,
  keyId: string,
): Promise<{ name: string; prefix: string } | null> {
  const [removed] = await db
    .delete(organizationApiKeys)
    .where(
      and(
        eq(organizationApiKeys.organizationId, organizationId),
        eq(organizationApiKeys.id, keyId),
      ),
    )
    .returning({ name: organizationApiKeys.name, prefix: organizationApiKeys.prefix });
  return removed ?? null;
}

/** The statement that ends a departing member's keys, for batching with the removal. */
export function deleteApiKeysCreatedByStatement(db: AppDb, organizationId: string, userId: string) {
  return db
    .delete(organizationApiKeys)
    .where(
      and(
        eq(organizationApiKeys.organizationId, organizationId),
        eq(organizationApiKeys.createdByUserId, userId),
      ),
    );
}

/**
 * The key with this hash, only while its creator is still a member of its
 * organization. Membership is checked on every use rather than trusted to the
 * removal path: a key created while its creator was being removed, or a
 * membership deleted by any other route, must not leave a working key behind.
 */
export async function findApiKeyByHash(
  db: AppDb,
  keyHash: string,
): Promise<ApiKeyAuthRecord | null> {
  const [row] = await db
    .select({
      id: organizationApiKeys.id,
      organizationId: organizationApiKeys.organizationId,
      name: organizationApiKeys.name,
      prefix: organizationApiKeys.prefix,
      access: organizationApiKeys.access,
      createdByUserId: organizationApiKeys.createdByUserId,
      expiresAt: organizationApiKeys.expiresAt,
      lastUsedAt: organizationApiKeys.lastUsedAt,
    })
    .from(organizationApiKeys)
    .innerJoin(
      organizationMembers,
      and(
        eq(organizationMembers.organizationId, organizationApiKeys.organizationId),
        eq(organizationMembers.userId, organizationApiKeys.createdByUserId),
      ),
    )
    .where(eq(organizationApiKeys.keyHash, keyHash))
    .limit(1);
  return row ?? null;
}

export async function getApiKeyDescription(
  db: AppDb,
  keyId: string,
): Promise<{ name: string; prefix: string; access: ApiKeyAccess; expiresAt: Date } | null> {
  const [row] = await db
    .select({
      name: organizationApiKeys.name,
      prefix: organizationApiKeys.prefix,
      access: organizationApiKeys.access,
      expiresAt: organizationApiKeys.expiresAt,
    })
    .from(organizationApiKeys)
    .where(eq(organizationApiKeys.id, keyId))
    .limit(1);
  return row ?? null;
}

/**
 * Stamps `lastUsedAt` unless a concurrent request already did within the
 * debounce window; the cutoff repeats in the WHERE clause for that reason.
 */
export async function markApiKeyUsedIfStale(
  db: AppDb,
  keyId: string,
  staleBefore: Date,
  now: Date,
): Promise<void> {
  await db
    .update(organizationApiKeys)
    .set({ lastUsedAt: now })
    .where(
      and(
        eq(organizationApiKeys.id, keyId),
        or(isNull(organizationApiKeys.lastUsedAt), lt(organizationApiKeys.lastUsedAt, staleBefore)),
      ),
    );
}

/**
 * Audits a write an API key made. Key reads are not recorded, but a key that
 * starts reviews spends the organization's npm token and scan budget, so each
 * use names the key; the actor is its creator.
 */
export async function recordApiKeyAction(
  db: AppDb,
  apiKey: ApiKeyPrincipal,
  input: {
    type: "organization.api_key_review_started" | "organization.api_key_discovery_ran";
    scanId?: string;
    metadata: Record<string, unknown>;
  },
): Promise<void> {
  await recordScanEvent(db, {
    organizationId: apiKey.organizationId,
    actorUserId: apiKey.userId,
    scanId: input.scanId,
    type: input.type,
    metadata: { ...input.metadata, name: apiKey.name, prefix: apiKey.prefix },
  });
}
