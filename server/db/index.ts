import { drizzle } from "drizzle-orm/d1";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import * as schema from "./schema";
import {
  npmConnections,
  organizationMembers,
  organizations,
  rateLimits,
  scanEvents,
  scanFiles,
  scanFindings,
  scans,
} from "./schema";
import { personalOrganizationId } from "../lib/ownership";
import type { DiffEntry, FileRecord, Finding, PackageJsonSummary } from "../lib/review";

export type AppDb = ReturnType<typeof drizzle<typeof schema>>;

export interface WorkspaceSession {
  userId: string;
  email?: string;
  name?: string;
}

export interface PersistedScanInput {
  id: string;
  stageId: string;
  organizationId: string;
  ownerUserId: string;
  packageJson?: PackageJsonSummary | null;
  previousPackageJson?: PackageJsonSummary | null;
  risk: string;
  status: string;
  summary: unknown;
  ai: unknown;
  files: FileRecord[];
  diff: DiffEntry[];
  findings: Finding[];
  report?: { version: number; digest: string };
}

export interface CreateScanJobInput {
  id: string;
  stageId: string;
  organizationId: string;
  ownerUserId: string;
}

export interface AuditEventInput {
  organizationId: string;
  actorUserId?: string | null;
  scanId?: string | null;
  type: string;
  metadata?: unknown;
}

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

export interface RateLimitInput {
  key: string;
  limit: number;
  windowMs: number;
}

export class RateLimitError extends Error {
  constructor(public retryAfterSeconds: number) {
    super("rate limit exceeded");
    this.name = "RateLimitError";
  }
}

export function createDb(d1: D1Database) {
  return drizzle(d1, { schema });
}

