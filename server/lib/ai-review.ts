import { generateText, stepCountIs, type LanguageModel, type LanguageModelUsage } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import {
  aiReviewSubmissionSchema,
  buildReviewerSystemPrompt,
  clampAiReviewSubmission,
  MAX_AGENT_STEPS,
  MAX_REVIEW_OUTPUT_TOKENS,
  selectReportedFindings,
  type AiReviewSubmission,
} from "./ai-review-contract";
import {
  buildAiReviewPayload,
  buildEvidenceIndex,
  createAiReviewTools,
} from "./ai-review-evidence";
import type {
  AiReview,
  AiReviewResult,
  AiReviewStatus,
  AiReviewUsage,
  SelectiveAiReviewOptions,
} from "./ai-review-types";
import { errorMessage } from "./errors";

export type { AiReview, AiReviewResult, SelectiveAiReviewOptions } from "./ai-review-types";
export { displayedAiResult } from "./ai-review-types";

// Reviewer model order: prefer the strongest affordable model, then fail over.
export const AI_MODEL = "@cf/moonshotai/kimi-k2.7-code";
export const AI_FALLBACK_MODEL = "@cf/qwen/qwen3-30b-a3b-fp8";
export const AI_MODEL_CANDIDATES = [AI_MODEL, AI_FALLBACK_MODEL] as const;

const DEFAULT_CACHE_AFFINITY = "staged-publish-review-agentic-release-reviewer-v1";

// Workers AI rejects requests under load with transient errors the model itself
// asks us to retry (e.g. "3040: Capacity temporarily exceeded, please try
// again."). These surface as plain Errors, so the AI SDK's built-in maxRetries —
// which only fires for APICallErrors it classifies retryable — never kicks in,
// and a busy moment would otherwise degrade straight to `unavailable` (escalating
// the scan to manual review). Retry a bounded number of times with linear backoff
// before moving to the next configured reviewer model.
const AI_REVIEW_MAX_ATTEMPTS = 3;
const AI_REVIEW_RETRY_DELAY_MS = 500;

type LanguageModelFactory = (model: string) => LanguageModel;
type LanguageModelOverride = LanguageModel | LanguageModelFactory;

export async function runSelectiveAiReview(
  env: Cloudflare.Env,
  options: SelectiveAiReviewOptions,
): Promise<AiReviewResult> {
  return analyzeWithAi(env, AI_MODEL_CANDIDATES, options);
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

  for (const candidateModel of models) {
    let lastError: unknown;
    for (let attempt = 1; attempt <= AI_REVIEW_MAX_ATTEMPTS; attempt += 1) {
      // Declared per attempt: a retried run starts the agentic loop from scratch,
      // so a submission recorded by a prior (failed) attempt must not leak across.
      let submittedReview: AiReviewSubmission | null = null;
      try {
        const languageModel =
          resolveLanguageModelOverride(languageModelOverride, candidateModel) ??
          createWorkersAI({
            binding: env.AI,
            gateway: { id: "drydock-gateway" },
          })(candidateModel, {
            extraHeaders: {
              "x-session-affinity": scanScopedCacheAffinity(env, options.scanId),
              "cf-aig-metadata": aiGatewayMetadataHeader(options, candidateModel, attempt),
            },
          });
        const tools = createAiReviewTools(
          options,
          (review) => {
            submittedReview = review;
          },
          index,
        );

        const result = await generateText({
          model: languageModel,
          system: buildReviewerSystemPrompt(options.ecosystem),
          messages: [{ role: "user", content: JSON.stringify(payload) }],
          tools,
          // Stop on a recorded review, not on the mere presence of a submit_review
          // call: an invalid one (rejected by validation, so `execute` never fires)
          // must let the model see the tool error and retry instead of ending the loop.
          stopWhen: [() => submittedReview !== null, stepCountIs(MAX_AGENT_STEPS)],
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
        });

        const usage = toUsage(result.totalUsage, result.steps.length);

        if (submittedReview) {
          return { review: normalizeParsedReview(candidateModel, submittedReview), usage };
        }

        const textReview = normalizeAiResponse(candidateModel, result.text);
        if (textReview.status === "complete") {
          return { review: textReview, usage };
        }

        // A model that produced no valid review is not a transient failure — the
        // evidence budget was spent — so return the `invalid` fallback without retrying.
        return {
          review: fallbackReview(
            candidateModel,
            "invalid",
            "Assistant did not call submit_review before the evidence budget ended.",
          ),
          usage,
        };
      } catch (err) {
        lastError = err;
        // Only retry transient capacity/overload failures; a malformed request or a
        // code bug fails identically every time, so retrying just wastes budget.
        if (attempt < AI_REVIEW_MAX_ATTEMPTS && isRetryableAiError(err)) {
          await sleep(AI_REVIEW_RETRY_DELAY_MS * attempt);
          continue;
        }
        break;
      }
    }

    if (isRetryableAiError(lastError) && candidateModel !== models[models.length - 1]) {
      transientFailures.push(`${candidateModel}: ${errorMessage(lastError)}`);
      continue;
    }

    return {
      review: fallbackReview(
        candidateModel,
        "unavailable",
        `Assistant review didn't run: ${modelFailureSummary(
          transientFailures,
          candidateModel,
          lastError,
        )}`,
      ),
      usage: null,
    };
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

// Workers AI capacity/overload/rate-limit/time-out rejections are transient and
// worth a retry; anything else (bad request, code bug) is not. Matched on
// message text because the binding throws plain Errors, not classified
// APICallErrors — `3040` is "Capacity temporarily exceeded" and `3046` is
// "Request timeout".
const RETRYABLE_AI_ERROR_PATTERN =
  /\b(?:3040|3046|408|429|502|503)\b|capacity .*exceeded|request timeout|temporarily unavailable|overloaded|rate.?limit|too many requests/i;

function isRetryableAiError(err: unknown): boolean {
  return RETRYABLE_AI_ERROR_PATTERN.test(errorMessage(err));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  };
}
