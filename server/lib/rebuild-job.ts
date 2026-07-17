// Deferred rebuild-attestation job. Runs after a scan completes (queued by
// `scan-job.ts`), resolves the pending plan persisted in the scan summary:
// rebuilds the package from its declared repository in the disposable
// container (`rebuild-sandbox.ts`) and compares the result against the scan's
// persisted artifact hashes. The comparison happens entirely in the Worker —
// the container only ever returns a hash manifest, which is treated as hostile
// input. The outcome is advisory and never changes risk levels or findings.

import { createDb, type AppDb } from "../db/client";
import { updateScanRebuildAttestation } from "../db/scans";
import { errorMessage } from "./errors";
import { describeOperationalError, durationMsSince, emitOperationalEvent } from "./observability";
import {
  compareRebuildOutput,
  normalizeRebuildAttestation,
  type RebuildAttestation,
  type RebuildPlan,
  type RebuildSignal,
} from "./rebuild-attestation";
import type { RebuildExecution } from "./rebuild-steps";
import { loadScanArtifacts, scanArtifactReadBucket } from "./scan-artifacts";
import { eq, and } from "drizzle-orm";
import { scans } from "../db/schema";

export interface RebuildAttestationQueueMessage {
  kind: "rebuild_attestation";
  organizationId: string;
  scanId: string;
}

export type RebuildExecutor = (plan: RebuildPlan) => Promise<RebuildExecution>;

export interface ExecuteRebuildJobOptions {
  /** Test seam; defaults to the Cloudflare container executor. */
  executor?: RebuildExecutor;
}

export async function executeRebuildAttestationJob(
  env: Cloudflare.Env,
  message: RebuildAttestationQueueMessage,
  db: AppDb = createDb(env.DB),
  options: ExecuteRebuildJobOptions = {},
) {
  const startedAtMs = Date.now();
  const rows = await db
    .select({
      id: scans.id,
      organizationId: scans.organizationId,
      status: scans.status,
      summaryJson: scans.summaryJson,
      reportDigest: scans.reportDigest,
      artifactStorageVersion: scans.artifactStorageVersion,
      artifactManifestKey: scans.artifactManifestKey,
      artifactManifestDigest: scans.artifactManifestDigest,
      artifactManifestSize: scans.artifactManifestSize,
      reportArtifactKey: scans.reportArtifactKey,
      fileSamplesArtifactKey: scans.fileSamplesArtifactKey,
      diffArtifactKey: scans.diffArtifactKey,
    })
    .from(scans)
    .where(and(eq(scans.id, message.scanId), eq(scans.organizationId, message.organizationId)))
    .limit(1);
  const scan = rows[0];
  const summary =
    scan?.summaryJson && typeof scan.summaryJson === "object" && !Array.isArray(scan.summaryJson)
      ? (scan.summaryJson as Record<string, unknown>)
      : null;
  const pending = normalizeRebuildAttestation(summary?.rebuildAttestation);
  if (!scan || scan.status !== "complete" || !pending || pending.status !== "pending") {
    emitOperationalEvent("warn", "rebuild.job.skipped", {
      scanId: message.scanId,
      organizationId: message.organizationId,
      reason: !scan ? "scan_missing" : pending ? "not_pending" : "no_pending_plan",
      durationMs: durationMsSince(startedAtMs),
    });
    return null;
  }
  const plan = pending.plan!;

  const finalize = async (attestation: RebuildAttestation) => {
    await updateScanRebuildAttestation(db, message.scanId, message.organizationId, attestation);
    emitOperationalEvent(
      attestation.status === "inconclusive" ? "warn" : "info",
      "rebuild.job.completed",
      {
        scanId: message.scanId,
        organizationId: message.organizationId,
        status: attestation.status,
        repository: plan.repository,
        ref: attestation.ref ? `${attestation.ref.kind}:${attestation.ref.value}` : null,
        matchedFiles: attestation.comparison?.matchedFileCount ?? null,
        divergentFiles: attestation.comparison?.divergentPaths.length ?? null,
        durationMs: durationMsSince(startedAtMs),
      },
    );
    return attestation;
  };
  const inconclusive = (signals: RebuildSignal[]): RebuildAttestation => ({
    status: "inconclusive",
    plan,
    ref: null,
    toolchain: null,
    comparison: null,
    signals,
    completedAt: new Date().toISOString(),
  });

  if (!env.REBUILD_SANDBOX && !options.executor) {
    return finalize(
      inconclusive([
        { kind: "sandbox", detail: "rebuild sandbox is not configured in this environment" },
      ]),
    );
  }

  let execution: RebuildExecution;
  try {
    if (options.executor) {
      execution = await options.executor(plan);
    } else {
      // Lazy import keeps @cloudflare/sandbox out of the Worker boot graph for
      // the many requests that never touch a rebuild.
      const { runRebuildInSandbox } = await import("./rebuild-sandbox");
      execution = await runRebuildInSandbox(env.REBUILD_SANDBOX!, message.scanId, plan);
    }
  } catch (err) {
    emitOperationalEvent("error", "rebuild.job.failed", {
      scanId: message.scanId,
      organizationId: message.organizationId,
      repository: plan.repository,
      durationMs: durationMsSince(startedAtMs),
      error: describeOperationalError(err),
    });
    return finalize(
      inconclusive([{ kind: "sandbox", detail: safeSignalDetail(errorMessage(err)) }]),
    );
  }

  const stepSignals: RebuildSignal[] = execution.steps
    .filter((step) => step.exitCode !== 0)
    .map((step) => ({
      kind: "step-failed",
      detail: `${step.step} exited ${step.exitCode}${step.detail ? `: ${step.detail}` : ""}`,
    }));

  if (!execution.ok) {
    return finalize(inconclusive([{ kind: "rebuild", detail: execution.failure }, ...stepSignals]));
  }

  // Compare against the scan's persisted staged-file hashes (R2 files.json).
  // The staged bytes themselves are never re-fetched and never enter the
  // container.
  const artifacts = await loadScanArtifacts(scanArtifactReadBucket(env), scan);
  if (!artifacts) {
    return finalize(
      inconclusive([
        { kind: "artifacts", detail: "staged artifact hashes are unavailable for this scan" },
        ...stepSignals,
      ]),
    );
  }

  const outcome = compareRebuildOutput({
    expectedShasum: plan.expectedShasum,
    stagedFiles: artifacts.files.map((file) => ({ path: file.path, sha256: file.sha256 })),
    output: execution.output,
  });
  if (!outcome) {
    return finalize(
      inconclusive([
        { kind: "artifacts", detail: "staged file hashes are incomplete; cannot compare" },
        ...stepSignals,
      ]),
    );
  }

  return finalize({
    status: outcome.status,
    plan,
    ref: execution.ref,
    toolchain: execution.toolchain,
    comparison: outcome.comparison,
    signals: [
      {
        kind: "rebuild",
        detail: `checked out ${execution.ref.kind} ${execution.ref.value} and rebuilt with ${
          execution.toolchain.packageManager ?? "npm"
        }`,
      },
      ...stepSignals,
    ],
    completedAt: new Date().toISOString(),
  });
}

// Signals are rendered in the UI and exported in reports; error text can quote
// hostile input, so bound it and strip control characters.
function safeSignalDetail(text: string): string {
  return [...text]
    .map((ch) => (ch >= " " && ch !== "\u007f" ? ch : " "))
    .join("")
    .slice(0, 300);
}
