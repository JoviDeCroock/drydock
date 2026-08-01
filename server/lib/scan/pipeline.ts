import { type AppDb, type WorkspaceSession } from "../../db/client";
import type { AiReview } from "../ai-review/types";
import { pendingAiReview } from "../ai-review/types";
import type {
  AdapterBroker,
  AdapterConnectionRef,
  AdapterContext,
  PackageAdapter,
} from "../ecosystems/package-adapter";
import { loadReleaseFingerprintHistory } from "../../db/release-fingerprint";
import { computeIntentEnvelope, type WorkflowGateIntent } from "../intent-envelope";
import {
  describeOperationalError,
  durationMsSince,
  emitOperationalEvent,
} from "../platform/observability";
import { recordProductEvent } from "../platform/analytics";
import { releaseFingerprintFindings } from "../release-fingerprint";
import type { Finding } from "../review";
import {
  AI_REVIEW_INPUT_VERSION,
  deleteAiReviewInput,
  writeAiReviewInput,
  type AiReviewInputDescriptor,
} from "./artifacts";
import {
  analyzeRelease,
  mergeAiFindings,
  persistResults,
  recordCompletion,
  resolveReleaseConsistency,
  scoreRisk,
  type ComputedDiff,
  type DeterministicFindings,
  type PipelineIdentity,
  type ResolvedArtifacts,
} from "./pipeline-phases";
import type { AiReviewQueueMessage } from "./job-messages";
import type { ScanInput, ScanResult } from "../../types";

export interface ScanPipelineOptions extends ScanInput {
  scanId?: string;
  organizationId: string;
  /** `manual` | `auto_discovery` | `workflow_gate`; recorded on the product counter. */
  source?: string;
  /**
   * Gate-bound release context, set only by the workflow-gate job. Its
   * presence marks the scan as attested in the intent envelope: the signed
   * `deployment_protection_rule` webhook binds repository + run + environment,
   * and the reviewed artifact bytes were downloaded from that run.
   */
  gateContext?: WorkflowGateIntent;
  // Adapters parse their own input shape off this object (e.g. the PyPI adapter
  // reads `manifest`/`artifacts`), so allow extra keys to flow through untyped.
  [key: string]: unknown;
}

export interface ScanPipelineContext {
  env: Cloudflare.Env;
  executionCtx: ExecutionContext;
  db: AppDb;
  session: WorkspaceSession;
}

export interface ScanPipelineSettings {
  /**
   * `deferred` finishes the deterministic report, persists the scan as complete
   * and reviewable with `ai_json.status = "pending"`, and hands the advisory
   * review to a follow-up queue message. This is what keeps a scan from holding
   * a queue-consumer slot through an agentic review (up to two models × three
   * attempts × MAX_AGENT_STEPS with backoff) that cannot change any
   * deterministic finding.
   *
   * `inline` (the default) awaits the review before persisting. The workflow-gate
   * path uses it deliberately: the gate's aggregate recommendation is computed
   * from `releaseRisk` the moment every package scan returns, so a deferred
   * review would be missing from the number a maintainer releases GitHub on.
   */
  aiReview?: "inline" | "deferred";
  /** Enqueue the deferred follow-up. Defaults to `env.SCAN_QUEUE.send`. */
  sendAiReviewMessage?: (message: AiReviewQueueMessage) => Promise<void>;
}

