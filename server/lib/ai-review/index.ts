import * as ai from "ai";
import type { LanguageModel, LanguageModelUsage } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import {
  AI_REVIEWER_VERSION,
  aiReviewSubmissionSchema,
  buildReviewerSystemPrompt,
  clampAiReviewSubmission,
  MAX_AGENT_STEPS,
  MAX_REVIEW_OUTPUT_TOKENS,
  selectReportedFindings,
  type AiReviewSubmission,
} from "./contract";
import { buildAiReviewPayload, buildEvidenceIndex, createAiReviewTools } from "./evidence";
import type {
  AiReview,
  AiReviewResult,
  AiReviewStatus,
  AiReviewUsage,
  SelectiveAiReviewOptions,
} from "./types";
import { errorMessage } from "../platform/errors";
import { recordProductEvent } from "../platform/analytics";
import { durationMsSince } from "../platform/observability";

export type { AiReview, AiReviewResult, SelectiveAiReviewOptions } from "./types";
export { displayedAiResult } from "./types";
export { AI_REVIEWER_VERSION } from "./contract";

// Reviewer model order: use the inexpensive agentic model for most releases,
// while preserving Kimi as the first reviewer for pre-classified high-signal
// changes. Model selection never depends on a weaker model's output.
//
// Every candidate must survive this loop's shape, not just answer a prompt: up
// to MAX_AGENT_STEPS re-sends of a prefix that grows to the evidence cap. That
// makes the cached-input price, not the headline input price, the cost driver,
// and it makes the context window a floor rather than a feature — evidence is
// capped at MAX_TOTAL_TOOL_RESPONSE_CHARS, so anything past ~64k is unusable
// spend. The fallback is agentic and cache-discounted: a failover that cannot
// finish the loop returns `invalid`, which floors the scan at medium and
// escalates to manual review, so a "cheap" model that misses the submission
// costs more than it saves. Re-check all candidates against
// docs/ai-review-eval.md's live comparison before changing them; model routing
// changes require bumping
// AI_REVIEWER_VERSION with it.
export const AI_MODEL = "@cf/zai-org/glm-5.3-flash";
export const AI_FALLBACK_MODEL = "@cf/moonshotai/kimi-k2.7-code";
export const AI_MODEL_CANDIDATES = [AI_MODEL, AI_FALLBACK_MODEL] as const;
const AI_REVIEW_AGENT_NAME = "drydock-release-reviewer";

// The Agent SDK automatically copies `aiGatewayLogId` from a Workers AI
// binding into its trace. Keep the provider's `run` capability while hiding
// that correlation handle so a trace cannot be joined to AI Gateway records
// carrying private scan/organization metadata.
export function traceIsolatedAiBinding(binding: Cloudflare.Env["AI"]): Cloudflare.Env["AI"] {
  return {
    run: binding.run.bind(binding),
  } as unknown as Cloudflare.Env["AI"];
}

// Package evidence and tool results can contain private pre-release source,
// secrets, or prompt injection. Agent Traces record operation names, timings,
// model/usage data, and tool names only — never message or tool payloads.
let tracedAiPromise: Promise<typeof ai> | undefined;

async function tracedAiSdk(): Promise<typeof ai> {
  tracedAiPromise ??= import("agents/observability/ai")
    .then(({ wrapAISDK }) =>
      wrapAISDK(ai, {
        storeMessages: false,
        storeTools: false,
      }),
    )
    .catch((err: unknown) => {
      // The Agent SDK correctly imports `cloudflare:workers`, which Node's ESM
      // loader does not implement. Unit/eval tests use injected mock models and
      // retain the unwrapped AI SDK; production Workers must surface any other
      // initialization failure rather than silently dropping traces.
      if (errorMessage(err).includes("Received protocol 'cloudflare:'")) return ai;
      throw err;
    });
  return tracedAiPromise;
}

const DEFAULT_CACHE_AFFINITY = "staged-publish-review-agentic-release-reviewer-v1";

// One short jittered retry absorbs a capacity or provider 5xx blip. A
// minute-based 429 or a request timeout cannot be fixed by retrying the same
// whole agent loop after a few hundred milliseconds, so those move directly to
// the next model.
const AI_REVIEW_MAX_CAPACITY_ATTEMPTS = 2;
const AI_REVIEW_RETRY_DELAY_MS = 500;
const AI_REVIEW_RETRY_JITTER_MS = 500;

