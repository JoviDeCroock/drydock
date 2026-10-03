import { and, asc, count, eq, isNull, lt, or } from "drizzle-orm";
import type { AppDb } from "./client";
import { organizationApiKeys, user } from "./schema";

export interface OrganizationApiKey {
  id: string;
  name: string;
  prefix: string;
  createdAt: Date;
  expiresAt: Date;
  lastUsedAt: Date | null;
  createdBy: { userId: string; email: string | null; name: string | null };
}

export interface ApiKeyAuthRecord {
  id: string;
  organizationId: string;
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

export async function countOrganizationApiKeys(db: AppDb, organizationId: string): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(organizationApiKeys)
    .where(eq(organizationApiKeys.organizationId, organizationId));
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

export async function findApiKeyByHash(
  db: AppDb,
  keyHash: string,
): Promise<ApiKeyAuthRecord | null> {
  const [row] = await db
    .select({
      id: organizationApiKeys.id,
      organizationId: organizationApiKeys.organizationId,
      expiresAt: organizationApiKeys.expiresAt,
      lastUsedAt: organizationApiKeys.lastUsedAt,
    })
    .from(organizationApiKeys)
    .where(eq(organizationApiKeys.keyHash, keyHash))
    .limit(1);
  return row ?? null;
}

export async function getApiKeyDescription(
  db: AppDb,
  keyId: string,
): Promise<{ name: string; prefix: string; expiresAt: Date } | null> {
  const [row] = await db
    .select({
      name: organizationApiKeys.name,
      prefix: organizationApiKeys.prefix,
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