export async function runScanPipeline<TInput, TBroker extends AdapterBroker>(
  context: ScanPipelineContext,
  adapter: PackageAdapter<TInput, TBroker>,
  input: ScanPipelineOptions,
  settings: ScanPipelineSettings = {},
): Promise<ScanResult> {
  const { env, executionCtx, db, session } = context;
  const adapterCtx: AdapterContext = { env, executionCtx, db, session };
  const adapterInput = adapter.parseInput(input);
  const connectionRef: AdapterConnectionRef = { organizationId: input.organizationId };
  const broker = adapter.createBroker(adapterCtx, connectionRef);
  const pipelineStartedAtMs = Date.now();

  try {
    const identity: PipelineIdentity = {
      scanId: input.scanId || crypto.randomUUID(),
      stageId: input.stageId,
      organizationId: input.organizationId,
    };
    // Acquire → diff → deterministic findings → release the raw artifacts. The
    // unredacted file arrays of both package sides stay inside this call, so
    // the AI review, risk scoring, and persistence below run while only the
    // redacted copies are reachable — peak memory is what caps reviewable
    // package size.
    const { diff, findings, facts } = await analyzeRelease(
      adapter,
      adapterCtx,
      adapterInput,
      broker,
      (resolved) => collectReleaseFingerprintFindings(db, identity, resolved),
    );

    // Release-memory lookup (db read) before scoring. It compares finding
    // profiles only and never edits a finding; its one scoring effect is to stop
    // already-approved *package context* from re-anchoring the headline risk.
    // Release-delta findings are untouched, so `releaseRisk` — and the workflow
    // gate that reads it — cannot move. A lookup failure degrades to "none"
    // inside the phase, which scores exactly as before. It runs before the AI
    // step because the deferred review's evidence snapshot carries it, and it
    // does not depend on the review either way.
    const releaseConsistency = await resolveReleaseConsistency({
      db,
      env,
      identity,
      packageName: findings.redactedStagedManifest?.name ?? null,
      ruleFindings: findings.ruleFindings,
    });

    // Evidence snapshot for the follow-up, written before the scan is persisted
    // so the D1 row never advertises a pending review whose evidence is missing.
    const requestedPlan = await planAiReview(env, identity, settings);
    const aiReviewInput =
      requestedPlan === "deferred" && env.ARTIFACTS
        ? await writeAiReviewInput(env.ARTIFACTS, identity.organizationId, {
            version: AI_REVIEW_INPUT_VERSION,
            scanId: identity.scanId,
            stageId: identity.stageId,
            ecosystem: adapter.id,
            codePatternSet: adapter.codePatternSet,
            previousVersionAvailable: facts.previousVersionAvailable,
            baselineComparisonSkipped: facts.baselineComparisonSkipped,
            files: findings.redactedStagedFiles,
            previousFiles: findings.redactedPreviousFiles,
            diff: diff.fileDiff,
            packageJsonDiff: diff.manifestDiff,
            releaseRuleFindings: findings.releaseRuleFindings,
            annotatedFindings: findings.annotatedFindings,
            releaseConsistency,
          }).catch((err) => {
            // The evidence artifact is advisory scaffolding. Failing the scan
            // over it would throw away a fully computed deterministic report and
            // re-download and re-parse both tarballs on retry. Fall back to
            // reviewing inline instead.
            emitOperationalEvent("warn", "scan.ai_review.evidence_write_failed", {
              scanId: identity.scanId,
              organizationId: identity.organizationId,
              error: describeOperationalError(err),
            });
            return null;
          })
        : null;
    const plan: AiReviewPlan =
      requestedPlan === "deferred" && !aiReviewInput ? "inline" : requestedPlan;
    // A deferred review contributes nothing to this scan's risk yet: the
    // deterministic grade is what gets persisted, and because AI only ever
    // enters through `combineRisk` (a max), the follow-up patch can raise the
    // grade but never lower it. Pending therefore reads as "not complete", not
    // as a clean review and not as a failed one.
    const aiFindings: AiReview =
      plan === "deferred"
        ? pendingAiReview()
        : await maybeRunAiReview({
            env,
            identity,
            ecosystem: adapter.id,
            previousVersionAvailable: facts.previousVersionAvailable,
            findings,
            diff,
            enabled: plan === "inline",
          });
    // AI findings persist alongside rule findings (as `source: "ai"` rows) and
    // count into the risk breakdown. Additive only: computeScanRisk folds them
    // in through combineRisk (a max), so they can escalate the deterministic
    // grade but never lower it.
    const mergedAiFindings = mergeAiFindings(
      aiFindings,
      findings,
      diff,
      adapter.codePatternSet,
      facts.baselineComparisonSkipped,
    );

    const riskSummary = scoreRisk(
      [...findings.annotatedFindings, ...mergedAiFindings.annotatedRecords],
      aiFindings,
      releaseConsistency,
      { baselineComparisonSkipped: facts.baselineComparisonSkipped },
    );

    // Advisory source-binding classification. Computed from the gate context
    // (when the workflow-gate job placed this scan) and the staged manifest's
    // repository declaration; it never influences risk or findings.
    const intentEnvelope = computeIntentEnvelope({
      workflowGate: input.gateContext ?? null,
      declaredRepository: facts.declaredRepository,
    });
    const { result, persisted } = await persistResults({
      env,
      db,
      session,
      adapter,
      identity,
      facts,
      diff,
      findings,
      aiFindings,
      mergedAiFindings,
      riskSummary,
      releaseConsistency,
      intentEnvelope,
      aiReviewInput,
    });

    // Before `recordCompletion`, which only emits telemetry: the follow-up is
    // the side effect the scan's advisory half depends on, so it must not be
    // skipped by a failure in an observability call.
    if (plan === "deferred") {
      await handleDeferredAiReview({
        env,
        identity,
        adapterId: adapter.id,
        source: input.source,
        persisted,
        aiReviewInput,
        settings,
      });
    }

    await recordCompletion({
      db,
      session,
      identity,
      adapterId: adapter.id,
      result,
      baseline: facts.baseline,
      persisted,
      pipelineStartedAtMs,
      env,
      source: input.source,
    });

    return result;
  } catch (err) {
    emitOperationalEvent("error", "scan.pipeline.failed", {
      scanId: input.scanId ?? null,
      organizationId: input.organizationId,
      stageId: input.stageId,
      adapterId: adapter.id,
      durationMs: durationMsSince(pipelineStartedAtMs),
      error: describeOperationalError(err),
    });
    throw err;
  } finally {
    await broker.dispose();
  }
}

