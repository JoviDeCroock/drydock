import { generateText, hasToolCall, stepCountIs } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import {
  aiReviewSubmissionSchema,
  MAX_AGENT_STEPS,
  REVIEWER_SYSTEM_PROMPT,
  TOOL_PROMPT_OVERHEAD_CHARS,
  type AiReviewSubmission,
} from "./ai-review-contract";
import { buildAiReviewPayload, createAiReviewTools } from "./ai-review-evidence";
import type {
  AiReview,
  AiReviewStatus,
  PreAiEscalationInput,
  SelectiveAiReviewOptions,
} from "./ai-review-types";

export type {
  AiFinding,
  AiReview,
  AiReviewStatus,
  PreAiEscalationInput,
  SelectiveAiReviewOptions,
} from "./ai-review-types";

// Cheaper triage model used for the default AI review pass. See docs/cost-model.md.
export const DEFAULT_AI_MODEL = "@cf/qwen/qwen3-30b-a3b-fp8";
// Stronger reviewer escalated to for risky/ambiguous scans. See docs/cost-model.md.
export const ESCALATION_AI_MODEL = "@cf/moonshotai/kimi-k2.5";

const LIFECYCLE_SCRIPT_KEYS = new Set([
  "preinstall",
  "install",
  "postinstall",
  "prepare",
  "prepack",
  "postpack",
  "publish",
  "prepublish",
  "prepublishOnly",
]);

const RISKY_SEVERITIES = new Set(["medium", "high", "critical"]);
const DEFAULT_AI_INPUT_TOKEN_BUDGET = 24_000;
const APPROX_CHARS_PER_TOKEN = 4;
const DEFAULT_CACHE_AFFINITY = "staged-publish-review-agentic-release-reviewer-v1";

export function decidePreAiEscalation(input: PreAiEscalationInput): string[] {
  const reasons: string[] = [];

  if (input.ruleFindings.some((finding) => RISKY_SEVERITIES.has(finding.severity))) {
    reasons.push("deterministic finding at medium or higher severity");
  }
  if (input.packageJsonDiff.scripts.some((entry) => LIFECYCLE_SCRIPT_KEYS.has(entry.key))) {
    reasons.push("install-lifecycle script added or modified");
  }
  if (input.packageJsonDiff.dependencies.length > 0) {
    reasons.push("dependency, peer dependency, or optional dependency changed");
  }
  if (input.packageJsonDiff.entrypointsChanged) {
    reasons.push("package entrypoints changed");
  }
  if (!input.previousVersionAvailable) {
    reasons.push("previous-version comparison unavailable");
  }
  if (
    input.defaultInputTokenEstimate &&
    input.defaultInputTokenEstimate > DEFAULT_AI_INPUT_TOKEN_BUDGET
  ) {
    reasons.push("default model context budget exceeded");
  }

  return reasons;
}

export function estimateAiReviewInputTokens(options: SelectiveAiReviewOptions): number {
  const userPayload = JSON.stringify(buildAiReviewPayload(options));
  return Math.ceil(
    (REVIEWER_SYSTEM_PROMPT.length + userPayload.length + TOOL_PROMPT_OVERHEAD_CHARS) /
      APPROX_CHARS_PER_TOKEN,
  );
}

export function decidePostDefaultEscalation(review: AiReview): string[] {
  const reasons: string[] = [];
  if (review.status !== "complete") {
    reasons.push(`default model review ${review.status}`);
  }
  if (review.releaseAssessment === "suspicious" || review.releaseAssessment === "blocked") {
    reasons.push(`default model marked release ${review.releaseAssessment}`);
  }
  if (review.status === "complete" && review.requiresManualReview) {
    reasons.push("default model requested manual review");
  }
  return reasons;
}

export async function runSelectiveAiReview(
  env: Cloudflare.Env,
  options: SelectiveAiReviewOptions,
): Promise<AiReview> {
  const preReasons = decidePreAiEscalation({
    ruleFindings: options.ruleFindings,
    packageJsonDiff: options.packageJsonDiff,
    previousVersionAvailable: options.previousVersionAvailable,
    defaultInputTokenEstimate: estimateAiReviewInputTokens(options),
  });

  if (preReasons.length > 0) {
    const escalated = await analyzeWithAi(env, ESCALATION_AI_MODEL, options);
    return { ...escalated, escalated: true, escalationReasons: preReasons };
  }

  const defaultReview = await analyzeWithAi(env, DEFAULT_AI_MODEL, options);
  const postReasons = decidePostDefaultEscalation(defaultReview);
  if (postReasons.length === 0) {
    return defaultReview;
  }

  const escalated = await analyzeWithAi(env, ESCALATION_AI_MODEL, options);
  return { ...escalated, escalated: true, escalationReasons: postReasons };
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
      `Assistant review didn't run: ${err instanceof Error ? err.message : String(err)}`,
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
    escalated: false,
    escalationReasons: [],
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
    escalated: false,
    escalationReasons: [],
  };
}
