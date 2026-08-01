import { type AppDb, createDb } from "../../db/client";
import { applyAiReviewPatch, getScanStatus } from "../../db/scans";
import { AI_MODEL } from "../ai-review/models";
import type { AiReview } from "../ai-review/types";
import { displayedAiResult } from "../ai-review/types";
import { combineRisk, normalizeRisk, type CodePatternSet } from "../review";
import {
  computeScanRiskBreakdown,
  normalizeScanRiskBreakdown,
  type ScanRiskBreakdown,
} from "../review/risk";
import { recordProductEvent } from "../platform/analytics";
import {
  describeOperationalError,
  durationMsSince,
  emitOperationalEvent,
} from "../platform/observability";
import {
  deleteAiReviewInput,
  loadAiReviewInput,
  rewriteReportWithAiReview,
  type AiReviewInputDescriptor,
  type AiReviewInputPayload,
  type RewrittenReportArtifacts,
} from "./artifacts";
import type { AiReviewQueueMessage } from "./job-messages";
import { mergeAiFindings } from "./pipeline-phases";
import { normalizeReleaseConsistency } from "./release-memory";

export interface ExecuteAiReviewJobOptions {
  attempt?: number;
  /** Last delivery: close the review out instead of throwing for a retry. */
  finalAttempt?: boolean;
}

export type AiReviewJobOutcome =
  | { outcome: "patched"; status: string }
  | { outcome: "skipped"; reason: string };

/**
 * Run the advisory AI review for a scan whose deterministic report is already
 * persisted and readable, then patch the review — its findings, the risk
 * breakdown, and the canonical report artifact — into that scan.
 *
 * Invariants this preserves:
 *   - Deterministic findings are never re-run, re-scored, or replaced. The
 *     patched risk is `combineRisk(deterministic, ai)`, a max, so it can only
 *     ever be greater than or equal to what the scan already showed.
 *   - `ai_status = "pending"` is the claim. A duplicated or replayed message
 *     finds a non-pending row and does nothing, so AI findings cannot be
 *     double-counted.
 *   - The per-organization `ai-review` killswitch is re-evaluated here: an
 *     organization that turned the reviewer off between the scan and this
 *     message gets the disabled sentinel, not a review.
 */
export async function executeAiReviewJob(
  env: Cloudflare.Env,
  message: AiReviewQueueMessage,
  db: AppDb = createDb(env.DB),
  options: ExecuteAiReviewJobOptions = {},
): Promise<AiReviewJobOutcome> {
  const startedAtMs = Date.now();
  const scan = await getScanStatus(db, message.scanId, message.organizationId);
  if (!scan) return skip(message, "scan_not_found");
  if (scan.status === "pending" || scan.status === "running") {
    // The row is not the completed scan this message is for. The producer writes
    // it before enqueueing, so this means the read raced that write (or the scan
    // is being re-run) — a redelivery, not a reason to drop the review. The last
    // attempt gives up rather than looping, and the reaper closes anything left.
    if (!options.finalAttempt) throw new Error("scan is not yet complete");
    return skip(message, "scan_not_complete");
  }
  if (scan.status !== "complete" || scan.aiStatus !== "pending") {
    return skip(message, "not_pending");
  }

  const descriptor = readAiReviewInputDescriptor(scan.summaryJson);
  const bucket = env.ARTIFACTS;
  if (!descriptor || !bucket) {
    // Nothing to review from: the evidence snapshot is gone (or R2 is not bound
    // at all on this deployment). Close the review as unavailable — the same
    // fail-safe the inline path applies when the reviewer cannot run — instead
    // of leaving the scan polling forever.
    return closeUnavailable(env, db, scan, message, "evidence_missing", startedAtMs);
  }

  let evidence: AiReviewInputPayload | null;
  try {
    evidence = await loadAiReviewInput(bucket, message.scanId, descriptor);
  } catch (err) {
    if (!options.finalAttempt) throw err;
    emitOperationalEvent("error", "scan.ai_review.evidence_read_failed", {
      scanId: message.scanId,
      organizationId: message.organizationId,
      error: describeOperationalError(err),
    });
    return closeUnavailable(env, db, scan, message, "evidence_unreadable", startedAtMs);
  }
  if (!evidence) {
    return closeUnavailable(env, db, scan, message, "evidence_invalid", startedAtMs);
  }

  const enabled = env.FLAGS
    ? await env.FLAGS.getBooleanValue("ai-review", true, {
        targetingKey: message.organizationId,
        organizationId: message.organizationId,
      })
    : false;
  if (!enabled) {
    const review: AiReview = {
      status: "unavailable",
      risk: "low",
      releaseAssessment: "not_assessed",
      summary: "AI review is disabled.",
      findings: [],
      requiresManualReview: false,
      model: null,
    };
    return applyAiReviewToScan({ env, db, scan, message, review, evidence, startedAtMs });
  }

  const review = await runReview(env, message, evidence, options);
  return applyAiReviewToScan({ env, db, scan, message, review, evidence, startedAtMs });
}