/**
 * Load org/package scan history and derive the release-process fingerprint
 * findings for the in-flight scan. The history lookup must never fail the
 * scan: any error degrades to "no release-process findings" with a structured
 * operational event, because the artifact findings stand on their own.
 */
async function collectReleaseFingerprintFindings(
  db: ScanPipelineContext["db"],
  identity: PipelineIdentity,
  resolved: ResolvedArtifacts,
): Promise<Finding[]> {
  const packageName = resolved.staged.artifact.manifest?.name || null;
  try {
    const history = await loadReleaseFingerprintHistory(db, {
      organizationId: identity.organizationId,
      scanId: identity.scanId,
      packageName,
    });
    return releaseFingerprintFindings({
      current: {
        scanId: identity.scanId,
        packageName,
        source: history.currentScan?.source ?? null,
        gateRepositoryFullName: history.currentScan?.gateRepositoryFullName ?? null,
        gateEnvironment: history.currentScan?.gateEnvironment ?? null,
      },
      packageHistory: history.packageHistory,
    });
  } catch (err) {
    emitOperationalEvent("warn", "scan.release_fingerprint.failed", {
      scanId: identity.scanId,
      organizationId: identity.organizationId,
      stageId: identity.stageId,
      error: describeOperationalError(err),
    });
    return [];
  }
}

type AiReviewPlan = "disabled" | "inline" | "deferred";

/**
 * Resolve the killswitch once and decide where the review runs.
 *
 * AI review is gated by the Cloudflare Flagship `ai-review` flag in the
 * `drydock` app, evaluated per-organization. The flag is a killswitch: the
 * reviewer is on by default, and Flagship returning false for an organization
 * (or globally) disables it. Without a Flagship binding the reviewer stays off.
 *
 * Deferral additionally needs somewhere to put the evidence (`ARTIFACTS`) and
 * something to carry the follow-up (`SCAN_QUEUE`). Without either — local dev,
 * self-hosted deployments without R2, the `waitUntil()` submit path — the review
 * runs inline exactly as it did before, rather than being silently dropped.
 */
async function planAiReview(
  env: Cloudflare.Env,
  identity: PipelineIdentity,
  settings: ScanPipelineSettings,
): Promise<AiReviewPlan> {
  const enabled = env.FLAGS
    ? await env.FLAGS.getBooleanValue("ai-review", true, {
        targetingKey: identity.organizationId,
        organizationId: identity.organizationId,
      })
    : false;
  if (!enabled) return "disabled";
  if (settings.aiReview !== "deferred") return "inline";
  const canSend = Boolean(settings.sendAiReviewMessage || env.SCAN_QUEUE);
  return canSend && env.ARTIFACTS ? "deferred" : "inline";
}

interface DeferredAiReviewArgs {
  env: Cloudflare.Env;
  identity: PipelineIdentity;
  adapterId: string;
  source?: string;
  persisted: boolean;
  aiReviewInput: AiReviewInputDescriptor | null;
  settings: ScanPipelineSettings;
}

async function handleDeferredAiReview(args: DeferredAiReviewArgs): Promise<void> {
  const { env, identity, aiReviewInput } = args;
  // The scan was already terminal (a duplicate run), so nothing is waiting on a
  // review and the evidence we just wrote is dead weight.
  if (!args.persisted || !aiReviewInput) {
    await deleteAiReviewInput(env.ARTIFACTS, identity.organizationId, identity.scanId);
    return;
  }

  const message: AiReviewQueueMessage = {
    kind: "ai_review",
    scanId: identity.scanId,
    stageId: identity.stageId,
    organizationId: identity.organizationId,
    ecosystem: args.adapterId,
    source: args.source,
  };
  const send =
    args.settings.sendAiReviewMessage ??
    (env.SCAN_QUEUE ? (body: AiReviewQueueMessage) => env.SCAN_QUEUE!.send(body) : null);
  if (!send) return;
  try {
    await send(message);
    emitOperationalEvent("info", "scan.ai_review.deferred", {
      scanId: identity.scanId,
      organizationId: identity.organizationId,
      ecosystem: args.adapterId,
    });
  } catch (err) {
    // The report is complete and readable; only the advisory overlay is at
    // risk. Leave the row `pending` and let the scheduled reaper close it out
    // rather than failing (and retrying) a scan that already succeeded.
    emitOperationalEvent("error", "scan.ai_review.enqueue_failed", {
      scanId: identity.scanId,
      organizationId: identity.organizationId,
      ecosystem: args.adapterId,
      error: describeOperationalError(err),
    });
  }
}

