import type { Finding } from "..";
import { firstMatchingLine } from "../../platform/text-utils";
import {
  PROMPT_INJECTION_PATTERN_SET,
  REVIEW_MANIPULATION_PATTERN_SET,
  stripPromptInjectionEvasion,
} from "./patterns";
import { tag, testScope } from "./helpers";
import { changedPrefix, isUnreachableTestFile, type RuleContext } from "./context";

// LLM prompt-injection rules. Package bytes are read by LLMs in two places we
// care about: Drydock's own AI reviewer, and consumers' coding
// assistants/agents that ingest READMEs, comments, and type declarations.
// Text addressed at either audience is scanned in every file with a text
// sample — docs included, since a README is the primary vector.
//
// Two tiers, one finding per distinct attempt:
// - `file.review-manipulation` (high): verdict coercion aimed at the security
//   review itself. Standing danger — a prior approval never discounts it.
// - `file.prompt-injection` (medium): instruction content aimed at any
//   AI/agent audience.
// Both tiers demote longstanding matches in unreachable test files one step
// (LLM-guardrail packages ship injection strings as test fixtures), mirroring
// the secret-content policy: demoted, never dropped.

// Markdown emphasis and zero-width characters are in-band evasions in the
// rule's primary vector: `ignore all *previous* instructions` renders clean
// in a README and reads clean to the target LLM. Patterns run against the raw
// sample and a stripped copy — raw so underscore-bearing schema tokens
// (`nothing_unusual`) keep matching, stripped so emphasis can't split a
// phrase. Newlines survive stripping, so line numbers stay valid either way.
export function promptInjectionFindings(ctx: RuleContext): Finding[] {
  const findings: Finding[] = [];

  for (const file of ctx.files) {
    const sample = file.textSample;
    if (!sample) continue;
    const stripped = stripPromptInjectionEvasion(sample);
    const prefix = changedPrefix(ctx, file.path);
    const changed = ctx.diffByPath.get(file.path)?.status;
    const demote = isUnreachableTestFile(ctx, file.path) && changed === "unchanged";
    const reviewLine = lineOfEither(sample, stripped, REVIEW_MANIPULATION_PATTERN_SET);
    const promptLine = lineOfEither(sample, stripped, PROMPT_INJECTION_PATTERN_SET, reviewLine);

    if (reviewLine !== undefined) {
      findings.push(
        testScope(
          demote,
          false,
          tag("fileReviewManipulation", {
            severity: "high",
            file: file.path,
            line: reviewLine,
            evidence: `${prefix}text attempts to steer the security review verdict`,
            reason:
              "package text instructs an automated or AI reviewer to report the release as safe or suppress findings; legitimate packages have no reason to address the review process",
          }),
        ),
      );
    }

    // A high-tier match subsumes generic injection on the same line, but not a
    // separate attempt elsewhere in the file. Keeping the distinct row lets
    // diff annotation assign only newly added generic text to release risk.
    if (promptLine !== undefined && promptLine !== reviewLine) {
      findings.push(
        testScope(
          demote,
          false,
          tag("filePromptInjection", {
            severity: "medium",
            file: file.path,
            line: promptLine,
            evidence: `${prefix}prompt-injection text addressed at AI tools`,
            reason:
              "package text embeds instructions aimed at LLMs or AI agents that read package contents; a consumer's coding assistant may follow them",
          }),
        ),
      );
    }
  }

  return findings;
}

function lineOfEither(
  sample: string,
  stripped: string,
  patterns: RegExp[],
  excludedLine?: number,
): number | undefined {
  const rawLine = firstMatchingLine(maskLine(sample, excludedLine), patterns);
  const strippedLine = firstMatchingLine(maskLine(stripped, excludedLine), patterns);
  if (rawLine === undefined) return strippedLine;
  if (strippedLine === undefined) return rawLine;
  return Math.min(rawLine, strippedLine);
}

function maskLine(text: string, line: number | undefined): string {
  if (line === undefined) return text;
  const lines = text.split("\n");
  lines[line - 1] = "";
  return lines.join("\n");
}