type ScanRow = NonNullable<Awaited<ReturnType<typeof getScanStatus>>>;

async function runReview(
  env: Cloudflare.Env,
  message: AiReviewQueueMessage,
  evidence: AiReviewInputPayload,
  options: ExecuteAiReviewJobOptions,
): Promise<AiReview> {
  // Lazily imported for the same reason the inline path does it: the AI SDK and
  // workers-ai-provider must stay out of the Worker's boot graph.
  const { runSelectiveAiReview } = await import("../ai-review");
  const startedAtMs = Date.now();
  try {
    const { review, usage } = await runSelectiveAiReview(env, {
      scanId: message.scanId,
      stageId: evidence.stageId || message.stageId,
      organizationId: message.organizationId,
      ecosystem: evidence.ecosystem || message.ecosystem,
      files: evidence.files,
      previousFiles: evidence.previousFiles,
      diff: evidence.diff,
      packageJsonDiff: evidence.packageJsonDiff,
      ruleFindings: evidence.releaseRuleFindings,
      previousVersionAvailable: evidence.previousVersionAvailable,
    });
    recordProductEvent(env, {
      name: "ai_review.finished",
      organizationId: message.organizationId,
      ecosystem: evidence.ecosystem || message.ecosystem,
      status: review.status,
      model: review.model ?? "unknown",
      durationMs: durationMsSince(startedAtMs),
      findingCount: review.findings.length,
    });
    emitOperationalEvent("info", "scan.ai_review.completed", {
      scanId: message.scanId,
      organizationId: message.organizationId,
      durationMs: durationMsSince(startedAtMs),
      deferred: true,
      status: review.status,
      model: review.model,
      // Token-count keys deliberately omit the word "token": the observability
      // secret-redaction regex matches "token" as a substring.
      usage: usage
        ? {
            steps: usage.steps,
            input: usage.inputTokens,
            cachedInput: usage.cachedInputTokens,
            output: usage.outputTokens,
            total: usage.totalTokens,
          }
        : null,
    });
    return review;
  } catch (err) {
    recordProductEvent(env, {
      name: "ai_review.finished",
      organizationId: message.organizationId,
      ecosystem: evidence.ecosystem || message.ecosystem,
      status: "errored",
      model: AI_MODEL,
      durationMs: durationMsSince(startedAtMs),
      findingCount: 0,
    });
    emitOperationalEvent("error", "scan.ai_review.failed", {
      scanId: message.scanId,
      organizationId: message.organizationId,
      durationMs: durationMsSince(startedAtMs),
      deferred: true,
      error: describeOperationalError(err),
    });
    // A thrown reviewer is worth another delivery — the evidence is still on
    // hand and nothing has been patched yet. Only the last attempt settles for
    // the fail-safe `unavailable` result.
    if (!options.finalAttempt) throw err;
    return {
      status: "unavailable",
      risk: "low",
      releaseAssessment: "not_assessed",
      summary: "AI review failed; deterministic findings remain available.",
      findings: [],
      requiresManualReview: false,
      model: AI_MODEL,
    };
  }
}

