import { type AppDb, type WorkspaceSession } from "../db";
import { runSelectiveAiReview, type AiReview } from "./ai-review";
import type {
  AdapterBroker,
  AdapterConnectionRef,
  AdapterContext,
  PackageAdapter,
} from "./adapters/types";
import { describeOperationalError, durationMsSince, emitOperationalEvent } from "./observability";
import {
  computeDiff,
  persistResults,
  recordCompletion,
  resolveBaseline,
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

/**
 * Which product surface invoked this pipeline run.
 *
 * - `staged-publish` is the deterministic-only hot path users drive with their
 *   own npm CLI/UI. It must never run AI review — no AI cost, no added latency —
 *   so the publish stays fast.
 * - `gated-target` is the GitHub deployment-protection workflow gate (PyPI
 *   today, npm planned). It is a gate, not the publish, so it may run the
 *   additive AI/AST semantic reviewer (still behind the per-organization
 *   `ai-review` Flagship flag).
 *
 * See `docs/architecture.md` (Workers AI) and the staged-vs-gated detection
 * split. AI review only ever runs on `gated-target`.
 */
export type ScanSurface = "staged-publish" | "gated-target";

export interface ScanPipelineContext {
  env: Cloudflare.Env;
  executionCtx: ExecutionContext;
  db: AppDb;
  session: WorkspaceSession;
  /** Product surface driving this run; decides whether AI review may run. */
  surface: ScanSurface;
}

export async function runScanPipeline<TInput, TBroker extends AdapterBroker>(
  context: ScanPipelineContext,
  adapter: PackageAdapter<TInput, TBroker>,
  input: ScanPipelineOptions,
): Promise<ScanResult> {
  const { env, executionCtx, db, session, surface } = context;
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
      surface,
      identity,
      ecosystem: adapter.id,
      previousVersionAvailable: resolved.baseline.artifact !== null,
      findings,
      diff,
    });
    const riskSummary = scoreRisk(findings.annotatedFindings, aiFindings);

    const { result, persisted } = await persistResults({
      db,
      session,
      adapter,
      adapterInput,
      identity,
      resolved,
      diff,
      findings,
      aiFindings,
      riskSummary,
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
  surface: ScanSurface;
  identity: PipelineIdentity;
  ecosystem: string;
  previousVersionAvailable: boolean;
  findings: DeterministicFindings;
  diff: ComputedDiff;
}

async function maybeRunAiReview(args: AiReviewArgs): Promise<AiReview> {
  const disabled = (summary: string): AiReview => ({
    status: "unavailable",
    risk: "low",
    releaseAssessment: "not_assessed",
    summary,
    findings: [],
    requiresManualReview: false,
    model: null,
  });

  // The staged-publish hot path is deterministic-only by product decision: no
  // AI cost or latency so users can keep publishing with their own npm CLI/UI.
  // AI review only runs on the gated-target path, regardless of the Flagship
  // flag. See `ScanSurface` and docs/architecture.md (Workers AI).
  if (args.surface !== "gated-target") {
    return disabled("AI review does not run on the staged-publish path.");
  }

  // On the gated-target path AI review is additionally gated by the Cloudflare
  // Flagship `ai-review` flag in the `drydock` app, evaluated per-organization.
  // Default-off until Flagship returns true for the organization being scanned.
  const aiReviewEnabled = args.env.FLAGS
    ? await args.env.FLAGS.getBooleanValue("ai-review", false, {
        targetingKey: args.identity.organizationId,
        organizationId: args.identity.organizationId,
      })
    : false;
  if (!aiReviewEnabled) return disabled("AI review is disabled.");

  const startedAtMs = Date.now();
  try {
    const { review, usage } = await runSelectiveAiReview(args.env, {
      scanId: args.identity.scanId,
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
      model: null,
    };
  }
}
