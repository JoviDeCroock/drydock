import { and, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { AppDb } from "./client";
import { npmConnections } from "./schema";

export interface NpmConnectionInput {
  organizationId: string;
  registryUrl: string;
  label: string;
  tokenCiphertext: string;
  tokenNonce: string;
  tokenFingerprint: string;
  tokenLast4?: string | null;
  createdByUserId: string;
}

export interface NpmConnectionValidationInput {
  organizationId: string;
  validationStatus: "valid" | "invalid" | "unvalidated";
  capabilities?: unknown;
  validatedAt?: Date | null;
}

export async function upsertNpmConnection(db: AppDb, input: NpmConnectionInput) {
  const now = new Date();
  const values = {
    id: crypto.randomUUID(),
    organizationId: input.organizationId,
    registryUrl: input.registryUrl,
    label: input.label,
    tokenCiphertext: input.tokenCiphertext,
    tokenNonce: input.tokenNonce,
    tokenFingerprint: input.tokenFingerprint,
    tokenLast4: input.tokenLast4 || null,
    validationStatus: "unvalidated",
    capabilitiesJson: null,
    validatedAt: null,
    lastUsedAt: null,
    createdByUserId: input.createdByUserId,
    createdAt: now,
    updatedAt: now,
  };

  await db
    .insert(npmConnections)
    .values(values)
    .onConflictDoUpdate({
      target: npmConnections.organizationId,
      set: {
        // Treat a saved replacement as a new connection generation. Deferred
        // discovery messages carry this id and are discarded if the row has
        // since been replaced, without putting registry or token metadata on
        // the queue.
        id: values.id,
        registryUrl: values.registryUrl,
        label: values.label,
        tokenCiphertext: values.tokenCiphertext,
        tokenNonce: values.tokenNonce,
        tokenFingerprint: values.tokenFingerprint,
        tokenLast4: values.tokenLast4,
        validationStatus: values.validationStatus,
        capabilitiesJson: values.capabilitiesJson,
        validatedAt: values.validatedAt,
        updatedAt: now,
      },
    });

  return getNpmConnection(db, input.organizationId);
}

export async function getNpmConnection(db: AppDb, organizationId: string) {
  const [connection] = await db
    .select()
    .from(npmConnections)
    .where(eq(npmConnections.organizationId, organizationId))
    .limit(1);
  return connection ?? null;
}

/**
 * A connection eligible for a scheduled discovery sweep. Only identifiers are
 * selected: the sweep consumer re-reads the full row (including the encrypted
 * token) from D1 when it runs, so no credential material has to travel through
 * a queue message.
 */
export interface AutoDiscoveryNpmConnectionRef {
  id: string;
  organizationId: string;
}

/**
 * One page of sweep-eligible connections, ordered by immutable organization id
 * so the caller can resume safely even while consumers validate or replace a
 * connection. `npm_connections_discovery_cursor_idx` covers the filter,
 * ordering, and selected columns without a temporary sort or table lookup.
 *
 * There is no separate auto-discovery flag: a connection is eligible while its
 * validation status is `valid` or `unvalidated`. `invalid` (expired/revoked
 * token, or discovery deliberately switched off) drops out of the sweep.
 */
export async function listAutoDiscoveryNpmConnectionRefs(
  db: AppDb,
  options: { limit: number; afterOrganizationId?: string | null },
): Promise<AutoDiscoveryNpmConnectionRef[]> {
  // Keep this literal predicate aligned with the partial discovery index in
  // schema.ts. Bound IN values cannot prove that a SQLite partial index applies,
  // so using inArray() here would fall back to scanning the primary-key index.
  const eligible = sql`${npmConnections.validationStatus} in ('valid', 'unvalidated')`;
  const afterCursor = options.afterOrganizationId
    ? gt(npmConnections.organizationId, options.afterOrganizationId)
    : undefined;
  return db
    .select({
      id: npmConnections.id,
      organizationId: npmConnections.organizationId,
    })
    .from(npmConnections)
    .where(afterCursor ? and(eligible, afterCursor) : eligible)
    .orderBy(npmConnections.organizationId)
    .limit(options.limit);
}

export async function updateNpmConnectionValidation(
  db: AppDb,
  input: NpmConnectionValidationInput,
) {
  await db
    .update(npmConnections)
    .set({
      validationStatus: input.validationStatus,
      capabilitiesJson: input.capabilities ?? null,
      validatedAt: input.validatedAt ?? null,
      updatedAt: new Date(),
    })
    .where(eq(npmConnections.organizationId, input.organizationId));
  return getNpmConnection(db, input.organizationId);
}

/**
 * Mark the exact connection generation invalid once. The status predicate makes
 * this an atomic claim: concurrent queue deliveries can observe the same
 * credential failure, but only one may emit the audit event and notification.
 */
export async function invalidateNpmConnectionIfCurrent(
  db: AppDb,
  input: {
    organizationId: string;
    connectionId: string;
    capabilities?: unknown;
  },
): Promise<boolean> {
  const invalidated = await db
    .update(npmConnections)
    .set({
      validationStatus: "invalid",
      capabilitiesJson: input.capabilities ?? null,
      validatedAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(npmConnections.organizationId, input.organizationId),
        eq(npmConnections.id, input.connectionId),
        inArray(npmConnections.validationStatus, ["valid", "unvalidated"]),
      ),
    )
    .returning({ id: npmConnections.id });
  return invalidated.length > 0;
}

/** Update validation only while the connection generation being checked remains current. */
export async function updateNpmConnectionValidationIfCurrent(
  db: AppDb,
  input: NpmConnectionValidationInput & {
    connectionId: string;
    expectedValidationStatus: string;
  },
): Promise<boolean> {
  const updated = await db
    .update(npmConnections)
    .set({
      validationStatus: input.validationStatus,
      capabilitiesJson: input.capabilities ?? null,
      validatedAt: input.validatedAt ?? null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(npmConnections.organizationId, input.organizationId),
        eq(npmConnections.id, input.connectionId),
        eq(npmConnections.validationStatus, input.expectedValidationStatus),
      ),
    )
    .returning({ id: npmConnections.id });
  return updated.length > 0;
}

export async function markNpmConnectionUsedIfStale(
  db: AppDb,
  organizationId: string,
  staleBefore: Date,
  now: Date,
): Promise<boolean> {
  const updated = await db
    .update(npmConnections)
    .set({ lastUsedAt: now, updatedAt: now })
    .where(
      and(
        eq(npmConnections.organizationId, organizationId),
        or(isNull(npmConnections.lastUsedAt), lte(npmConnections.lastUsedAt, staleBefore)),
      ),
    )
    .returning({ id: npmConnections.id });
  return updated.length > 0;
}

export async function markNpmConnectionUsed(db: AppDb, organizationId: string) {
  const now = new Date();
  await db
    .update(npmConnections)
    .set({ lastUsedAt: now, updatedAt: now })
    .where(eq(npmConnections.organizationId, organizationId));
}

export async function deleteNpmConnection(db: AppDb, organizationId: string) {
  await db.delete(npmConnections).where(eq(npmConnections.organizationId, organizationId));
}