export interface ApplyAiReviewArgs {
  env: Cloudflare.Env;
  db: AppDb;
  /** The persisted scan row, read while `ai_status` was still `pending`. */
  scan: ScanRow;
  message: AiReviewQueueMessage;
  review: AiReview;
  evidence: AiReviewInputPayload;
  startedAtMs?: number;
}

/**
 * Fold a finished review into an already-persisted scan: annotate its findings
 * against the same diff the deterministic pass used, re-score, republish the
 * report artifact, and flip the D1 references.
 *
 * Exported for tests, which drive it with a synthetic review to exercise both
 * the artifact-backed and D1-backed persistence paths without a live model.
 */
export async function applyAiReviewToScan(args: ApplyAiReviewArgs): Promise<AiReviewJobOutcome> {
  const { env, db, scan, message, review, evidence } = args;
  const startedAtMs = args.startedAtMs ?? Date.now();
  const annotatedDeterministic = evidence.annotatedFindings;
  const merged = mergeAiFindings(
    review,
    {
      redactedStagedFiles: evidence.files,
      redactedPreviousFiles: evidence.previousFiles,
    },
    { fileDiff: evidence.diff },
    readCodePatternSet(evidence.codePatternSet),
    evidence.baselineComparisonSkipped,
  );
  const rescored = computeScanRiskBreakdown(
    [...annotatedDeterministic, ...merged.annotatedRecords],
    review,
    normalizeReleaseConsistency(evidence.releaseConsistency),
    { baselineComparisonSkipped: evidence.baselineComparisonSkipped },
  );
  // The rescore replays the same deterministic findings the scan already scored,
  // so it should reproduce those grades and add only the AI contribution. Floor
  // it against what is already persisted anyway: this is the one write that
  // touches a completed scan's risk, and the guarantee that an advisory reviewer
  // can never lower a deterministic grade should not rest on two computations
  // agreeing. Counts still come from the rescore — they are what changed.
  const persisted = normalizeScanRiskBreakdown(scan.riskSummaryJson);
  const riskSummary: ScanRiskBreakdown = {
    ...rescored,
    artifactRisk: combineRisk(
      rescored.artifactRisk,
      normalizeRisk(persisted?.artifactRisk ?? scan.risk),
    ),
    releaseRisk: combineRisk(rescored.releaseRisk, normalizeRisk(persisted?.releaseRisk ?? "low")),
    contextRisk: combineRisk(rescored.contextRisk, normalizeRisk(persisted?.contextRisk ?? "low")),
  };

  const findingAnnotations = [...annotatedDeterministic, ...merged.annotatedRecords].map(
    (finding, index) => ({
      findingIndex: index,
      diffStatus: finding.diffStatus,
      releaseDelta: finding.releaseDelta,
    }),
  );

  // Deferral requires an `ARTIFACTS` bucket, and a bucket means `persistResults`
  // wrote the artifact set or threw — so a pending review always belongs to an
  // artifact-backed scan. If that ever stops holding, patching anyway is the
  // wrong move rather than a degraded one: `scans.report_digest` covers a
  // payload that embeds the AI review envelope, and a D1-backed scan has no
  // report object to republish, so the digest would permanently disagree with
  // what the row reconstructs to and the artifact backfill would refuse it
  // forever. Close it on the fail-safe path instead, loudly.
  const artifactBacked = scan.artifactStorageVersion !== null && scan.reportArtifactKey !== null;
  if (!artifactBacked) {
    emitOperationalEvent("error", "scan.ai_review.not_artifact_backed", {
      scanId: message.scanId,
      organizationId: message.organizationId,
      reviewStatus: review.status,
    });
    return closeUnavailable(env, db, scan, message, "not_artifact_backed", startedAtMs);
  }

  const report = await rewriteReportWithAiReview(env.ARTIFACTS as R2Bucket, scan, (current) => ({
    ...current,
    aiFindings: review,
    risk: riskSummary,
    findingAnnotations,
  })).catch((err) => {
    // The report artifact keeps its pre-AI bytes and its digest still matches
    // D1, so the detail read stays intact; only the report's copy of the
    // advisory overlay is missing. Patch D1 anyway — that is what the UI and the
    // export read, and the read path prefers `ai_json` over the report envelope
    // for exactly this case.
    emitOperationalEvent("warn", "scan.ai_review.report_rewrite_failed", {
      scanId: message.scanId,
      organizationId: message.organizationId,
      error: describeOperationalError(err),
    });
    return null;
  });

  const { patched } = await applyAiReviewPatch(db, {
    scanId: message.scanId,
    organizationId: message.organizationId,
    ai: review,
    aiStatus: review.status,
    risk: riskSummary.artifactRisk,
    riskSummary,
    findingCount: annotatedDeterministic.length + merged.records.length,
    summary: patchedSummary(scan.summaryJson, riskSummary, report),
    report,
  });

  await deleteAiReviewInput(env.ARTIFACTS, message.organizationId, message.scanId);

  if (!patched) {
    // Another follow-up (or the reaper) claimed the scan first, so the report we
    // republished a moment ago is probably referenced by nothing — but only
    // probably, which is why the cleanup re-reads the row before deleting.
    await deleteSupersededReportRevision(env.ARTIFACTS, db, report, message);
    return skip(message, "not_pending");
  }
  await notifyDeferredScanCompletion(env, db, scan);
  emitOperationalEvent("info", "scan.ai_review.patched", {
    scanId: message.scanId,
    organizationId: message.organizationId,
    ecosystem: evidence.ecosystem || message.ecosystem,
    status: review.status,
    artifactRisk: riskSummary.artifactRisk,
    releaseRisk: riskSummary.releaseRisk,
    aiFindingCount: merged.records.length,
    reportRewritten: report !== null,
    durationMs: durationMsSince(startedAtMs),
  });
  return { outcome: "patched", status: review.status };
}