export function selectModelCandidates(options: SelectiveAiReviewOptions): readonly string[] {
  if (isHighSignalReview(options)) {
    return [AI_FALLBACK_MODEL, AI_MODEL];
  }
  return AI_MODEL_CANDIDATES;
}

function isHighSignalReview(options: SelectiveAiReviewOptions): boolean {
  return (
    options.previousVersionAvailable === false ||
    options.ruleFindings.some(
      (finding) =>
        finding.severity === "critical" ||
        finding.severity === "high" ||
        finding.obfuscated === true,
    ) ||
    options.packageJsonDiff.entrypointsChanged === true ||
    options.packageJsonDiff.scripts.length > 0 ||
    options.packageJsonDiff.dependencies.length > 0
  );
}

type LanguageModelFactory = (model: string) => LanguageModel;
type LanguageModelOverride = LanguageModel | LanguageModelFactory;

export async function runSelectiveAiReview(
  env: Cloudflare.Env,
  options: SelectiveAiReviewOptions,
): Promise<AiReviewResult> {
  return analyzeWithAi(env, selectModelCandidates(options), options);
}

export async function analyzeWithAi(
  env: Cloudflare.Env,
  model: string | readonly string[],
  options: SelectiveAiReviewOptions,
  // Test seam: inject a language model to exercise the agent loop without a
  // live Workers AI binding. Production always builds the Workers AI model.
  languageModelOverride?: LanguageModelOverride,
): Promise<AiReviewResult> {
  const models = typeof model === "string" ? [model] : [...model];
  const index = buildEvidenceIndex(options);
  const payload = buildAiReviewPayload(options, index);
  const transientFailures: string[] = [];
  // Trace correlation is intentionally local to this invocation. Do not reuse
  // scan/stage/organization ids: the trace should remain useful without
  // becoming another index over private review records.
  const traceConversationId = crypto.randomUUID();
  const tracedAi = await tracedAiSdk();

  for (const [modelIndex, candidateModel] of models.entries()) {
    const hasFallback = modelIndex < models.length - 1;
    for (let attempt = 1; attempt <= AI_REVIEW_MAX_CAPACITY_ATTEMPTS; attempt += 1) {
      const attemptStartedAtMs = Date.now();
      let completedStepUsage: AiReviewUsage | null = null;
      // Declared per attempt: a retried run starts the agentic loop from scratch,
      // so a submission recorded by a prior (failed) attempt must not leak across.
      let submittedReview: AiReviewSubmission | null = null;
      try {
        const languageModel =
          resolveLanguageModelOverride(languageModelOverride, candidateModel) ??
          createWorkersAI({
            binding: traceIsolatedAiBinding(env.AI),
            gateway: { id: "drydock-gateway" },
          })(candidateModel, {
            extraHeaders: aiReviewRequestHeaders(env, options, candidateModel, attempt),
          });
        const tools = createAiReviewTools(
          options,
          (review) => {
            submittedReview = review;
          },
          index,
        );

        const result = await tracedAi.generateText({
          model: languageModel,
          system: buildReviewerSystemPrompt(options.ecosystem),
          messages: [{ role: "user", content: JSON.stringify(payload) }],
          tools,
          // Stop on a recorded review, not on the mere presence of a submit_review
          // call: an invalid one (rejected by validation, so `execute` never fires)
          // must let the model see the tool error and retry instead of ending the loop.
          stopWhen: [() => submittedReview !== null, ai.stepCountIs(MAX_AGENT_STEPS)],
          ...aiReviewTraceTelemetry(options, traceConversationId),
          // The last step the budget allows offers only submit_review and forces
          // the call: a run that spends every step gathering evidence would
          // otherwise end unrecorded, discarding the whole token spend and
          // degrading to the `invalid` fallback. A forced submission that still
          // fails validation falls through to that fallback as before.
          prepareStep: ({ stepNumber }) =>
            stepNumber >= MAX_AGENT_STEPS - 1
              ? {
                  toolChoice: { type: "tool", toolName: "submit_review" },
                  activeTools: ["submit_review"],
                }
              : undefined,
          // Clamp a near-miss submission to the schema limits rather than discarding
          // the whole review. Substitute the repaired call only once it re-validates;
          // anything we can't make valid returns null so the model retries.
          experimental_repairToolCall: async ({ toolCall }) => {
            if (toolCall.toolName !== "submit_review") return null;
            let parsed: unknown;
            try {
              parsed = JSON.parse(toolCall.input);
            } catch {
              return null;
            }
            const repaired = clampAiReviewSubmission(parsed);
            if (!aiReviewSubmissionSchema.safeParse(repaired).success) return null;
            return { ...toolCall, input: JSON.stringify(repaired) };
          },
          temperature: 0,
          maxOutputTokens: MAX_REVIEW_OUTPUT_TOKENS,
          // This loop owns model-level retry and fallback. Provider retries here
          // would be invisible to `ai_review.attempted` and multiply spend.
          maxRetries: 0,
          onStepEnd: ({ usage: stepUsage }) => {
            completedStepUsage = addAiReviewUsage(completedStepUsage, toUsage(stepUsage, 1));
          },
        });

        const usage = toUsage(result.totalUsage, result.steps.length);

        if (submittedReview) {
          recordAiReviewAttempt(env, options, {
            model: candidateModel,
            attempt,
            outcome: "complete",
            action: "done",
            durationMs: durationMsSince(attemptStartedAtMs),
            usage,
          });
          return { review: normalizeParsedReview(candidateModel, submittedReview), usage };
        }

        const textReview = normalizeAiResponse(candidateModel, result.text);
        if (textReview.status === "complete") {
          recordAiReviewAttempt(env, options, {
            model: candidateModel,
            attempt,
            outcome: "complete",
            action: "done",
            durationMs: durationMsSince(attemptStartedAtMs),
            usage,
          });
          return { review: textReview, usage };
        }

        const action = hasFallback ? "fallback" : "stop";
        recordAiReviewAttempt(env, options, {
          model: candidateModel,
          attempt,
          outcome: "invalid",
          action,
          durationMs: durationMsSince(attemptStartedAtMs),
          usage,
        });
        if (hasFallback) {
          transientFailures.push(`${candidateModel}: invalid review`);
          break;
        }
        return {
          review: fallbackReview(
            candidateModel,
            "invalid",
            "Assistant did not call submit_review before the evidence budget ended.",
          ),
          usage,
        };
      } catch (err) {
        const outcome = classifyAiAttemptError(err);
        const retryableServerError = outcome === "error" && isRetryableAiServerError(err);
        const shouldRetry =
          (outcome === "capacity" || retryableServerError) &&
          attempt < AI_REVIEW_MAX_CAPACITY_ATTEMPTS;
        const shouldFallback =
          !shouldRetry && (outcome !== "error" || retryableServerError) && hasFallback;
        recordAiReviewAttempt(env, options, {
          model: candidateModel,
          attempt,
          outcome,
          action: shouldRetry ? "retry" : shouldFallback ? "fallback" : "stop",
          durationMs: durationMsSince(attemptStartedAtMs),
          usage: completedStepUsage,
        });

        if (shouldRetry) {
          await sleep(AI_REVIEW_RETRY_DELAY_MS + Math.random() * AI_REVIEW_RETRY_JITTER_MS);
          continue;
        }
        if (shouldFallback) {
          transientFailures.push(`${candidateModel}: ${errorMessage(err)}`);
          break;
        }

        return {
          review: fallbackReview(
            candidateModel,
            "unavailable",
            `Assistant review didn't run: ${modelFailureSummary(
              transientFailures,
              candidateModel,
              err,
            )}`,
          ),
          usage: null,
        };
      }
    }
  }

  return {
    review: fallbackReview(
      null,
      "unavailable",
      "Assistant review didn't run: no reviewer model configured.",
    ),
    usage: null,
  };
}

