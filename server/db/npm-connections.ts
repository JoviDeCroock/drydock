import { and, asc, eq, inArray, isNull, lte, or } from "drizzle-orm";
import type { AppDb } from "./client";
import { npmConnections } from "./schema";

export const DISCOVERY_ACTIVE_INTERVAL_MS = 15 * 60 * 1000;
export const DISCOVERY_QUIET_INTERVALS_MS = [
  60 * 60 * 1000,
  6 * 60 * 60 * 1000,
  24 * 60 * 60 * 1000,
] as const;
export const DISCOVERY_MAX_JITTER_MS = 15 * 60 * 1000;

export type NpmConnectionDiscoveryOutcome = "active" | "quiet" | "retry";

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

export interface NpmConnectionDiscoveryScheduleInput {
  organizationId: string;
  outcome: NpmConnectionDiscoveryOutcome;
  currentBackoffLevel?: number | null;
  now?: Date;
}

export interface NpmConnectionDiscoverySchedule {
  nextDiscoveryAt: Date;
  discoveryBackoffLevel: number;
  delayMs: number;
}

export function computeNextNpmConnectionDiscovery(
  input: Omit<NpmConnectionDiscoveryScheduleInput, "organizationId"> & { jitterMs?: number },
): NpmConnectionDiscoverySchedule {
  const now = input.now ?? new Date();
  const currentBackoffLevel = clampBackoffLevel(input.currentBackoffLevel ?? 0);
  const discoveryBackoffLevel =
    input.outcome === "quiet"
      ? Math.min(currentBackoffLevel + 1, DISCOVERY_QUIET_INTERVALS_MS.length)
      : input.outcome === "active"
        ? 0
        : currentBackoffLevel;
  const intervalMs =
    input.outcome === "quiet"
      ? DISCOVERY_QUIET_INTERVALS_MS[discoveryBackoffLevel - 1]!
      : DISCOVERY_ACTIVE_INTERVAL_MS;
  const jitterMs =
    input.jitterMs ??
    Math.floor(Math.random() * Math.min(intervalMs * 0.1, DISCOVERY_MAX_JITTER_MS));
  const safeJitterMs = Math.max(0, Math.min(jitterMs, DISCOVERY_MAX_JITTER_MS));
  const delayMs = intervalMs + safeJitterMs;

  return {
    nextDiscoveryAt: new Date(now.getTime() + delayMs),
    discoveryBackoffLevel,
    delayMs,
  };
}

function clampBackoffLevel(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(Math.floor(value), 0), DISCOVERY_QUIET_INTERVALS_MS.length);
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
    nextDiscoveryAt: null,
    discoveryBackoffLevel: 0,
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
        nextDiscoveryAt: values.nextDiscoveryAt,
        discoveryBackoffLevel: values.discoveryBackoffLevel,
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

export async function listAutoDiscoveryNpmConnections(
  db: AppDb,
  input: { now?: Date; limit?: number } = {},
) {
  const now = input.now ?? new Date();
  return db
    .select()
    .from(npmConnections)
    .where(
      and(
        inArray(npmConnections.validationStatus, ["valid", "unvalidated"]),
        or(isNull(npmConnections.nextDiscoveryAt), lte(npmConnections.nextDiscoveryAt, now)),
      ),
    )
    .orderBy(asc(npmConnections.nextDiscoveryAt), asc(npmConnections.createdAt))
    .limit(input.limit ?? 100);
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
      nextDiscoveryAt: null,
      discoveryBackoffLevel: 0,
      updatedAt: new Date(),
    })
    .where(eq(npmConnections.organizationId, input.organizationId));
  return getNpmConnection(db, input.organizationId);
}

export async function markNpmConnectionUsed(db: AppDb, organizationId: string) {
  await db
    .update(npmConnections)
    .set({ lastUsedAt: new Date(), updatedAt: new Date() })
    .where(eq(npmConnections.organizationId, organizationId));
}

export async function scheduleNextNpmConnectionDiscovery(
  db: AppDb,
  input: NpmConnectionDiscoveryScheduleInput,
) {
  const schedule = computeNextNpmConnectionDiscovery(input);
  await db
    .update(npmConnections)
    .set({
      nextDiscoveryAt: schedule.nextDiscoveryAt,
      discoveryBackoffLevel: schedule.discoveryBackoffLevel,
      updatedAt: new Date(),
    })
    .where(eq(npmConnections.organizationId, input.organizationId));
  return schedule;
}

export async function deleteNpmConnection(db: AppDb, organizationId: string) {
  await db.delete(npmConnections).where(eq(npmConnections.organizationId, organizationId));
}