/**
 * Close a pending review that could not be run at all.
 *
 * No evidence means no recompute is possible, but none is needed: a review that
 * did not complete contributes to risk only through `computeScanRisk`'s fail-safe
 * floor, and that floor is a `combineRisk` max. Applying it to the persisted
 * breakdown is therefore exactly what a full rescore would produce — and a
 * *disabled* review (null model) contributes nothing, so the grade is untouched.
 */
async function closeUnavailable(
  env: Cloudflare.Env,
  db: AppDb,
  scan: ScanRow,
  message: AiReviewQueueMessage,
  reason: string,
  startedAtMs: number,
): Promise<AiReviewJobOutcome> {
  // Named model, deliberately: `computeScanRisk` reads a non-null model on a
  // non-complete review as "attempted and did not finish" and floors the scan at
  // medium, while a null model means "switched off" and stays neutral. A review
  // that was scheduled and never came back is the former — the same fail-safe an
  // inline reviewer crash gets, so a release cannot read as clean because the
  // reviewer never ran over it. The constant comes from the dependency-free
  // module so the reaper does not load the AI SDK to read a string.
  const review: AiReview = {
    status: "unavailable",
    risk: "low",
    releaseAssessment: "not_assessed",
    summary: "AI review did not run; deterministic findings remain available.",
    findings: [],
    requiresManualReview: false,
    model: AI_MODEL,
  };
  const persisted = normalizeScanRiskBreakdown(scan.riskSummaryJson);
  const floor = aiRiskFloor(review);
  // Every fallback is `scans.risk` — the grade the scan is actually displaying —
  // not "low". An unreadable `risk_summary_json` is a reason to keep the
  // persisted verdict, not a reason to publish a quieter one.
  const persistedRisk = normalizeRisk(scan.risk);
  const riskSummary: ScanRiskBreakdown = {
    artifactRisk: combineRisk(normalizeRisk(persisted?.artifactRisk ?? persistedRisk), floor),
    releaseRisk: combineRisk(normalizeRisk(persisted?.releaseRisk ?? persistedRisk), floor),
    contextRisk: normalizeRisk(persisted?.contextRisk ?? persistedRisk),
    releaseFindingCount: persisted?.releaseFindingCount ?? 0,
    contextFindingCount: persisted?.contextFindingCount ?? 0,
    unknownFindingCount: persisted?.unknownFindingCount ?? 0,
    priorApprovedContextFindingCount: persisted?.priorApprovedContextFindingCount ?? 0,
  };

  const { patched } = await applyAiReviewPatch(db, {
    scanId: message.scanId,
    organizationId: message.organizationId,
    ai: review,
    aiStatus: review.status,
    risk: riskSummary.artifactRisk,
    riskSummary,
    findingCount: scan.findingCount ?? 0,
    summary: patchedSummary(scan.summaryJson, riskSummary, null),
    report: null,
  });
  await deleteAiReviewInput(env.ARTIFACTS, message.organizationId, message.scanId);
  if (patched) await notifyDeferredScanCompletion(env, db, scan);
  emitOperationalEvent(patched ? "warn" : "info", "scan.ai_review.closed_unavailable", {
    scanId: message.scanId,
    organizationId: message.organizationId,
    reason,
    patched,
    durationMs: durationMsSince(startedAtMs),
  });
  return patched ? { outcome: "patched", status: review.status } : skip(message, "not_pending");
}

