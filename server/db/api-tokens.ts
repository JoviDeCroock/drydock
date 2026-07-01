import { and, desc, eq } from "drizzle-orm";
import type { AppDb } from "./client";
import { apiTokens } from "./schema";

export const API_TOKEN_SCOPES = ["read"] as const;
export type ApiTokenScope = (typeof API_TOKEN_SCOPES)[number];

export interface CreateApiTokenInput {
  organizationId: string;
  name: string;
  tokenHash: string;
  tokenPrefix: string;
  scope?: ApiTokenScope;
  createdByUserId: string;
  expiresAt?: Date | null;
}

export interface ApiTokenSummary {
  id: string;
  name: string;
  tokenPrefix: string;
  scope: string;
  createdByUserId: string | null;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
}

// Never selects tokenHash — callers only ever need the display metadata.
function toSummary(row: typeof apiTokens.$inferSelect): ApiTokenSummary {
  return {
    id: row.id,
    name: row.name,
    tokenPrefix: row.tokenPrefix,
    scope: row.scope,
    createdByUserId: row.createdByUserId,
    lastUsedAt: row.lastUsedAt,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  };
}

export async function createApiToken(
  db: AppDb,
  input: CreateApiTokenInput,
): Promise<ApiTokenSummary> {
  const now = new Date();
  const [row] = await db
    .insert(apiTokens)
    .values({
      id: crypto.randomUUID(),
      organizationId: input.organizationId,
      name: input.name,
      tokenPrefix: input.tokenPrefix,
      tokenHash: input.tokenHash,
      scope: input.scope ?? "read",
      createdByUserId: input.createdByUserId,
      expiresAt: input.expiresAt ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return toSummary(row);
}

// Active tokens only (never revoked) for the org's management view, newest
// first. Revoked tokens are dropped from the row on revoke, so no filter needed
// beyond the org scope.
export async function listApiTokens(db: AppDb, organizationId: string): Promise<ApiTokenSummary[]> {
  const rows = await db
    .select()
    .from(apiTokens)
    .where(eq(apiTokens.organizationId, organizationId))
    .orderBy(desc(apiTokens.createdAt));
  return rows.map(toSummary);
}

// Hard-delete on revoke: an org-scoped credential that is gone can never be
// presented again, and keeping a tombstone row buys nothing here.
export async function revokeApiToken(
  db: AppDb,
  organizationId: string,
  tokenId: string,
): Promise<boolean> {
  const deleted = await db
    .delete(apiTokens)
    .where(and(eq(apiTokens.id, tokenId), eq(apiTokens.organizationId, organizationId)))
    .returning({ id: apiTokens.id });
  return deleted.length > 0;
}

export interface ResolvedApiToken {
  tokenId: string;
  organizationId: string;
  scope: string;
}

// Resolve a presented token hash to its org context, enforcing revocation and
// expiry. Returns null for any miss so the caller maps every failure mode to a
// single opaque 401 (no oracle for which token exists).
export async function resolveApiToken(
  db: AppDb,
  tokenHash: string,
): Promise<ResolvedApiToken | null> {
  const [row] = await db
    .select()
    .from(apiTokens)
    .where(eq(apiTokens.tokenHash, tokenHash))
    .limit(1);
  if (!row) return null;
  if (row.revokedAt && row.revokedAt.getTime() <= Date.now()) return null;
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return null;
  return { tokenId: row.id, organizationId: row.organizationId, scope: row.scope };
}

// Best-effort "last used" stamp. Callers run this via waitUntil so a write
// failure never blocks the read path it annotates.
export async function touchApiTokenLastUsed(db: AppDb, tokenId: string): Promise<void> {
  const now = new Date();
  await db
    .update(apiTokens)
    .set({ lastUsedAt: now, updatedAt: now })
    .where(eq(apiTokens.id, tokenId));
}
