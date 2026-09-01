/**
 * Scan job lifecycle.
 *
 * Creating, claiming, failing and discarding scan rows — everything that moves
 * a scan between pending/running/failed without writing results. Ownership is
 * organization-scoped on every statement; a scan is only ever claimed by the
 * organization that created it.
 */
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { deleteScanArtifacts } from "../lib/scan/artifacts";
import type { AppDb } from "./client";
import { chunkForD1 } from "./d1-chunk";
import { getScan } from "./scan-detail";
import { registrySupersessionPatch } from "./scan-registry-status";
import { scans } from "./schema";

export interface CreateScanJobInput {
  id: string;
  stageId: string;
  organizationId: string;
  ownerUserId: string;
  source?: ScanSource;
  /** Links a workflow-gate review scan back to its gate. */
  gateId?: string | null;
  /**
   * Package identity known before the tarball is inspected (from the staged
   * publishes listing or the gate bundle). Lets failed scans — including ones
   * whose tarball never parsed — still carry a display label; the pipeline
   * overwrites both with tarball-derived values when it completes.
   */
  packageName?: string | null;
  stagedVersion?: string | null;
  /** Registry base URL whose namespace the package coordinates belong to. */
  registryUrl?: string | null;
}

// `published` is a manual review of an already-public release: no registry
// credential, no staged candidate, and deliberately outside the registry
// status/supersession machinery below, which only tracks staged npm releases.
export const SCAN_SOURCES = ["manual", "auto_discovery", "workflow_gate", "published"] as const;
export type ScanSource = (typeof SCAN_SOURCES)[number];

export async function createScanJob(db: AppDb, input: CreateScanJobInput) {
  const now = new Date();
  const source = input.source ?? "manual";
  const values = {
    id: input.id,
    stageId: input.stageId,
    organizationId: input.organizationId,
    ownerUserId: input.ownerUserId,
    gateId: input.gateId ?? null,
    packageName: input.packageName ?? null,
    stagedVersion: input.stagedVersion ?? null,
    registryUrl: input.registryUrl ?? null,
    registryPackageName:
      source !== "workflow_gate" && input.registryUrl ? (input.packageName ?? null) : null,
    registryVersion:
      source !== "workflow_gate" && input.registryUrl ? (input.stagedVersion ?? null) : null,
    risk: "unknown",
    status: "pending",
    source,
    createdAt: now,
    updatedAt: now,
  };
  const create = db.insert(scans).values(values);
  if (source !== "workflow_gate" && input.registryUrl && input.packageName && input.stagedVersion) {
    await db.batch([
      create,
      db
        .update(scans)
        .set(registrySupersessionPatch(now))
        .where(
          and(
            eq(scans.organizationId, input.organizationId),
            eq(scans.registryUrl, input.registryUrl),
            eq(scans.registryPackageName, input.packageName),
            eq(scans.registryVersion, input.stagedVersion),
            inArray(scans.source, ["manual", "auto_discovery"]),
            isNull(scans.registryStatusSupersededAt),
            ne(scans.id, input.id),
          ),
        ),
    ]);
  } else {
    await create;
  }
  return getScan(db, input.id, input.organizationId);
}

/** Whether an organization-owned scan row still exists, without loading it. */
export async function scanExists(db: AppDb, scanId: string, organizationId: string) {
  const [row] = await db
    .select({ id: scans.id })
    .from(scans)
    .where(and(eq(scans.id, scanId), eq(scans.organizationId, organizationId)))
    .limit(1);
  return Boolean(row);
}

/**
 * Delete several still-pending scan rows in one statement per D1 parameter
 * chunk. Discovery uses this to roll back rows it created but never handed to
 * the scan queue; a sweep can prepare well over a hundred of them, and one
 * DELETE per row would turn a failure path into a hundred round trips.
 */
export async function deletePendingScanJobs(
  db: AppDb,
  scanIds: readonly string[],
  organizationId: string,
) {
  const ids = [...new Set(scanIds)];
  if (!ids.length) return;
  // One parameter per id, plus the organizationId and status predicates.
  for (const chunk of chunkForD1(ids, 1, 2)) {
    await db
      .delete(scans)
      .where(
        and(
          inArray(scans.id, chunk),
          eq(scans.organizationId, organizationId),
          eq(scans.status, "pending"),
        ),
      );
  }
}