// AI SDK v7 dropped `telemetry.metadata`, so trace identity and labels travel in
// `runtimeContext` and reach the span only via `includeRuntimeContext`. Spread
// onto the call: `runtimeContext` is a top-level option, not a telemetry field.
export function aiReviewTraceTelemetry(
  options: Pick<SelectiveAiReviewOptions, "ecosystem">,
  conversationId: string,
) {
  return {
    runtimeContext: {
      agentId: AI_REVIEW_AGENT_NAME,
      agentVersion: AI_REVIEWER_VERSION,
      conversationId,
      // Ecosystem is a closed product capability label, not package or tenant
      // data. Organization, stage, package, file, and evidence fields stay out.
      ecosystem: options.ecosystem,
    },
    telemetry: {
      functionId: AI_REVIEW_AGENT_NAME,
      // Runtime context is an application-data channel, not a telemetry bag:
      // nothing reaches a span without being named here.
      includeRuntimeContext: {
        agentId: true,
        agentVersion: true,
        conversationId: true,
        ecosystem: true,
      },
      // Belt-and-braces against the wrapper's `storeMessages`/`storeTools`:
      // prompts and tool results carry pre-release source and hostile input, so
      // no payload recorder may turn them into retained trace evidence.
      recordInputs: false,
      recordOutputs: false,
    },
  };
}

