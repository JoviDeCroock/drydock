import { seedLegacyScanJob } from "./seed-scan-job";
import { env } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { type AppDb, createDb } from "../../../server/db/client";
import { chunkForD1 } from "../../../server/db/d1-chunk";
import { type PersistedScanInput } from "../../../server/db/scans";
import * as schema from "../../../server/db/schema";
import { ensurePersonalOrganization } from "../../../server/db/organizations";
import { persistScanWithArtifacts } from "./persist-scan";

export interface SeededUser {
  db: AppDb;
  userId: string;
  email: string;
  organizationId: string;
}

export interface SeedUserOptions {
  name?: string;
  emailVerified?: boolean;
  // `false` leaves the user without a personal organization, for suites that
  // exercise the account itself (retention, verification) rather than org data.
  personalOrganization?: boolean;
}

// `ensurePersonalOrganization` returns null only when the user row is missing;
// a seeded user always has one, so a null here is a fixture bug, not a case.
export async function seedPersonalOrganization(db: AppDb, userId: string): Promise<string> {
  const organizationId = await ensurePersonalOrganization(db, { userId });
  if (!organizationId) throw new Error(`no personal organization for seeded user ${userId}`);
  return organizationId;
}

export async function seedUser(options: SeedUserOptions = {}): Promise<SeededUser> {
  const db = createDb(env.DB);
  const now = new Date();
  const userId = `user_${crypto.randomUUID()}`;
  const email = `${userId}@example.com`;
  await db.insert(schema.user).values({
    id: userId,
    name: options.name ?? "Tester",
    email,
    emailVerified: options.emailVerified ?? true,
    createdAt: now,
    updatedAt: now,
  });
  const organizationId =
    options.personalOrganization === false ? "" : await seedPersonalOrganization(db, userId);
  return { db, userId, email, organizationId };
}

export type ScanOwner = Pick<SeededUser, "userId" | "organizationId">;

type PersistInput = Omit<PersistedScanInput, "artifacts" | "report">;

export interface SeedCompletedScanOptions {
  scanId?: string;
  stageId?: string;
  packageJson?: PersistInput["packageJson"];
  risk?: string;
  summary?: PersistInput["summary"];
  ai?: PersistInput["ai"];
  files?: PersistInput["files"];
  diff?: PersistInput["diff"];
  findings?: PersistInput["findings"];
  aiFindingRecords?: PersistInput["aiFindingRecords"];
  reportDigest?: string;
  // Extra `seedLegacyScanJob` columns (source, registryUrl, ...) for suites that
  // exercise how the job row was opened.
  job?: Partial<Parameters<typeof seedLegacyScanJob>[1]>;
  // Columns written straight onto the job row before the scan is persisted,
  // for values `seedLegacyScanJob` derives itself or would act on (passing a
  // registry name there also supersedes earlier scans of the version), and
  // that `persistScan` reads back when it completes the row.
  jobColumns?: Partial<typeof schema.scans.$inferInsert>;
  // Anything else `persistScan` accepts (source, createdAt, provenance, ...)
  // spreads over the defaults last, so a suite can pin exactly the row it
  // needs without the helper growing an option per column.
  persist?: Partial<PersistInput>;
}

const DEFAULT_SCAN_FILES: NonNullable<PersistInput["files"]> = [
  { path: "package.json", size: 10, sha256: "a", flags: [], textSample: "{}" },
];
const DEFAULT_SCAN_DIFF: NonNullable<PersistInput["diff"]> = [
  { path: "package.json", status: "modified", flags: [] },
];

// Creates the job row and persists a complete scan with artifacts, returning
// the scan id. Every field a suite asserts on must be passed explicitly; the
// defaults only make the row valid.
export async function seedCompletedScan(
  owner: ScanOwner,
  options: SeedCompletedScanOptions = {},
): Promise<string> {
  const db = createDb(env.DB);
  const scanId = options.scanId ?? `scan_${crypto.randomUUID()}`;
  const stageId = options.stageId ?? `stage-${scanId.slice(-12)}`;
  await seedLegacyScanJob(db, {
    id: scanId,
    stageId,
    organizationId: owner.organizationId,
    ownerUserId: owner.userId,
    ...options.job,
  });
  if (options.jobColumns) {
    await db.update(schema.scans).set(options.jobColumns).where(eq(schema.scans.id, scanId));
  }
  await persistScanWithArtifacts(db, {
    id: scanId,
    stageId,
    organizationId: owner.organizationId,
    ownerUserId: owner.userId,
    packageJson: options.packageJson ?? { name: "@org/pkg", version: "1.1.0" },
    risk: options.risk ?? "low",
    status: "complete",
    summary: options.summary ?? { diff: [{ path: "package.json", status: "modified" }] },
    ai: options.ai ?? null,
    files: options.files ?? DEFAULT_SCAN_FILES,
    diff: options.diff ?? DEFAULT_SCAN_DIFF,
    findings: options.findings ?? [],
    aiFindingRecords: options.aiFindingRecords,
    ...options.persist,
  });
  return scanId;
}

