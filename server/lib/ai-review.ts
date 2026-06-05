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

export type {
  AiFinding,
  AiReleaseAssessment,
  AiReview,
  AiReviewResult,
  AiReviewStatus,
  AiReviewUsage,
  DisplayedAiResult,
  SelectiveAiReviewOptions,
} from "./ai-review-types";
export { displayedAiResult } from "./ai-review-types";

// Single reviewer model. See docs/cost-model.md.
export const AI_MODEL = "@cf/moonshotai/kimi-k2.5";

const DEFAULT_CACHE_AFFINITY = "staged-publish-review-agentic-release-reviewer-v1";

export async function runSelectiveAiReview(
  env: Cloudflare.Env,
  options: SelectiveAiReviewOptions,
): Promise<AiReviewResult> {
  return analyzeWithAi(env, AI_MODEL, options);
}

export async function analyzeWithAi(
  env: Cloudflare.Env,
  model: string,
  options: SelectiveAiReviewOptions,
  // Test seam: inject a language model to exercise the agent loop without a
  // live Workers AI binding. Production always builds the Workers AI model.
  languageModelOverride?: LanguageModel,
): Promise<AiReviewResult> {
  const index = buildEvidenceIndex(options);
  const payload = buildAiReviewPayload(options, index);
  let submittedReview: AiReviewSubmission | null = null;

  try {
    const languageModel =
      languageModelOverride ??
      createWorkersAI({
        binding: env.AI,
        gateway: { id: "drydock-gateway" },
      })(model, {
        extraHeaders: {
          "x-session-affinity": scanScopedCacheAffinity(env, options.scanId),
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
      // Stop only once a review is actually recorded — not merely when a
      // submit_review tool call appears. An invalid submit_review (rejected by
      // schema validation, so `execute` never fires) must NOT end the loop:
      // that would terminate the review with nothing recorded. Leaving it
      // running lets the model see the tool error and retry, bounded by the
      // step budget.
      stopWhen: [() => submittedReview !== null, stepCountIs(MAX_AGENT_STEPS)],
      // Deterministically repair a near-miss submission (e.g. a summary a few
      // characters over the bound) by clamping it to the schema limits instead
      // of discarding the whole review. No extra model round-trip: we clamp,
      // re-validate, and only substitute the repaired call when it now passes.
      // A submission we cannot make valid (unparseable/truncated JSON, bad
      // enum, missing field) returns null, so the model is asked to retry.
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
      return { review: normalizeParsedReview(model, submittedReview), usage };
    }

    const textReview = normalizeAiResponse(model, result.text);
    if (textReview.status === "complete") {
      return { review: textReview, usage };
    }

    return {
      review: fallbackReview(
        model,
        "invalid",
        "Assistant did not call submit_review before the evidence budget ended.",
      ),
      usage,
    };
  } catch (err) {
    return {
      review: fallbackReview(
        model,
        "unavailable",
        `Assistant review didn't run: ${errorMessage(err)}`,
      ),
      usage: null,
    };
  }
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
  model: string,
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