// Workers AI capacity, quota, and timeout rejections are classified separately
// because their retry/fallback policies differ. The provider normalizes binding
// errors to APICallError-shaped values, but direct binding errors may still expose
// only an internal code or name, so prefer structured fields before message text.
type AiAttemptOutcome = "complete" | "invalid" | "rate_limited" | "capacity" | "timeout" | "error";
type AiAttemptAction = "done" | "retry" | "fallback" | "stop";

const RATE_LIMITED_AI_ERROR_PATTERN = /\b429\b|rate.?limit|too many requests/i;
const TIMEOUT_AI_ERROR_PATTERN = /\b(?:3007|3008|408)\b|request timeout|timed out/i;
const CAPACITY_AI_ERROR_PATTERN =
  /\b(?:3040|502|503)\b|capacity .*exceeded|temporarily unavailable|overloaded/i;

function classifyAiAttemptError(err: unknown): Exclude<AiAttemptOutcome, "complete" | "invalid"> {
  const fields = err && typeof err === "object" ? (err as Record<string, unknown>) : null;
  const data =
    fields?.data && typeof fields.data === "object"
      ? (fields.data as Record<string, unknown>)
      : null;
  const internalCode = numericErrorField(data?.workersAIErrorCode ?? fields?.code);
  const statusCode = numericErrorField(fields?.statusCode);
  const message = errorMessage(err);

  if (internalCode === 3040) return "capacity";
  if (internalCode === 3036) return "rate_limited";
  if (internalCode === 3007 || internalCode === 3008) return "timeout";
  if (
    statusCode === 408 ||
    statusCode === 504 ||
    fields?.name === "TimeoutError" ||
    fields?.name === "ResponseAborted"
  ) {
    return "timeout";
  }
  if (TIMEOUT_AI_ERROR_PATTERN.test(message)) return "timeout";
  if (CAPACITY_AI_ERROR_PATTERN.test(message)) return "capacity";
  if (statusCode === 502 || statusCode === 503) return "capacity";
  if (statusCode === 429) return "rate_limited";
  if (RATE_LIMITED_AI_ERROR_PATTERN.test(message)) return "rate_limited";
  return "error";
}

