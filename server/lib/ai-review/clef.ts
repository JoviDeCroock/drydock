/**
 * Workers AI Clef client.
 *
 * Clef answers a batch of typed questions about one shared `state` with a
 * probability per option and generates no text. Drydock uses it only for
 * advisory lanes: a judgment from here may add a finding, never lower a
 * deterministic finding, decide a gate, or stand in for the reviewer.
 *
 * Never throws. Every failure collapses to `{ ok: false, reason }`, because
 * every caller is decorating something that has to work without it. A failed
 * ask is "we did not ask", never "nothing is wrong".
 *
 * Trust boundary: `state` is built from package-derived bytes, which are
 * hostile evidence. It goes through the same Workers AI binding and AI Gateway
 * as the reviewer, so package text stays inside the Cloudflare account. No
 * caller may place credentials, sessions, headers, or operator secrets in it.
 */

export const CLEF_MODEL = "@cf/cloudflare/clef";
// The request body names the variant again; Clef rejects a body without it.
const CLEF_VARIANT = "clef";
// The API's own ceiling.
const MAX_QUESTIONS_PER_ASK = 64;

interface ClefNoulQuestion {
  type: "noul";
  instructions: string;
  criteria?: { true: string; false: string };
}

interface ClefScoreQuestion {
  type: "score";
  instructions: string;
  /** Ordered level descriptions, lowest first; levels are indexed from 0. */
  criteria: readonly string[];
}

export type ClefQuestion = ClefNoulQuestion | ClefScoreQuestion;

interface ClefNoulAnswer {
  type: "noul";
  /** P(yes), 0–1. */
  noul: number;
}

interface ClefScoreAnswer {
  type: "score";
  /** Probability-weighted level, 0-indexed; can land between levels. */
  score: number;
}

export type ClefAnswer = ClefNoulAnswer | ClefScoreAnswer;

/** Why an ask produced no answers. Every value means "we do not know". */
export type ClefUnavailableReason =
  /** No Workers AI binding. */
  | "not_configured"
  /** Caller asked nothing, or more than the API accepts. */
  | "empty_request"
  /** The binding threw: provider error, throttling, or a rejected request. */
  | "failed"
  /** No answer inside the caller's budget. */
  | "timeout"
  /** A missing or malformed answer; answers to questions not asked are ignored. */
  | "malformed";

export interface ClefUsage {
  inputTokens: number | null;
}

export type ClefAsk =
  | { ok: true; answers: Map<string, ClefAnswer>; usage: ClefUsage }
  | { ok: false; reason: ClefUnavailableReason };

export interface ClefAskOptions {
  timeoutMs: number;
  /** Joins a Gateway log line to its scan; never package content. */
  gatewayMetadata?: Record<string, string>;
}

export async function askClef(
  ai: Cloudflare.Env["AI"] | undefined,
  state: unknown,
  questions: Record<string, ClefQuestion>,
  options: ClefAskOptions,
): Promise<ClefAsk> {
  if (!ai) return { ok: false, reason: "not_configured" };
  const questionCount = Object.keys(questions).length;
  if (questionCount === 0 || questionCount > MAX_QUESTIONS_PER_ASK) {
    return { ok: false, reason: "empty_request" };
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), options.timeoutMs);
  });
  let body: unknown;
  try {
    const run = ai.run(
      CLEF_MODEL,
      { model: CLEF_VARIANT, state, questions },
      {
        gateway: { id: "drydock-gateway" },
        extraHeaders: {
          "cf-aig-metadata": JSON.stringify(options.gatewayMetadata ?? {}),
          "cf-aig-max-attempts": "1",
        },
      },
    );
    // A late rejection after the timeout wins must not surface as unhandled.
    run.catch(() => undefined);
    body = await Promise.race([run, timeout]);
  } catch {
    return { ok: false, reason: "failed" };
  } finally {
    clearTimeout(timer);
  }
  if (body === "timeout") return { ok: false, reason: "timeout" };

  const answers = parseAnswers(body, questions);
  if (!answers) return { ok: false, reason: "malformed" };
  return { ok: true, answers, usage: parseUsage(body) };
}

/**
 * Answers were computed over package bytes, so every field is re-validated and
 * a batch with one malformed or missing answer is dropped whole: a lane that
 * silently lost one question would read a missing hazard probability as a
 * confident "no".
 */
function parseAnswers(
  body: unknown,
  questions: Record<string, ClefQuestion>,
): Map<string, ClefAnswer> | null {
  const answers = asRecord(asRecord(body)?.answers);
  if (!answers) return null;
  const parsed = new Map<string, ClefAnswer>();
  for (const [id, question] of Object.entries(questions)) {
    const answer = asRecord(answers[id]);
    if (!answer || answer.type !== question.type) return null;
    if (question.type === "noul") {
      const noul = answer.noul;
      if (!isProbability(noul)) return null;
      parsed.set(id, { type: "noul", noul });
    } else {
      const score = answer.score;
      const top = question.criteria.length - 1;
      if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > top) {
        return null;
      }
      parsed.set(id, { type: "score", score });
    }
  }
  return parsed;
}

function parseUsage(body: unknown): ClefUsage {
  const tokens = asRecord(asRecord(body)?.usage)?.input_tokens;
  return { inputTokens: typeof tokens === "number" && Number.isFinite(tokens) ? tokens : null };
}

function isProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
