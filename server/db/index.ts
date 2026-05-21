import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import * as schema from "./schema";
import { scans, scanFiles, scanFindings } from "./schema";
import type { DiffEntry, FileRecord, Finding, PackageJsonSummary } from "../lib/review";

export type AppDb = ReturnType<typeof drizzle<typeof schema>>;

export interface PersistedScanInput {
  id: string;
  stageId: string;
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

export function createDb(d1: D1Database) {
  return drizzle(d1, { schema });
}

export async function persistScan(db: AppDb, input: PersistedScanInput) {
  const now = new Date();
  await db.insert(scans).values({
    id: input.id,
    stageId: input.stageId,
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

export async function listScans(db: AppDb) {
  return db.select().from(scans).limit(50);
}

export async function getScan(db: AppDb, id: string) {
  const [scan] = await db.select().from(scans).where(eq(scans.id, id)).limit(1);
  if (!scan) return null;
  const files = await db.select().from(scanFiles).where(eq(scanFiles.scanId, id));
  const findings = await db.select().from(scanFindings).where(eq(scanFindings.scanId, id));
  return { scan, files, findings };
}