/**
 * Send the scan-completion notification the queue job held back because the
 * review was deferred. Reaching here means the scan just became final, so this
 * is the first and only completion message for it — including when the reaper
 * closes an abandoned review, which is why it lives on the patch path rather
 * than in the queue consumer.
 *
 * Fail-soft: a notification failure must not fail (and retry) a patch that
 * already landed.
 */
async function notifyDeferredScanCompletion(
  env: Cloudflare.Env,
  db: AppDb,
  scan: ScanRow,
): Promise<void> {
  if (scan.source === "workflow_gate" || !scan.organizationId || !scan.ownerUserId) return;
  try {
    const { notifyScanCompletion } = await import("../notify");
    await notifyScanCompletion({
      env,
      db,
      scanId: scan.id,
      organizationId: scan.organizationId,
      ownerUserId: scan.ownerUserId,
      outcome: "complete",
    });
  } catch (err) {
    emitOperationalEvent("error", "scan.ai_review.notify_failed", {
      scanId: scan.id,
      organizationId: scan.organizationId,
      error: describeOperationalError(err),
    });
  }
}

/**
 * Reclaim a report revision this delivery wrote and then lost the claim for.
 *
 * The keys are content-addressed, so two deliveries that produce **identical
 * bytes** produce identical keys — and that is a common case, not an exotic
 * one: the killswitch-off sentinel, the final-attempt fail-safe, and an AI
 * Gateway cache hit all make two concurrent deliveries agree exactly. Deleting
 * "our" objects would then delete the objects the winner's D1 row points at,
 * and a compacted artifact-backed scan keeps no D1 copy of its findings, files,
 * or diff to fall back to — that is unrecoverable loss of a completed review
 * (see docs/artifact-storage.md). So the row is re-read first and the delete
 * only happens once it proves the row references something else.
 */
