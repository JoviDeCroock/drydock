import { and, eq, gt, inArray, isNull, lte, or } from "drizzle-orm";
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
  validationStatus: string;
}

export type AutoDiscoveryNpmConnectionCursor = Pick<
  AutoDiscoveryNpmConnectionRef,
  "validationStatus" | "id"
>;

/**
 * One page of sweep-eligible connections, ordered by `(validation_status, id)`
 * so the caller can resume from the last composite key it saw. Matching the
 * keyset cursor and ordering to `npm_connections_validation_status_idx` lets
 * SQLite walk the covering index directly instead of sorting every remaining
 * eligible row into a temporary B-tree for each page.
 *
 * There is no separate auto-discovery flag: a connection is eligible while its
 * validation status is `valid` or `unvalidated`. `invalid` (expired/revoked
 * token, or discovery deliberately switched off) drops out of the sweep.
 */
export async function listAutoDiscoveryNpmConnectionRefs(
  db: AppDb,
  options: { limit: number; after?: AutoDiscoveryNpmConnectionCursor | null },
): Promise<AutoDiscoveryNpmConnectionRef[]> {
  const eligible = inArray(npmConnections.validationStatus, ["valid", "unvalidated"]);
  const after = options.after;
  const afterCursor = after
    ? or(
        gt(npmConnections.validationStatus, after.validationStatus),
        and(
          eq(npmConnections.validationStatus, after.validationStatus),
          gt(npmConnections.id, after.id),
        ),
      )
    : undefined;
  return db
    .select({
      id: npmConnections.id,
      organizationId: npmConnections.organizationId,
      validationStatus: npmConnections.validationStatus,
    })
    .from(npmConnections)
    .where(afterCursor ? and(eligible, afterCursor) : eligible)
    .orderBy(npmConnections.validationStatus, npmConnections.id)
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
