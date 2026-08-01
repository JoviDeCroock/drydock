import { type AppDb, type WorkspaceSession } from "../../db/client";
import type { AiReview } from "../ai-review/types";
import type {
  AdapterBroker,
  AdapterConnectionRef,
  AdapterContext,
  PackageAdapter,
} from "../ecosystems/package-adapter";
import {
  describeOperationalError,
  durationMsSince,
  emitOperationalEvent,
} from "../platform/observability";
import { recordProductEvent } from "../platform/analytics";
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
} from "./pipeline-phases";
import type { ScanInput, ScanResult } from "../../types";

export interface ScanPipelineOptions extends ScanInput {
  scanId?: string;
  organizationId: string;
  /** `manual` | `auto_discovery` | `workflow_gate`; recorded on the product counter. */
  source?: string;
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
    );

    const identity: PipelineIdentity = {
      scanId: input.scanId || crypto.randomUUID(),
      stageId: input.stageId,
      organizationId: input.organizationId,
    };
    const aiFindings = await maybeRunAiReview({
      env,
      identity,
      ecosystem: adapter.id,
      previousVersionAvailable: facts.previousVersionAvailable,
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
      facts.baselineComparisonSkipped,
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
      { baselineComparisonSkipped: facts.baselineComparisonSkipped },
    );

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
    });

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
  const { runSelectiveAiReview, AI_MODEL } = await import("../ai-review");

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
      durationMs: durationMsSince(startedAtMs),
      findingCount: review.findings.length,
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
      durationMs: durationMsSince(startedAtMs),
      findingCount: 0,
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
    };
  }
}