async function deleteSupersededReportRevision(
  bucket: R2Bucket | undefined,
  db: AppDb,
  report: RewrittenReportArtifacts | null,
  message: AiReviewQueueMessage,
): Promise<void> {
  if (!bucket || !report) return;
  try {
    const current = await getScanStatus(db, message.scanId, message.organizationId);
    if (
      !current ||
      current.reportArtifactKey === report.reportArtifactKey ||
      current.artifactManifestKey === report.artifactManifestKey
    ) {
      // The winner wrote byte-identical bytes to the same keys (or the row is
      // gone and there is nothing to reason about). These objects are live.
      return;
    }
    await bucket.delete([report.reportArtifactKey, report.artifactManifestKey]);
  } catch (err) {
    // Recoverable by the per-scan prefix sweep; never worth failing a message
    // that has already done its job.
    emitOperationalEvent("warn", "scan.ai_review.orphan_cleanup_failed", {
      scanId: message.scanId,
      organizationId: message.organizationId,
      error: describeOperationalError(err),
    });
  }
}

/** The risk a non-complete review contributes: see `computeScanRisk`. */
function aiRiskFloor(review: AiReview): "low" | "medium" {
  const displayed = displayedAiResult(review);
  if (!displayed || displayed.kind === "complete" || displayed.kind === "pending") return "low";
  return displayed.model != null ? "medium" : "low";
}

function patchedSummary(
  summaryJson: unknown,
  riskSummary: ScanRiskBreakdown,
  report: RewrittenReportArtifacts | null,
): Record<string, unknown> {
  const base =
    summaryJson && typeof summaryJson === "object" && !Array.isArray(summaryJson)
      ? { ...(summaryJson as Record<string, unknown>) }
      : {};
  // The evidence snapshot is deleted as part of this patch, so its descriptor
  // must not survive in the summary.
  delete base.aiReviewInput;
  base.risk = riskSummary;
  // `summary.report` is the byte-continuity record the JSON export carries. A
  // republished report has a new digest, so leaving the old one here would ship
  // an export whose digest names bytes that no longer describe the review.
  if (report && base.report && typeof base.report === "object" && !Array.isArray(base.report)) {
    base.report = { ...(base.report as Record<string, unknown>), digest: report.reportDigest };
  }
  return base;
}

function readAiReviewInputDescriptor(summaryJson: unknown): AiReviewInputDescriptor | null {
  if (!summaryJson || typeof summaryJson !== "object" || Array.isArray(summaryJson)) return null;
  const value = (summaryJson as { aiReviewInput?: unknown }).aiReviewInput;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const descriptor = value as Partial<AiReviewInputDescriptor>;
  if (
    typeof descriptor.key !== "string" ||
    typeof descriptor.digest !== "string" ||
    typeof descriptor.size !== "number"
  ) {
    return null;
  }
  return { key: descriptor.key, digest: descriptor.digest, size: descriptor.size };
}

function skip(message: AiReviewQueueMessage, reason: string): AiReviewJobOutcome {
  emitOperationalEvent("info", "scan.ai_review.skipped", {
    scanId: message.scanId,
    organizationId: message.organizationId,
    reason,
  });
  return { outcome: "skipped", reason };
}

/** Re-exported for the reaper, which closes abandoned reviews the same way. */
export async function closeAbandonedAiReview(
  env: Cloudflare.Env,
  db: AppDb,
  scanId: string,
  organizationId: string,
): Promise<boolean> {
  const scan = await getScanStatus(db, scanId, organizationId);
  if (!scan || scan.status !== "complete" || scan.aiStatus !== "pending") return false;
  const result = await closeUnavailable(
    env,
    db,
    scan,
    { kind: "ai_review", scanId, stageId: scan.stageId, organizationId, ecosystem: "unknown" },
    "abandoned",
    Date.now(),
  );
  return result.outcome === "patched";
}

function readCodePatternSet(value: string | undefined): CodePatternSet | undefined {
  return value === "javascript" || value === "python" ? value : undefined;
}
