import { generateText, hasToolCall, stepCountIs } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import {
  aiReviewSubmissionSchema,
  MAX_AGENT_STEPS,
  REVIEWER_SYSTEM_PROMPT,
  type AiReviewSubmission,
} from "./ai-review-contract";
import { buildAiReviewPayload, createAiReviewTools } from "./ai-review-evidence";
import type { AiReview, AiReviewStatus, SelectiveAiReviewOptions } from "./ai-review-types";
import { errorMessage } from "./errors";

export type {
  AiFinding,
  AiReleaseAssessment,
  AiReview,
  AiReviewStatus,
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
): Promise<AiReview> {
  return analyzeWithAi(env, AI_MODEL, options);
}

export async function analyzeWithAi(
  env: Cloudflare.Env,
  model: string,
  options: SelectiveAiReviewOptions,
): Promise<AiReview> {
  const payload = buildAiReviewPayload(options);
  let submittedReview: AiReviewSubmission | null = null;

  try {
    const workersAi = createWorkersAI({
      binding: env.AI,
      gateway: { id: "drydock-gateway" },
    });
    const languageModel = workersAi(model, {
      extraHeaders: {
        "x-session-affinity": scanScopedCacheAffinity(env, options.scanId),
      },
    });
    const tools = createAiReviewTools(options, (review) => {
      submittedReview = review;
    });

    const result = await generateText({
      model: languageModel,
      system: REVIEWER_SYSTEM_PROMPT,
      messages: [{ role: "user", content: JSON.stringify(payload) }],
      tools,
      stopWhen: [hasToolCall("submit_review"), stepCountIs(MAX_AGENT_STEPS)],
      temperature: 0,
      maxOutputTokens: 2_000,
    });

    if (submittedReview) {
      return normalizeParsedReview(model, submittedReview);
    }

    const textReview = normalizeAiResponse(model, result.text);
    if (textReview.status === "complete") {
      return textReview;
    }

    return fallbackReview(
      model,
      "invalid",
      "Assistant did not call submit_review before the evidence budget ended.",
    );
  } catch (err) {
    return fallbackReview(
      model,
      "unavailable",
      `Assistant review didn't run: ${errorMessage(err)}`,
    );
  }
}

function scanScopedCacheAffinity(env: Cloudflare.Env, scanId: string | undefined): string {
  const base = env.AI_CACHE_AFFINITY || DEFAULT_CACHE_AFFINITY;
  const suffix = scanId || crypto.randomUUID();
  return `${base}:${suffix}`;
}

function normalizeAiResponse(model: string, result: unknown): AiReview {
  const content = extractContent(result);
  if (typeof content === "string") {
    try {
      return normalizeParsedReview(model, JSON.parse(content));
    } catch {
      return fallbackReview(
        model,
        "invalid",
        "Assistant returned non-JSON output; review didn't complete.",
      );
    }
  }
  return normalizeParsedReview(model, content);
}

function extractContent(result: unknown): unknown {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return result;
  const obj = result as Record<string, unknown>;
  const choices = obj.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const first = choices[0];
    if (first && typeof first === "object") {
      const message = (first as Record<string, unknown>).message;
      if (message && typeof message === "object") {
        const content = (message as Record<string, unknown>).content;
        if (content !== undefined && content !== null) return content;
      }
    }
  }
  if ("response" in obj) return obj.response;
  return obj;
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
    findings: review.findings,
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
