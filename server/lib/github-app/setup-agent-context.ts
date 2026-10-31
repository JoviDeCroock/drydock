import type { ModelMessage } from "ai";
import { z } from "zod";
import { isRecord } from "../platform/guards";

// Every turn re-sends the whole transcript, so old tool output, staged file text, and
// reasoning dominate editing cost. The private workspace keeps every file, so the agent
// re-reads what it still needs. Compaction runs in batches so the prompt prefix stays
// byte-stable (and cacheable) between batches.
const RECENT_MESSAGES = 9;
const COMPACT_AFTER_CHARS = 48_000;
const KEEP_CHARS = 400;

function elide(value: unknown): unknown {
  if (typeof value === "string")
    return value.length > KEEP_CHARS
      ? `[${value.length} characters elided from an earlier turn; read the file again if needed]`
      : value;
  if (Array.isArray(value)) return value.map(elide);
  if (isRecord(value))
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, elide(item)]));
  return value;
}

function compactUserContent(content: string): string {
  let brief: unknown;
  try {
    brief = JSON.parse(content);
  } catch {
    return content.length > KEEP_CHARS ? "[Earlier server guidance elided.]" : content;
  }
  // The implementation brief keeps its plan and inventory; only the bundled source text goes.
  if (!isRecord(brief) || !isRecord(brief.sourceEvidence)) return content;
  const evidence = brief.sourceEvidence;
  return JSON.stringify({
    ...brief,
    sourceEvidence: {
      ...evidence,
      files: Array.isArray(evidence.files) ? evidence.files.map(elide) : evidence.files,
    },
  });
}

function compactMessage(message: ModelMessage): ModelMessage {
  if (message.role === "user")
    return typeof message.content === "string"
      ? { ...message, content: compactUserContent(message.content) }
      : message;
  if (message.role === "assistant") {
    if (typeof message.content === "string") return message;
    const content = message.content
      .filter((part) => part.type !== "reasoning")
      .map((part) =>
        part.type === "tool-call"
          ? { ...part, input: elide(part.input) }
          : part.type === "text"
            ? { ...part, text: elide(part.text) as string }
            : part,
      );
    return { ...message, content: content.length ? content : [{ type: "text", text: "" }] };
  }
  if (message.role === "tool")
    return {
      ...message,
      content: message.content.map((part) =>
        part.type === "tool-result"
          ? { ...part, output: elide(part.output) as typeof part.output }
          : part,
      ),
    };
  return message;
}

const INVALID_INPUT = /^AI_InvalidToolInputError: Invalid input for tool ([\w-]+):/;
const ISSUES_MARKER = "\nError message: ";

function issueSummary(issues: unknown): string | null {
  if (!Array.isArray(issues)) return null;
  const lines = issues.map((issue) =>
    isRecord(issue) && typeof issue.message === "string"
      ? `${Array.isArray(issue.path) ? issue.path.join(".") || "input" : "input"}: ${issue.message}`
      : null,
  );
  return lines.every((line) => line !== null) ? lines.join("; ") : null;
}

/**
 * The SDK's invalid-input error echoes the model's entire rejected arguments, which can be a
 * multi-kilobyte plan the next turn then re-sends. Keep only the field-level issues.
 */
export function conciseToolInputErrors(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((message) => {
    if (message.role !== "tool") return message;
    return {
      ...message,
      content: message.content.map((part) => {
        if (part.type !== "tool-result" || part.output.type !== "error-text") return part;
        const tool = INVALID_INPUT.exec(part.output.value)?.[1];
        // The echoed arguments are model-written and may contain the marker themselves.
        const marker = part.output.value.lastIndexOf(ISSUES_MARKER);
        if (!tool || marker < 0) return part;
        let issues: unknown;
        try {
          issues = JSON.parse(part.output.value.slice(marker + ISSUES_MARKER.length));
        } catch {
          return part;
        }
        const summary = issueSummary(issues);
        return summary
          ? {
              ...part,
              output: {
                type: "error-text" as const,
                value: `Invalid input for ${tool}: ${summary}`,
              },
            }
          : part;
      }),
    };
  });
}

function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  const cut = value.slice(0, max - 1);
  const sentence = cut.lastIndexOf(". ");
  return `${sentence > max * 0.6 ? cut.slice(0, sentence + 1) : cut.trimEnd()}…`;
}

/**
 * Model-written prose with a hard limit. GLM cannot hit a character limit: with the exact
 * overshoot in the error it still trimmed ~50 characters per retry and once spent 18 turns
 * resubmitting. This text is only presented, so the server shortens it instead of refusing.
 */
export function modelText(max: number, guidance: string) {
  return z
    .string()
    .trim()
    .min(1)
    .overwrite((value) => clip(value, max))
    .describe(guidance);
}

function hasValidated(messages: ModelMessage[]) {
  return messages.some(
    (message) =>
      message.role === "assistant" &&
      Array.isArray(message.content) &&
      message.content.some(
        (part) => part.type === "tool-call" && part.toolName === "validate_changes",
      ),
  );
}

/**
 * Elides bulky content from all but the most recent turns once that older region grows
 * past a threshold. The opening brief keeps its bundled source until the agent first
 * validates, because the edits before that are written from it.
 */
export function compactSetupAgentMessages(messages: ModelMessage[]): ModelMessage[] {
  const start = hasValidated(messages) ? 0 : 1;
  const end = messages.length - RECENT_MESSAGES;
  if (end <= start) return messages;
  const region = messages.slice(start, end);
  const compacted = region.map(compactMessage);
  // Compaction is idempotent, so only text it would still remove counts toward the threshold;
  // otherwise the already-compacted history alone would trigger it every turn.
  const removable = region.reduce(
    (total, message, index) =>
      total + JSON.stringify(message).length - JSON.stringify(compacted[index]).length,
    0,
  );
  if (removable <= COMPACT_AFTER_CHARS) return messages;
  return [...messages.slice(0, start), ...compacted, ...messages.slice(end)];
}
