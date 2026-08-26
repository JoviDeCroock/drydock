import { and, asc, eq, gte, isNotNull, isNull, sql } from "drizzle-orm";
import type { AppDb } from "./client";
import { githubWorkflowGates, scanEvents, scans } from "./schema";

const MISMATCH_EVENT_PREFIX = "registry-digest-mismatch:";
const MISMATCH_OBSERVED_EVENT_PREFIX = "registry-digest-mismatch-observed:";

export interface RegistryVerificationScan {
  scanId: string;
  organizationId: string;
  packageName: string;
  stagedVersion: string;
  summaryJson: unknown;
  publicPackageKey: string | null;
  publicFeedListedAt: Date | null;
}

/** Approved package scans in a gate that still need a terminal registry check. */
export async function listGateScansPendingRegistryVerification(
  db: AppDb,
  organizationId: string,
  gateId: string,
): Promise<RegistryVerificationScan[]> {
  const rows = await db
    .select({
      scanId: scans.id,
      organizationId: scans.organizationId,
      packageName: scans.packageName,
      stagedVersion: scans.stagedVersion,
      summaryJson: scans.summaryJson,
      publicPackageKey: scans.publicPackageKey,
      publicFeedListedAt: scans.publicFeedListedAt,
    })
    .from(scans)
    .where(
      and(
        eq(scans.organizationId, organizationId),
        eq(scans.gateId, gateId),
        eq(scans.source, "workflow_gate"),
        eq(scans.status, "complete"),
        eq(scans.decision, "publish"),
        isNull(scans.registryVerifiedAt),
        isNotNull(scans.packageName),
        isNotNull(scans.stagedVersion),
        sql`not exists (
          select 1 from ${scanEvents}
          where ${scanEvents.id} = ${MISMATCH_EVENT_PREFIX} || ${scans.id}
        )`,
      ),
    );
  return rows.filter((row): row is RegistryVerificationScan =>
    Boolean(row.organizationId && row.packageName && row.stagedVersion),
  );
}

/** Distinct approved gates the cron should re-enqueue as a delivery backstop. */
export async function listGatesPendingRegistryVerification(
  db: AppDb,
  limit = 100,
  now = new Date(),
): Promise<Array<{ organizationId: string; gateId: string }>> {
  const activeSince = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const rows = await db
    .selectDistinct({
      organizationId: scans.organizationId,
      gateId: scans.gateId,
      decidedAt: githubWorkflowGates.decidedAt,
    })
    .from(scans)
    .innerJoin(githubWorkflowGates, eq(githubWorkflowGates.id, scans.gateId))
    .where(
      and(
        eq(githubWorkflowGates.status, "approved"),
        gte(githubWorkflowGates.decidedAt, activeSince),
        eq(scans.source, "workflow_gate"),
        eq(scans.status, "complete"),
        eq(scans.decision, "publish"),
        isNull(scans.registryVerifiedAt),
        isNotNull(scans.organizationId),
        isNotNull(scans.gateId),
        sql`json_extract(${scans.summaryJson}, '$.stagedPublish.provenance.mode') = 'workflow_gate'`,
        sql`not exists (
          select 1 from ${scanEvents}
          where ${scanEvents.id} = ${MISMATCH_EVENT_PREFIX} || ${scans.id}
        )`,
      ),
    )
    .orderBy(asc(githubWorkflowGates.decidedAt))
    .limit(limit);
  return rows.filter(
    (row): row is { organizationId: string; gateId: string; decidedAt: Date | null } =>
      Boolean(row.organizationId && row.gateId),
  );
}

/** CAS the manifest-claimed → registry-verified trust transition. */
export async function markScanRegistryVerified(
  db: AppDb,
  scanId: string,
  organizationId: string,
  verifiedAt: Date,
): Promise<boolean> {
  const pendingClaim = and(
    eq(scans.id, scanId),
    eq(scans.organizationId, organizationId),
    eq(scans.source, "workflow_gate"),
    isNull(scans.registryVerifiedAt),
  );
  const [, updated] = await db.batch([
    // Insert first, but only while the same CAS claim is live. D1 batches are
    // atomic and ordered: a failed audit insert rolls back the state update,
    // while a concurrent retry sees the completed update and inserts nothing.
    db
      .insert(scanEvents)
      .select(sql`
        select
          ${`registry-digest-verified:${scanId}`},
          ${organizationId},
          ${null},
          ${scanId},
          ${"scan.registry_digest_verified"},
          ${JSON.stringify({ verifiedAt: verifiedAt.toISOString() })},
          ${verifiedAt.getTime()}
        where exists (
          select 1 from ${scans} where ${pendingClaim}
        )
      `)
      .onConflictDoNothing(),
    db
      .update(scans)
      .set({ registryVerifiedAt: verifiedAt, updatedAt: verifiedAt })
      .where(pendingClaim)
      .returning({ id: scans.id }),
  ]);
  return updated.length > 0;
}

/** First time the registry exposed a disagreeing artifact set for this scan. */
export async function getOrRecordRegistryMismatchObservedAt(
  db: AppDb,
  input: { scanId: string; organizationId: string; now: Date },
): Promise<Date> {
  const eventId = `${MISMATCH_OBSERVED_EVENT_PREFIX}${input.scanId}`;
  const inserted = await db
    .insert(scanEvents)
    .values({
      id: eventId,
      organizationId: input.organizationId,
      scanId: input.scanId,
      type: "scan.registry_digest_mismatch_observed",
      metadataJson: null,
      createdAt: input.now,
    })
    .onConflictDoNothing()
    .returning({ createdAt: scanEvents.createdAt });
  if (inserted[0]) return inserted[0].createdAt;
  const [existing] = await db
    .select({ createdAt: scanEvents.createdAt })
    .from(scanEvents)
    .where(eq(scanEvents.id, eventId))
    .limit(1);
  if (!existing) throw new Error("registry mismatch observation vanished after insert");
  return existing.createdAt;
}

/** Persist exactly one durable mismatch alarm for a scan. */
export async function recordRegistryDigestMismatch(
  db: AppDb,
  input: {
    scanId: string;
    organizationId: string;
    ecosystem: string;
    packageName: string;
    version: string;
    reviewedDigests: string[];
    publishedDigests: string[];
    now: Date;
  },
): Promise<boolean> {
  const inserted = await db
    .insert(scanEvents)
    .values({
      id: `${MISMATCH_EVENT_PREFIX}${input.scanId}`,
      organizationId: input.organizationId,
      scanId: input.scanId,
      type: "scan.registry_digest_mismatch",
      metadataJson: {
        ecosystem: input.ecosystem,
        packageName: input.packageName,
        version: input.version,
        reviewedDigests: input.reviewedDigests,
        publishedDigests: input.publishedDigests,
      },
      createdAt: input.now,
    })
    .onConflictDoNothing()
    .returning({ id: scanEvents.id });
  return inserted.length > 0;
}
