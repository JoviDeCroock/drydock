import { type AppDb, type WorkspaceSession } from "../db/client";
import type { AiReview } from "./ai-review-types";
import type {
  AdapterBroker,
  AdapterConnectionRef,
  AdapterContext,
  PackageAdapter,
} from "./adapters/types";
import { describeOperationalError, durationMsSince, emitOperationalEvent } from "./observability";
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
} from "./scan-pipeline-phases";
import type { ScanInput, ScanResult } from "../types";

export interface ScanPipelineOptions extends ScanInput {
  scanId?: string;
  organizationId: string;
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
    const findings = runDeterministicFindings(adapter, resolved, diff);

    const identity: PipelineIdentity = {
      scanId: input.scanId || crypto.randomUUID(),
      stageId: input.stageId,
      organizationId: input.organizationId,
    };
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
    const mergedAiFindings = mergeAiFindings(aiFindings, findings, diff, adapter.codePatternSet);
    const riskSummary = scoreRisk(
      [...findings.annotatedFindings, ...mergedAiFindings.annotatedRecords],
      aiFindings,
    );

    // Advisory release-memory lookup (db read) before persistence. It compares
    // finding profiles only; it never touches risk or findings, and a lookup
    // failure degrades to "none" inside the phase instead of failing the scan.
    const releaseConsistency = await resolveReleaseConsistency({
      db,
      env,
      identity,
      packageName: findings.redactedStagedManifest?.name ?? null,
      ruleFindings: findings.ruleFindings,
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
  const { runSelectiveAiReview, AI_MODEL } = await import("./ai-review");

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
    };
  }
}
