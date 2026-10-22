import { and, eq, inArray, lt, or } from "drizzle-orm";
import { readPyPiProvenance } from "../lib/detonation/pypi";
import type {
  DetonationErrorCode,
  DetonationResult,
  DetonationStatus,
} from "../lib/detonation/types";
import type { AppDb } from "./client";
import { scanDetonations, scans } from "./schema";

/**
 * A run that has not finished after this long is presumed lost (the Worker
 * was evicted mid-run) and may be replaced by a rerun.
 */
const DETONATION_STALE_AFTER_MS = 20 * 60 * 1000;

export type DetonationTarget =
  | {
      kind: "npm_stage";
      scanId: string;
      organizationId: string;
      stageId: string;
      registryUrl: string | null;
      summaryJson: unknown;
    }
  | {
      kind: "pypi_gate";
      scanId: string;
      organizationId: string;
      gateId: string;
      summaryJson: unknown;
    };

/**
 * The scan a detonation would run against: completed, owned by the
 * organization, and either an npm staged review (bytes fetched again from the
 * stage) or a PyPI workflow-gate review (bytes fetched again from the gate's
 * GitHub Actions artifact). Published pairs, and npm or VS Code gate uploads,
 * are not eligible.
 */
export async function getDetonationTarget(
  db: AppDb,
  scanId: string,
  organizationId: string,
): Promise<DetonationTarget | null> {
  const [row] = await db
    .select({
      scanId: scans.id,
      stageId: scans.stageId,
      source: scans.source,
      gateId: scans.gateId,
      registryUrl: scans.registryUrl,
      summaryJson: scans.summaryJson,
    })
    .from(scans)
    .where(
      and(
        eq(scans.id, scanId),
        eq(scans.organizationId, organizationId),
        eq(scans.status, "complete"),
        inArray(scans.source, ["manual", "auto_discovery", "workflow_gate"]),
      ),
    )
    .limit(1);
  if (!row) return null;
  if (row.source !== "workflow_gate") {
    return {
      kind: "npm_stage",
      scanId: row.scanId,
      organizationId,
      stageId: row.stageId,
      registryUrl: row.registryUrl,
      summaryJson: row.summaryJson,
    };
  }
  // The gate runner names each package scan `workflow-gate:<gate>:<ecosystem>:<name>`
  // from trusted state, and the pipeline records the reviewed digests in a
  // PyPI provenance block. Both must agree before the gate's artifact counts
  // as this scan's bytes.
  if (
    row.gateId === null ||
    !row.stageId.startsWith(`workflow-gate:${row.gateId}:pypi:`) ||
    readPyPiProvenance(row.summaryJson) === null
  ) {
    return null;
  }
  return {
    kind: "pypi_gate",
    scanId: row.scanId,
    organizationId,
    gateId: row.gateId,
    summaryJson: row.summaryJson,
  };
}

/**
 * Queue a run, replacing any finished or stale one. Returns false while a
 * live run holds the row, so a double-click or a replayed message cannot
 * start a second container for the same scan.
 */
export async function requestScanDetonation(
  db: AppDb,
  input: {
    scanId: string;
    organizationId: string;
    runId: string;
    requestedByUserId: string | null;
    now: Date;
  },
): Promise<boolean> {
  const staleBefore = new Date(input.now.getTime() - DETONATION_STALE_AFTER_MS);
  const rows = await db
    .insert(scanDetonations)
    .values({
      scanId: input.scanId,
      organizationId: input.organizationId,
      runId: input.runId,
      status: "queued",
      requestedByUserId: input.requestedByUserId,
      requestedAt: input.now,
    })
    .onConflictDoUpdate({
      target: scanDetonations.scanId,
      set: {
        runId: input.runId,
        status: "queued",
        requestedByUserId: input.requestedByUserId,
        requestedAt: input.now,
        startedAt: null,
        completedAt: null,
        resultJson: null,
        errorCode: null,
        artifactSha256: null,
      },
      setWhere: and(
        eq(scanDetonations.organizationId, input.organizationId),
        or(
          inArray(scanDetonations.status, ["complete", "failed", "skipped"]),
          lt(scanDetonations.requestedAt, staleBefore),
        ),
      ),
    })
    .returning({ runId: scanDetonations.runId });
  return rows.some((row) => row.runId === input.runId);
}

/** Claim a queued run. Only the current run id can claim, and only once. */
export async function claimScanDetonation(
  db: AppDb,
  input: { scanId: string; organizationId: string; runId: string; now: Date },
): Promise<boolean> {
  const rows = await db
    .update(scanDetonations)
    .set({ status: "running", startedAt: input.now })
    .where(
      and(
        eq(scanDetonations.scanId, input.scanId),
        eq(scanDetonations.organizationId, input.organizationId),
        eq(scanDetonations.runId, input.runId),
        eq(scanDetonations.status, "queued"),
      ),
    )
    .returning({ runId: scanDetonations.runId });
  return rows.length > 0;
}

/** Hand a claimed run back to `queued` when no container could be started for it. */
export async function releaseScanDetonationClaim(
  db: AppDb,
  input: { scanId: string; organizationId: string; runId: string },
): Promise<void> {
  await db
    .update(scanDetonations)
    .set({ status: "queued", startedAt: null })
    .where(
      and(
        eq(scanDetonations.scanId, input.scanId),
        eq(scanDetonations.organizationId, input.organizationId),
        eq(scanDetonations.runId, input.runId),
        eq(scanDetonations.status, "running"),
      ),
    );
}

export async function completeScanDetonation(
  db: AppDb,
  input: {
    scanId: string;
    organizationId: string;
    runId: string;
    status: Extract<DetonationStatus, "complete" | "failed" | "skipped">;
    result: DetonationResult | null;
    errorCode: DetonationErrorCode | null;
    artifactSha256: string | null;
    now: Date;
  },
): Promise<void> {
  await db
    .update(scanDetonations)
    .set({
      status: input.status,
      resultJson: input.result,
      errorCode: input.errorCode,
      artifactSha256: input.artifactSha256,
      completedAt: input.now,
    })
    .where(
      and(
        eq(scanDetonations.scanId, input.scanId),
        eq(scanDetonations.organizationId, input.organizationId),
        eq(scanDetonations.runId, input.runId),
      ),
    );
}

export async function getScanDetonation(
  db: AppDb,
  scanId: string,
  organizationId: string,
  now = Date.now(),
) {
  const [row] = await db
    .select({
      status: scanDetonations.status,
      resultJson: scanDetonations.resultJson,
      errorCode: scanDetonations.errorCode,
      artifactSha256: scanDetonations.artifactSha256,
      requestedAt: scanDetonations.requestedAt,
      startedAt: scanDetonations.startedAt,
      completedAt: scanDetonations.completedAt,
    })
    .from(scanDetonations)
    .where(
      and(eq(scanDetonations.scanId, scanId), eq(scanDetonations.organizationId, organizationId)),
    )
    .limit(1);
  if (!row) return null;
  const live = row.status === "queued" || row.status === "running";
  return { ...row, stale: live && row.requestedAt.getTime() < now - DETONATION_STALE_AFTER_MS };
}