export type DeleteFailedScanResult =
  | { outcome: "deleted"; source: string }
  | { outcome: "not_found" }
  | { outcome: "not_failed" };

/**
 * Delete one user-visible failed scan. The status predicate belongs on the
 * mutation itself so a stale client can never delete a scan that is still
 * running or has since completed.
 */
export async function deleteFailedScan(
  db: AppDb,
  scanId: string,
  organizationId: string,
): Promise<DeleteFailedScanResult> {
  const deleted = await db
    .delete(scans)
    .where(
      and(
        eq(scans.id, scanId),
        eq(scans.organizationId, organizationId),
        eq(scans.status, "failed"),
      ),
    )
    .returning({ source: scans.source });
  if (deleted[0]) return { outcome: "deleted", source: deleted[0].source };

  const [existing] = await db
    .select({ id: scans.id })
    .from(scans)
    .where(and(eq(scans.id, scanId), eq(scans.organizationId, organizationId)))
    .limit(1);
  return existing ? { outcome: "not_failed" } : { outcome: "not_found" };
}

export async function listExistingScanStageIds(
  db: AppDb,
  organizationId: string,
  stageIds: string[],
) {
  if (!stageIds.length) return new Set<string>();
  // Discovery passes every staged publish it saw, which is unbounded; each id
  // is one bound parameter, so chunk below D1's cap (reserving a slot for the
  // organizationId parameter) or the sweep throws "too many SQL variables"
  // once an org stages ~100 items.
  const known = new Set<string>();
  for (const chunk of chunkForD1([...new Set(stageIds)], 1, 1)) {
    const rows = await db
      .select({ stageId: scans.stageId })
      .from(scans)
      .where(and(inArray(scans.stageId, chunk), eq(scans.organizationId, organizationId)));
    for (const row of rows) known.add(row.stageId);
  }
  return known;
}

export const NON_TERMINAL_STATUSES = ["pending", "running"] as const;

export async function claimScanForRun(db: AppDb, scanId: string, organizationId: string) {
  const now = new Date();
  const claimed = await db
    .update(scans)
    .set({ status: "running", startedAt: now, updatedAt: now })
    .where(
      and(
        eq(scans.id, scanId),
        eq(scans.organizationId, organizationId),
        inArray(scans.status, [...NON_TERMINAL_STATUSES]),
      ),
    )
    .returning({ id: scans.id, status: scans.status });
  return claimed.length > 0;
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
    .where(
      and(
        eq(scans.id, scanId),
        eq(scans.organizationId, organizationId),
        inArray(scans.status, [...NON_TERMINAL_STATUSES]),
      ),
    );
}

export async function discardScanAttempt(db: AppDb, scanId: string, organizationId: string) {
  await db.delete(scans).where(and(eq(scans.id, scanId), eq(scans.organizationId, organizationId)));
}

/**
 * Remove every scan attached to a gate. Used to discard a partially-completed
 * review batch before it is re-run, so a retry does not leave orphaned
 * per-package scans behind (cascades to scan_files / scan_findings). Safe only
 * once the caller holds the gate's review claim and no representative scan is
 * attached. A prior attempt may have completed some packages and written their
 * R2 artifacts, so pass the ARTIFACTS bucket to tear those down too — the scan
 * ids are read before the D1 delete so the per-scan artifact prefixes are known.
 */
export async function discardGateScans(
  db: AppDb,
  gateId: string,
  organizationId: string,
  artifactBucket?: R2Bucket,
) {
  const condition = and(eq(scans.gateId, gateId), eq(scans.organizationId, organizationId));
  const discarded = artifactBucket
    ? await db.select({ id: scans.id }).from(scans).where(condition)
    : [];
  await db.delete(scans).where(condition);
  await Promise.all(
    discarded.map(({ id }) => deleteScanArtifacts(artifactBucket, organizationId, id)),
  );
}
