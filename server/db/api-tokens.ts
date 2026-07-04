import { and, eq, isNull } from "drizzle-orm";
import { base64UrlEncode } from "../lib/crypto-utils";
import type { AppDb } from "./client";
import { organizationApiTokens } from "./schema";

export const API_TOKEN_PREFIX = "drydock_";
const API_TOKEN_BYTES = 32;
const API_TOKEN_NAME_MAX = 80;

export const API_TOKEN_SCOPES = ["scans:read", "scans:write"] as const;
export type ApiTokenScope = (typeof API_TOKEN_SCOPES)[number];

const API_TOKEN_SCOPE_SET = new Set<string>(API_TOKEN_SCOPES);

export interface PublicApiToken {
  id: string;
  organizationId: string;
  name: string;
  scopes: ApiTokenScope[];
  tokenLast4: string;
  createdByUserId: string | null;
  lastUsedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuthenticatedApiToken extends PublicApiToken {
  tokenHash: string;
}

export interface CreateApiTokenInput {
  organizationId: string;
  name: string;
  scopes: ApiTokenScope[];
  createdByUserId: string;
}

export interface CreatedApiToken {
  token: PublicApiToken;
  secret: string;
}

export function isDrydockApiToken(value: string): boolean {
  return value.startsWith(API_TOKEN_PREFIX) && value.length > API_TOKEN_PREFIX.length + 16;
}

export function normalizeApiTokenName(value: unknown): string | null {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name) return null;
  return name.slice(0, API_TOKEN_NAME_MAX);
}

export function normalizeApiTokenScopes(value: unknown): ApiTokenScope[] | null {
  if (!Array.isArray(value)) return null;
  const scopes: ApiTokenScope[] = [];
  for (const scope of value) {
    if (typeof scope !== "string" || !API_TOKEN_SCOPE_SET.has(scope)) return null;
    if (!scopes.includes(scope as ApiTokenScope)) scopes.push(scope as ApiTokenScope);
  }
  return scopes.length > 0 ? scopes : null;
}

export function apiTokenHasScope(
  token: { scopes: readonly ApiTokenScope[] },
  scope: ApiTokenScope,
) {
  return token.scopes.includes(scope);
}

export async function hashApiToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return base64UrlEncode(new Uint8Array(digest));
}

export async function generateApiTokenSecret(): Promise<{ secret: string; tokenHash: string }> {
  const secret = `${API_TOKEN_PREFIX}${base64UrlEncode(
    crypto.getRandomValues(new Uint8Array(API_TOKEN_BYTES)),
  )}`;
  return { secret, tokenHash: await hashApiToken(secret) };
}

export async function createApiToken(
  db: AppDb,
  input: CreateApiTokenInput,
): Promise<CreatedApiToken> {
  const now = new Date();
  const { secret, tokenHash } = await generateApiTokenSecret();
  const id = crypto.randomUUID();
  await db.insert(organizationApiTokens).values({
    id,
    organizationId: input.organizationId,
    name: input.name,
    tokenHash,
    tokenLast4: secret.slice(-4),
    scopesJson: input.scopes,
    createdByUserId: input.createdByUserId,
    revokedByUserId: null,
    revokedAt: null,
    lastUsedAt: null,
    createdAt: now,
    updatedAt: now,
  });
  const token = await getApiToken(db, input.organizationId, id);
  if (!token) throw new Error("created API token could not be loaded");
  return { token, secret };
}

export async function listApiTokens(db: AppDb, organizationId: string): Promise<PublicApiToken[]> {
  const rows = await db
    .select()
    .from(organizationApiTokens)
    .where(
      and(
        eq(organizationApiTokens.organizationId, organizationId),
        isNull(organizationApiTokens.revokedAt),
      ),
    )
    .orderBy(organizationApiTokens.createdAt);
  return rows.map(publicApiToken);
}

export async function getApiToken(
  db: AppDb,
  organizationId: string,
  tokenId: string,
): Promise<PublicApiToken | null> {
  const [row] = await db
    .select()
    .from(organizationApiTokens)
    .where(
      and(
        eq(organizationApiTokens.organizationId, organizationId),
        eq(organizationApiTokens.id, tokenId),
        isNull(organizationApiTokens.revokedAt),
      ),
    )
    .limit(1);
  return row ? publicApiToken(row) : null;
}

export async function authenticateApiToken(
  db: AppDb,
  secret: string,
): Promise<AuthenticatedApiToken | null> {
  if (!isDrydockApiToken(secret)) return null;
  const tokenHash = await hashApiToken(secret);
  const [row] = await db
    .select()
    .from(organizationApiTokens)
    .where(
      and(eq(organizationApiTokens.tokenHash, tokenHash), isNull(organizationApiTokens.revokedAt)),
    )
    .limit(1);
  return row ? { ...publicApiToken(row), tokenHash: row.tokenHash } : null;
}

export async function markApiTokenUsed(db: AppDb, tokenId: string): Promise<void> {
  const now = new Date();
  await db
    .update(organizationApiTokens)
    .set({ lastUsedAt: now, updatedAt: now })
    .where(and(eq(organizationApiTokens.id, tokenId), isNull(organizationApiTokens.revokedAt)));
}

export async function revokeApiToken(
  db: AppDb,
  input: { organizationId: string; tokenId: string; revokedByUserId: string },
): Promise<PublicApiToken | null> {
  const existing = await getApiToken(db, input.organizationId, input.tokenId);
  if (!existing) return null;
  const now = new Date();
  await db
    .update(organizationApiTokens)
    .set({
      revokedAt: now,
      revokedByUserId: input.revokedByUserId,
      updatedAt: now,
    })
    .where(
      and(
        eq(organizationApiTokens.organizationId, input.organizationId),
        eq(organizationApiTokens.id, input.tokenId),
        isNull(organizationApiTokens.revokedAt),
      ),
    );
  return existing;
}

function publicApiToken(row: typeof organizationApiTokens.$inferSelect): PublicApiToken {
  return {
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    scopes: normalizeStoredScopes(row.scopesJson),
    tokenLast4: row.tokenLast4,
    createdByUserId: row.createdByUserId,
    lastUsedAt: row.lastUsedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function normalizeStoredScopes(value: unknown): ApiTokenScope[] {
  const scopes = normalizeApiTokenScopes(value);
  return scopes ?? [];
}