export async function ensurePersonalOrganization(db: AppDb, session: WorkspaceSession) {
  const organizationId = personalOrganizationId(session.userId);
  const now = new Date();
  const name = session.name || session.email || "Personal workspace";

  await db
    .insert(organizations)
    .values({
      id: organizationId,
      name,
      ownerUserId: session.userId,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();

  await db
    .insert(organizationMembers)
    .values({
      id: `member:${organizationId}:${session.userId}`,
      organizationId,
      userId: session.userId,
      role: "owner",
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();

  return organizationId;
}

export async function enforceRateLimit(db: AppDb, input: RateLimitInput) {
  const nowMs = Date.now();
  const bucket = Math.floor(nowMs / input.windowMs);
  const key = `${input.key}:${bucket}`;
  const expiresAt = new Date((bucket + 1) * input.windowMs);
  const now = new Date(nowMs);

  await db
    .insert(rateLimits)
    .values({
      key,
      count: 1,
      expiresAt,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: rateLimits.key,
      set: {
        count: sql`${rateLimits.count} + 1`,
        updatedAt: now,
      },
    });

  const [entry] = await db.select().from(rateLimits).where(eq(rateLimits.key, key)).limit(1);
  if (Math.random() < 0.01) {
    await db.delete(rateLimits).where(lt(rateLimits.expiresAt, new Date(nowMs - input.windowMs)));
  }
  if ((entry?.count ?? 0) > input.limit) {
    throw new RateLimitError(Math.max(1, Math.ceil((expiresAt.getTime() - nowMs) / 1000)));
  }
}

export async function recordScanEvent(db: AppDb, input: AuditEventInput) {
  await db.insert(scanEvents).values({
    id: crypto.randomUUID(),
    organizationId: input.organizationId,
    actorUserId: input.actorUserId || null,
    scanId: input.scanId || null,
    type: input.type,
    metadataJson: input.metadata ?? null,
    createdAt: new Date(),
  });
}

export async function createScanJob(db: AppDb, input: CreateScanJobInput) {
  const now = new Date();
  await db.insert(scans).values({
    id: input.id,
    stageId: input.stageId,
    organizationId: input.organizationId,
    ownerUserId: input.ownerUserId,
    risk: "unknown",
    status: "pending",
    createdAt: now,
    updatedAt: now,
  });
  return getScan(db, input.id, input.organizationId);
}

export async function markScanRunning(db: AppDb, scanId: string, organizationId: string) {
  const now = new Date();
  await db
    .update(scans)
    .set({ status: "running", startedAt: now, updatedAt: now })
    .where(and(eq(scans.id, scanId), eq(scans.organizationId, organizationId)));
}

export async function markScanFailed(
  db: AppDb,
  scanId: string,
  organizationId: string,
  error: { message: string; code?: string; detail?: string },
) {
  await db
    .update(scans)
    .set({
      status: "failed",
      risk: "unknown",
      errorJson: error,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(scans.id, scanId), eq(scans.organizationId, organizationId)));
}

export async function persistScan(db: AppDb, input: PersistedScanInput) {
  const now = new Date();
  const scanValues = {
    id: input.id,
    stageId: input.stageId,
    organizationId: input.organizationId,
    ownerUserId: input.ownerUserId,
    packageName: input.packageJson?.name || null,
    stagedVersion: input.packageJson?.version || null,
    previousVersion: input.previousPackageJson?.version || null,
    risk: input.risk,
    status: input.status,
    summaryJson: input.summary,
    aiJson: input.ai,
    errorJson: null,
    reportVersion: input.report?.version ?? null,
    reportDigest: input.report?.digest ?? null,
    completedAt: now,
    createdAt: now,
    updatedAt: now,
  };

  await db
    .insert(scans)
    .values(scanValues)
    .onConflictDoUpdate({
      target: scans.id,
      set: {
        packageName: scanValues.packageName,
        stagedVersion: scanValues.stagedVersion,
        previousVersion: scanValues.previousVersion,
        risk: scanValues.risk,
        status: scanValues.status,
        summaryJson: scanValues.summaryJson,
        aiJson: scanValues.aiJson,
        errorJson: scanValues.errorJson,
        reportVersion: scanValues.reportVersion,
        reportDigest: scanValues.reportDigest,
        completedAt: scanValues.completedAt,
        updatedAt: now,
      },
    });

  await Promise.all([
    db.delete(scanFiles).where(eq(scanFiles.scanId, input.id)),
    db.delete(scanFindings).where(eq(scanFindings.scanId, input.id)),
  ]);

  const diffByPath = new Map(input.diff.map((entry) => [entry.path, entry]));
  const rows = input.files.map((file) => {
    const entry = diffByPath.get(file.path);
    return {
      id: crypto.randomUUID(),
      scanId: input.id,
      path: file.path,
      status: entry?.status || "unknown",
      size: file.size,
      sha256: file.sha256,
      flagsJson: file.flags,
      textSample: file.textSample || null,
    };
  });

  await Promise.all([
    rows.length ? db.insert(scanFiles).values(rows) : Promise.resolve(),
    input.findings.length
      ? db.insert(scanFindings).values(
          input.findings.map((finding) => ({
            id: crypto.randomUUID(),
            scanId: input.id,
            severity: finding.severity,
            file: finding.file,
            evidence: finding.evidence,
            reason: finding.reason,
            source: "rule",
          })),
        )
      : Promise.resolve(),
  ]);
}

export async function listScans(db: AppDb, organizationId: string) {
  return db
    .select({
      id: scans.id,
      stageId: scans.stageId,
      organizationId: scans.organizationId,
      ownerUserId: scans.ownerUserId,
      packageName: scans.packageName,
      stagedVersion: scans.stagedVersion,
      previousVersion: scans.previousVersion,
      risk: scans.risk,
      status: scans.status,
      reportVersion: scans.reportVersion,
      reportDigest: scans.reportDigest,
      startedAt: scans.startedAt,
      completedAt: scans.completedAt,
      createdAt: scans.createdAt,
      updatedAt: scans.updatedAt,
    })
    .from(scans)
    .where(eq(scans.organizationId, organizationId))
    .orderBy(desc(scans.createdAt))
    .limit(50);
}

export async function getScan(db: AppDb, id: string, organizationId: string) {
  const [scanRows, files, findings] = await Promise.all([
    db
      .select()
      .from(scans)
      .where(and(eq(scans.id, id), eq(scans.organizationId, organizationId)))
      .limit(1),
    db.select().from(scanFiles).where(eq(scanFiles.scanId, id)),
    db.select().from(scanFindings).where(eq(scanFindings.scanId, id)),
  ]);
  const scan = scanRows[0];
  if (!scan) return null;
  return { scan, files, findings };
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

export async function markNpmConnectionUsed(db: AppDb, organizationId: string) {
  await db
    .update(npmConnections)
    .set({ lastUsedAt: new Date(), updatedAt: new Date() })
    .where(eq(npmConnections.organizationId, organizationId));
}

export async function deleteNpmConnection(db: AppDb, organizationId: string) {
  await db.delete(npmConnections).where(eq(npmConnections.organizationId, organizationId));
}