function numericErrorField(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

function isRetryableAiServerError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const statusCode = numericErrorField((err as Record<string, unknown>).statusCode);
  return statusCode !== undefined && statusCode >= 500;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface AiAttemptTelemetry {
  model: string;
  attempt: number;
  outcome: AiAttemptOutcome;
  action: AiAttemptAction;
  durationMs: number;
  usage: AiReviewUsage | null;
}

function recordAiReviewAttempt(
  env: Cloudflare.Env,
  options: SelectiveAiReviewOptions,
  attempt: AiAttemptTelemetry,
): void {
  recordProductEvent(env, {
    name: "ai_review.attempted",
    ecosystem: options.ecosystem,
    model: attempt.model,
    reviewerVersion: AI_REVIEWER_VERSION,
    outcome: attempt.outcome,
    action: attempt.action,
    durationMs: attempt.durationMs,
    attempt: attempt.attempt,
    steps: attempt.usage?.steps ?? 0,
    inputTokens: attempt.usage?.inputTokens ?? 0,
    cachedInputTokens: attempt.usage?.cachedInputTokens ?? 0,
    outputTokens: attempt.usage?.outputTokens ?? 0,
    totalTokens: attempt.usage?.totalTokens ?? 0,
  });
}

// The per-request headers that decide cache affinity and Gateway attribution.
// Exported because the offline model comparison in
// `test/eval/ai-review-live-harness.mjs` builds its own Workers AI model over
// REST credentials: measuring cached-token share against different headers than
// production sends would compare the wrong thing.
export function aiReviewRequestHeaders(
  env: Cloudflare.Env,
  options: SelectiveAiReviewOptions,
  model: string,
  attempt: number,
): Record<string, string> {
  return {
    "x-session-affinity": scanScopedCacheAffinity(env, options.scanId),
    "cf-aig-metadata": aiGatewayMetadataHeader(options, model, attempt),
    // Gateway metrics stay available without retaining private package evidence
    // from the request and response bodies.
    "cf-aig-collect-log-payload": "false",
    // Account-level Gateway retries would be invisible to per-attempt usage
    // accounting. One Gateway attempt leaves retry/fallback ownership here.
    "cf-aig-max-attempts": "1",
  };
}

export function aiGatewayMetadataHeader(
  options: SelectiveAiReviewOptions,
  model: string,
  attempt: number,
): string {
  const metadata: Record<string, string | number> = {
    scanId: options.scanId || "unknown",
    organizationId: options.organizationId || "unknown",
    ecosystem: options.ecosystem || "unknown",
    model,
    attempt,
  };

  if (options.stageId) {
    metadata.stageId = options.stageId;
    delete metadata.model;
  }

  return JSON.stringify(metadata);
}

function resolveLanguageModelOverride(
  override: LanguageModelOverride | undefined,
  model: string,
): LanguageModel | undefined {
  return typeof override === "function" ? override(model) : override;
}

function modelFailureSummary(
  previousFailures: readonly string[],
  model: string,
  err: unknown,
): string {
  return [...previousFailures, `${model}: ${errorMessage(err)}`].join("; ");
}

function toUsage(usage: LanguageModelUsage, steps: number): AiReviewUsage {
  return {
    inputTokens: usage.inputTokens ?? null,
    cachedInputTokens: usage.inputTokenDetails?.cacheReadTokens ?? null,
    outputTokens: usage.outputTokens ?? null,
    totalTokens: usage.totalTokens ?? null,
    steps,
  };
}

function addAiReviewUsage(total: AiReviewUsage | null, next: AiReviewUsage): AiReviewUsage {
  if (!total) return next;
  return {
    inputTokens: addNullableTokenCounts(total.inputTokens, next.inputTokens),
    cachedInputTokens: addNullableTokenCounts(total.cachedInputTokens, next.cachedInputTokens),
    outputTokens: addNullableTokenCounts(total.outputTokens, next.outputTokens),
    totalTokens: addNullableTokenCounts(total.totalTokens, next.totalTokens),
    steps: total.steps + next.steps,
  };
}

function addNullableTokenCounts(left: number | null, right: number | null): number | null {
  return left === null && right === null ? null : (left ?? 0) + (right ?? 0);
}

function scanScopedCacheAffinity(env: Cloudflare.Env, scanId: string | undefined): string {
  const base = env.AI_CACHE_AFFINITY || DEFAULT_CACHE_AFFINITY;
  const suffix = scanId || crypto.randomUUID();
  return `${base}:${suffix}`;
}

function normalizeAiResponse(model: string, text: string): AiReview {
  try {
    return normalizeParsedReview(model, JSON.parse(text));
  } catch {
    return fallbackReview(
      model,
      "invalid",
      "Assistant returned non-JSON output; review didn't complete.",
    );
  }
}

function normalizeParsedReview(model: string, value: unknown): AiReview {
  const parsed = aiReviewSubmissionSchema.safeParse(value);
  if (!parsed.success) {
    return fallbackReview(
      model,
      "invalid",
      `Assistant review was incomplete or invalid: ${parsed.error.issues
        .map((issue) => issue.path.join(".") || issue.code)
        .join(", ")}.`,
    );
  }

  const review = parsed.data;
  return {
    status: "complete",
    risk: review.risk,
    releaseAssessment: review.releaseAssessment,
    summary: review.summary,
    findings: selectReportedFindings(review.findings),
    requiresManualReview: review.requiresManualReview,
    model,
    reviewerVersion: AI_REVIEWER_VERSION,
  };
}

function fallbackReview(
  model: string | null,
  status: Exclude<AiReviewStatus, "complete">,
  summary: string,
): AiReview {
  return {
    status,
    risk: "low",
    releaseAssessment: "not_assessed",
    summary,
    findings: [],
    requiresManualReview: false,
    model,
    reviewerVersion: AI_REVIEWER_VERSION,
  };
}
