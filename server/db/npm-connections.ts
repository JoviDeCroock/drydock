import { and, eq, inArray, isNull, lte, or } from "drizzle-orm";
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

/** Credential-free registry authority lookup for orchestration paths. */
export async function getNpmConnectionRegistryUrl(
  db: AppDb,
  organizationId: string,
): Promise<string | null> {
  const [connection] = await db
    .select({ registryUrl: npmConnections.registryUrl })
    .from(npmConnections)
    .where(eq(npmConnections.organizationId, organizationId))
    .limit(1);
  return connection?.registryUrl ?? null;
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