/**
 * Fills watch slots directly, far faster than enrolling one at a time. They
 * count as checked just now so no sweep in a sharing suite picks them up.
 */
export async function seedPublicationWatches(db: AppDb, organizationId: string, count: number) {
  const now = new Date();
  const rows = Array.from({ length: count }, (_, i) => ({
    id: crypto.randomUUID(),
    organizationId,
    packageName: `filler-${String(i).padStart(3, "0")}`,
    source: "manual" as const,
    createdAt: now,
    lastCheckedAt: now,
  }));
  for (const chunk of chunkForD1(rows, 11))
    await db.insert(schema.publicationWatches).values(chunk);
}

/**
 * A GitHub workflow gate with its installation and release target, for scans
 * that need a real `gate_id`. Public disclosure of a gate review reads the
 * gate's decision, so a scan pointing at no gate row is never public.
 */
export async function seedWorkflowGate(
  owner: ScanOwner,
  options: {
    ecosystem?: "npm" | "pypi" | "vscode";
    decision?: "approved" | "rejected" | null;
  } = {},
): Promise<string> {
  const db = createDb(env.DB);
  const now = new Date();
  const installationId = crypto.randomUUID();
  const releaseTargetId = crypto.randomUUID();
  const gateId = crypto.randomUUID();
  const decision = options.decision === undefined ? "approved" : options.decision;
  const repositoryId = Math.floor(Math.random() * 1_000_000_000);
  await db.insert(schema.githubAppInstallations).values({
    id: installationId,
    organizationId: owner.organizationId,
    installationId: crypto.randomUUID(),
    accountLogin: "octo",
    accountType: "Organization",
    targetType: "Organization",
    status: "active",
    installedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.githubReleaseTargets).values({
    id: releaseTargetId,
    organizationId: owner.organizationId,
    installationRowId: installationId,
    ecosystem: options.ecosystem ?? "npm",
    repositoryId,
    repositoryFullName: "octo/release",
    environment: "production",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.githubWorkflowGates).values({
    id: gateId,
    organizationId: owner.organizationId,
    installationRowId: installationId,
    releaseTargetId,
    deliveryId: crypto.randomUUID(),
    repositoryId,
    repositoryFullName: "octo/release",
    environment: "production",
    runId: 987654,
    deploymentId: 123,
    deploymentCallbackUrl:
      "https://api.github.com/repos/octo/release/actions/runs/987654/deployment_protection_rule",
    eventAction: "requested",
    status: decision ?? "pending",
    decision,
    decidedAt: decision ? now : null,
    requestedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  return gateId;
}

/**
 * The publication monitor's record that npm published `version` with bytes
 * matching one of the organization's approvals: the evidence an npm gate
 * review needs before it is public.
 */
export async function seedApprovedPublication(
  owner: ScanOwner,
  input: { packageName: string; version: string; scanId?: string | null },
): Promise<void> {
  const db = createDb(env.DB);
  const now = new Date();
  await db
    .insert(schema.publicationWatches)
    .values({
      id: crypto.randomUUID(),
      organizationId: owner.organizationId,
      packageName: input.packageName,
      source: "manual",
      createdAt: now,
      lastCheckedAt: now,
    })
    .onConflictDoNothing();
  const [watch] = await db
    .select({ id: schema.publicationWatches.id })
    .from(schema.publicationWatches)
    .where(
      and(
        eq(schema.publicationWatches.organizationId, owner.organizationId),
        eq(schema.publicationWatches.packageName, input.packageName),
      ),
    )
    .limit(1);
  await db
    .insert(schema.publicationObservations)
    .values({
      id: crypto.randomUUID(),
      watchId: watch!.id,
      organizationId: owner.organizationId,
      version: input.version,
      firstSeenAt: now,
      checkedAt: now,
      status: "approved_match",
      scanId: input.scanId ?? null,
    })
    .onConflictDoNothing();
}
