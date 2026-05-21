import { drizzle } from "drizzle-orm/d1";
import { and, desc, eq } from "drizzle-orm";
import * as schema from "./schema";
import { organizationMembers, organizations, scanEvents, scanFiles, scanFindings, scans } from "./schema";
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
}

export interface AuditEventInput {
  organizationId: string;
  actorUserId?: string | null;
  scanId?: string | null;
  type: string;
  metadata?: unknown;
}

export function createDb(d1: D1Database) {
  return drizzle(d1, { schema });
}

export async function ensurePersonalOrganization(db: AppDb, session: WorkspaceSession) {
  const organizationId = personalOrganizationId(session.userId);
  const now = new Date();
  const name = session.name || session.email || "Personal workspace";

  await db.insert(organizations).values({
    id: organizationId,
    name,
    ownerUserId: session.userId,
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing();

  await db.insert(organizationMembers).values({
    id: `member:${organizationId}:${session.userId}`,
    organizationId,
    userId: session.userId,
    role: "owner",
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing();

  return organizationId;
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

export async function persistScan(db: AppDb, input: PersistedScanInput) {
  const now = new Date();
  await db.insert(scans).values({
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
    createdAt: now,
    updatedAt: now,
  });

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
  if (rows.length) await db.insert(scanFiles).values(rows);

  if (input.findings.length) {
    await db.insert(scanFindings).values(
      input.findings.map((finding) => ({
        id: crypto.randomUUID(),
        scanId: input.id,
        severity: finding.severity,
        file: finding.file,
        evidence: finding.evidence,
        reason: finding.reason,
        source: "rule",
      })),
    );
  }
}

export async function listScans(db: AppDb, organizationId: string) {
  return db
    .select()
    .from(scans)
    .where(eq(scans.organizationId, organizationId))
    .orderBy(desc(scans.createdAt))
    .limit(50);
}

export async function getScan(db: AppDb, id: string, organizationId: string) {
  const [scan] = await db
    .select()
    .from(scans)
    .where(and(eq(scans.id, id), eq(scans.organizationId, organizationId)))
    .limit(1);
  if (!scan) return null;
  const files = await db.select().from(scanFiles).where(eq(scanFiles.scanId, id));
  const findings = await db.select().from(scanFindings).where(eq(scanFindings.scanId, id));
  return { scan, files, findings };
}