interface AiReviewArgs {
  env: Cloudflare.Env;
  identity: PipelineIdentity;
  ecosystem: string;
  previousVersionAvailable: boolean;
  findings: DeterministicFindings;
  diff: ComputedDiff;
  /** Resolved `ai-review` killswitch value; false persists the disabled sentinel. */
  enabled: boolean;
}

async function maybeRunAiReview(args: AiReviewArgs): Promise<AiReview> {
  const disabled: AiReview = {
    status: "unavailable",
    risk: "low",
    releaseAssessment: "not_assessed",
    summary: "AI review is disabled.",
    findings: [],
    requiresManualReview: false,
    model: null,
    reviewerVersion: null,
  };
  if (!args.enabled) return disabled;

  // Loaded lazily so the Vercel AI SDK + workers-ai-provider stay out of the
  // Worker's boot graph: this path is skipped whenever the killswitch is off or
  // no Flagship binding is wired, so pulling these heavy modules eagerly would tax
  // every cold start (and every per-file test isolate) for a path many scans skip.
  // AI_MODEL rides along — it lives in the same module, so importing it statically
  // would defeat the point.
  const { runSelectiveAiReview, AI_MODEL, AI_REVIEWER_VERSION } = await import("../ai-review");

  const startedAtMs = Date.now();
  try {
    const { review, usage } = await runSelectiveAiReview(args.env, {
      scanId: args.identity.scanId,
      stageId: args.identity.stageId,
      organizationId: args.identity.organizationId,
      ecosystem: args.ecosystem,
      files: args.findings.redactedStagedFiles,
      previousFiles: args.findings.redactedPreviousFiles,
      diff: args.diff.fileDiff,
      packageJsonDiff: args.diff.manifestDiff,
      ruleFindings: args.findings.releaseRuleFindings,
      previousVersionAvailable: args.previousVersionAvailable,
    });
    // A review that returns `invalid`/`unavailable` is handled safely — the
    // scan floors at medium and `displayedAiResult` refuses to render it as
    // "low risk / nothing unusual" — but it is silent. Counting the status makes
    // the reviewer's failure rate a number instead of a thing nobody sees.
    recordProductEvent(args.env, {
      name: "ai_review.finished",
      organizationId: args.identity.organizationId,
      ecosystem: args.ecosystem,
      status: review.status,
      model: review.model ?? "unknown",
      reviewerVersion: review.reviewerVersion ?? "legacy",
      durationMs: durationMsSince(startedAtMs),
      findingCount: review.findings.length,
      steps: usage?.steps ?? 0,
      inputTokens: usage?.inputTokens ?? 0,
      cachedInputTokens: usage?.cachedInputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      totalTokens: usage?.totalTokens ?? 0,
    });
    emitOperationalEvent("info", "scan.ai_review.completed", {
      scanId: args.identity.scanId,
      organizationId: args.identity.organizationId,
      durationMs: durationMsSince(startedAtMs),
      status: review.status,
      model: review.model,
      // Token-count keys deliberately omit the word "token": the observability
      // secret-redaction regex matches "token" as a substring and would blank
      // out fields like `inputTokens`. The parent `usage` key carries the sense.
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
    recordProductEvent(args.env, {
      name: "ai_review.finished",
      organizationId: args.identity.organizationId,
      ecosystem: args.ecosystem,
      status: "errored",
      model: AI_MODEL,
      reviewerVersion: AI_REVIEWER_VERSION,
      durationMs: durationMsSince(startedAtMs),
      findingCount: 0,
      steps: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    });
    emitOperationalEvent("error", "scan.ai_review.failed", {
      scanId: args.identity.scanId,
      organizationId: args.identity.organizationId,
      durationMs: durationMsSince(startedAtMs),
      error: describeOperationalError(err),
    });
    return {
      status: "unavailable",
      risk: "low",
      releaseAssessment: "not_assessed",
      summary: "AI review failed; deterministic findings remain available.",
      findings: [],
      requiresManualReview: false,
      model: AI_MODEL,
      reviewerVersion: AI_REVIEWER_VERSION,
    };
  }
}
