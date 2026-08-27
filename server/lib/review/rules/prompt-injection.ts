import type { Finding } from "..";
import {
  PROMPT_INJECTION_PATTERN_SET,
  REVIEW_MANIPULATION_PATTERN_SET,
  softenPromptInjectionLineBreaks,
  stripPromptInjectionEvasion,
} from "./patterns";
import { tag, testScope } from "./helpers";
import {
  changedPrefix,
  changedStagedLines,
  isUnreachableTestFile,
  type RuleContext,
} from "./context";

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
// phrase. A second normalized form treats Markdown soft line breaks as spaces;
// every normalization preserves line boundaries or offsets for attribution.
export function promptInjectionFindings(ctx: RuleContext): Finding[] {
  const findings: Finding[] = [];

  for (const file of ctx.files) {
    const sample = file.textSample;
    if (!sample) continue;
    const prefix = changedPrefix(ctx, file.path);
    const reviewLine = firstPromptInjectionLine(sample, REVIEW_MANIPULATION_PATTERN_SET);
    const promptLine = firstPromptInjectionLine(sample, PROMPT_INJECTION_PATTERN_SET, reviewLine);

    if (reviewLine !== undefined) {
      findings.push(
        testScope(
          shouldDemoteTestMatch(ctx, file.path, REVIEW_MANIPULATION_PATTERN_SET),
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
          shouldDemoteTestMatch(ctx, file.path, PROMPT_INJECTION_PATTERN_SET),
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

function firstPromptInjectionLine(
  sample: string,
  patterns: RegExp[],
  excludedLine?: number,
): number | undefined {
  const masked = maskLine(sample, excludedLine);
  let firstLine: number | undefined;
  for (const variant of promptInjectionScanVariants(masked)) {
    const match = firstPatternMatch(variant.searchText, patterns);
    if (!match) continue;
    const line = lineNumberAt(variant.lineSource, match.index);
    if (firstLine === undefined || line < firstLine) firstLine = line;
  }
  return firstLine;
}

function maskLine(text: string, line: number | undefined): string {
  if (line === undefined) return text;
  const lines = text.split("\n");
  lines[line - 1] = "";
  return lines.join("\n");
}

function shouldDemoteTestMatch(ctx: RuleContext, path: string, patterns: RegExp[]): boolean {
  if (!isUnreachableTestFile(ctx, path)) return false;
  const status = ctx.diffByPath.get(path)?.status;
  if (status === "unchanged") return true;
  if (status !== "modified") return false;
  const previous = ctx.previousByPath.get(path);
  const staged = ctx.files.find((file) => file.path === path);
  if (!previous?.textSample || !staged?.textSample) return false;
  if (previous.flags.includes("binary") || staged.flags.includes("binary")) return false;
  return !promptInjectionPatternsMatchChangedLines(
    staged.textSample,
    changedStagedLines(previous.textSample, staged.textSample),
    patterns,
  );
}

export function promptInjectionPatternsMatchChangedLines(
  sample: string,
  changedLines: Set<number>,
  patterns: RegExp[],
): boolean {
  if (changedLines.size === 0) return false;
  for (const variant of promptInjectionScanVariants(sample)) {
    const lineStarts = lineStartOffsets(variant.lineSource);
    for (const pattern of patterns) {
      const matcher = new RegExp(
        pattern.source,
        pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
      );
      for (const match of variant.searchText.matchAll(matcher)) {
        const startLine = lineNumberForStarts(lineStarts, match.index ?? 0);
        const endLine = lineNumberForStarts(
          lineStarts,
          (match.index ?? 0) + Math.max(0, match[0].length - 1),
        );
        for (let line = startLine; line <= endLine; line += 1) {
          if (changedLines.has(line)) return true;
        }
      }
    }
  }
  return false;
}

function promptInjectionScanVariants(sample: string): Array<{
  searchText: string;
  lineSource: string;
}> {
  const stripped = stripPromptInjectionEvasion(sample);
  return [
    { searchText: sample, lineSource: sample },
    { searchText: stripped, lineSource: stripped },
    { searchText: softenPromptInjectionLineBreaks(sample), lineSource: sample },
    { searchText: softenPromptInjectionLineBreaks(stripped), lineSource: stripped },
  ];
}

function firstPatternMatch(text: string, patterns: RegExp[]): RegExpExecArray | null {
  let first: RegExpExecArray | null = null;
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    const match = pattern.exec(text);
    if (match && (!first || match.index < first.index)) first = match;
  }
  return first;
}

function lineNumberAt(text: string, index: number): number {
  return lineNumberForStarts(lineStartOffsets(text), index);
}

function lineStartOffsets(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

function lineNumberForStarts(starts: number[], index: number): number {
  let low = 0;
  let high = starts.length;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (starts[middle] <= index) low = middle;
    else high = middle;
  }
  return low + 1;
}
