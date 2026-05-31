import { and, eq, inArray } from "drizzle-orm";
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
  failureReason?: string | null;
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
    invalidatedAt: null,
    lastFailureReason: null,
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
        invalidatedAt: values.invalidatedAt,
        lastFailureReason: values.lastFailureReason,
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

export async function listAutoDiscoveryNpmConnections(db: AppDb) {
  return db
    .select()
    .from(npmConnections)
    .where(inArray(npmConnections.validationStatus, ["valid", "unvalidated"]));
}

export async function updateNpmConnectionValidation(
  db: AppDb,
  input: NpmConnectionValidationInput,
) {
  const now = new Date();
  const invalid = input.validationStatus === "invalid";
  await db
    .update(npmConnections)
    .set({
      validationStatus: input.validationStatus,
      capabilitiesJson: input.capabilities ?? null,
      validatedAt: input.validatedAt ?? null,
      invalidatedAt: invalid ? now : null,
      lastFailureReason: invalid ? (input.failureReason ?? null) : null,
      updatedAt: now,
    })
    .where(eq(npmConnections.organizationId, input.organizationId));
  return getNpmConnection(db, input.organizationId);
}

/**
 * Mark an org's npm connection as invalid because it stopped working during use
 * (e.g. the registry rejected the token with 401/403). Unlike
 * {@link updateNpmConnectionValidation} this preserves the existing capabilities
 * snapshot and only records the failure so the UI can surface it.
 */
export async function markNpmConnectionInvalid(
  db: AppDb,
  input: { organizationId: string; reason: string; tokenFingerprint?: string | null },
) {
  const now = new Date();
  const where = input.tokenFingerprint
    ? and(
        eq(npmConnections.organizationId, input.organizationId),
        eq(npmConnections.tokenFingerprint, input.tokenFingerprint),
      )
    : eq(npmConnections.organizationId, input.organizationId);
  const updated = await db
    .update(npmConnections)
    .set({
      validationStatus: "invalid",
      invalidatedAt: now,
      lastFailureReason: input.reason,
      updatedAt: now,
    })
    .where(where)
    .returning({ id: npmConnections.id });
  return updated.length > 0;
}

export async function markNpmConnectionUsed(db: AppDb, organizationId: string) {
  await db
    .update(npmConnections)
    .set({ lastUsedAt: new Date(), updatedAt: new Date() })
    .where(eq(npmConnections.organizationId, organizationId));
}

export async function deleteNpmConnection(db: AppDb, organizationId: string) {
  await db.delete(npmConnections).where(eq(npmConnections.organizationId, organizationId));
}
