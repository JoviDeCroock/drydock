import { type AppDb, type WorkspaceSession } from "../../db/client";
import type { AiReview } from "../ai-review/types";
import type {
  AdapterBroker,
  AdapterConnectionRef,
  AdapterContext,
  PackageAdapter,
} from "../ecosystems/package-adapter";
import { loadReleaseFingerprintHistory } from "../../db/release-fingerprint";
import {
  computeIntentEnvelope,
  extractDeclaredRepository,
  type WorkflowGateIntent,
} from "../intent-envelope";
import {
  describeOperationalError,
  durationMsSince,
  emitOperationalEvent,
} from "../platform/observability";
import { recordProductEvent } from "../platform/analytics";
import { releaseFingerprintFindings } from "../release-fingerprint";
import type { Finding } from "../review";
import {
  computeDiff,
  mergeAiFindings,
  persistResults,
  recordCompletion,
  resolveBaseline,
  resolveReleaseConsistency,
  runDeterministicFindings,
  scoreRisk,
  type ComputedDiff,
  type DeterministicFindings,
  type PipelineIdentity,
  type ResolvedArtifacts,
} from "./pipeline-phases";
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

export async function runScanPipeline<TInput, TBroker extends AdapterBroker>(
  context: ScanPipelineContext,
  adapter: PackageAdapter<TInput, TBroker>,
  input: ScanPipelineOptions,
): Promise<ScanResult> {
  const { env, executionCtx, db, session } = context;
  const adapterCtx: AdapterContext = { env, executionCtx, db, session };
  const adapterInput = adapter.parseInput(input);
  const connectionRef: AdapterConnectionRef = { organizationId: input.organizationId };
  const broker = adapter.createBroker(adapterCtx, connectionRef);
  const pipelineStartedAtMs = Date.now();

  try {
    const resolved = await resolveBaseline(adapter, adapterCtx, adapterInput, broker);
    const diff = computeDiff(resolved);

    const identity: PipelineIdentity = {
      scanId: input.scanId || crypto.randomUUID(),
      stageId: input.stageId,
      organizationId: input.organizationId,
    };
    // Release-process fingerprint findings (release.*) compare this release's
    // arrival against org/package history. Appended here so they flow through
    // annotation, risk scoring, and persistence exactly like adapter findings.
    const releaseProcessFindings = await collectReleaseFingerprintFindings(db, identity, resolved);
    const findings = runDeterministicFindings(adapter, resolved, diff, releaseProcessFindings);
    const aiFindings = await maybeRunAiReview({
      env,
      identity,
      ecosystem: adapter.id,
      previousVersionAvailable: resolved.baseline.artifact !== null,
      findings,
      diff,
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
      Boolean(resolved.baseline.baseline.comparisonSkipped),
    );

    // Release-memory lookup (db read) before scoring. It compares finding
    // profiles only and never edits a finding; its one scoring effect is to stop
    // already-approved *package context* from re-anchoring the headline risk.
    // Release-delta findings are untouched, so `releaseRisk` — and the workflow
    // gate that reads it — cannot move. A lookup failure degrades to "none"
    // inside the phase, which scores exactly as before.
    const releaseConsistency = await resolveReleaseConsistency({
      db,
      env,
      identity,
      packageName: findings.redactedStagedManifest?.name ?? null,
      ruleFindings: findings.ruleFindings,
    });

    const riskSummary = scoreRisk(
      [...findings.annotatedFindings, ...mergedAiFindings.annotatedRecords],
      aiFindings,
      releaseConsistency,
      { baselineComparisonSkipped: Boolean(resolved.baseline.baseline.comparisonSkipped) },
    );

    // Advisory source-binding classification. Computed from the gate context
    // (when the workflow-gate job placed this scan) and the staged manifest's
    // repository declaration; it never influences risk or findings.
    const intentEnvelope = computeIntentEnvelope({
      workflowGate: input.gateContext ?? null,
      declaredRepository: extractDeclaredRepository({
        manifestText: diff.stagedManifestText,
        files: resolved.staged.artifact.files,
      }),
    });

    const { result, persisted } = await persistResults({
      env,
      db,
      session,
      adapter,
      adapterInput,
      identity,
      resolved,
      diff,
      findings,
      aiFindings,
      mergedAiFindings,
      riskSummary,
      releaseConsistency,
      intentEnvelope,
    });

    await recordCompletion({
      db,
      session,
      identity,
      adapterId: adapter.id,
      result,
      baseline: resolved.baseline.baseline,
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

interface AiReviewArgs {
  env: Cloudflare.Env;
  identity: PipelineIdentity;
  ecosystem: string;
  previousVersionAvailable: boolean;
  findings: DeterministicFindings;
  diff: ComputedDiff;
}

async function maybeRunAiReview(args: AiReviewArgs): Promise<AiReview> {
  // AI review is gated by the Cloudflare Flagship `ai-review` flag in the
  // `drydock` app, evaluated per-organization. The flag is a killswitch: the
  // reviewer is on by default, and Flagship returning false for an organization
  // (or globally) disables it. Without a Flagship binding the reviewer stays off.
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
  const aiReviewEnabled = args.env.FLAGS
    ? await args.env.FLAGS.getBooleanValue("ai-review", true, {
        targetingKey: args.identity.organizationId,
        organizationId: args.identity.organizationId,
      })
    : false;
  if (!aiReviewEnabled) return disabled;

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
