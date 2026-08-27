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
// Overlapping windows keep those normalized copies bounded: a retained text
// body may be 25 MiB, while the parent Worker has a 128 MiB isolate budget.
const PROMPT_INJECTION_SCAN_WINDOW_CHARS = 64 * 1024;
const PROMPT_INJECTION_SCAN_OVERLAP_CHARS = 4 * 1024;

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
  let firstLine: number | undefined;
  visitPromptInjectionMatches(sample, patterns, (startLine, endLine) => {
    if (excludedLine !== undefined && startLine <= excludedLine && excludedLine <= endLine) {
      return true;
    }
    if (firstLine === undefined || startLine < firstLine) firstLine = startLine;
    return firstLine !== 1;
  });
  return firstLine;
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
  let matched = false;
  visitPromptInjectionMatches(sample, patterns, (startLine, endLine) => {
    for (let line = startLine; line <= endLine; line += 1) {
      if (changedLines.has(line)) {
        matched = true;
        return false;
      }
    }
    return true;
  });
  return matched;
}

function visitPromptInjectionMatches(
  sample: string,
  patterns: RegExp[],
  visit: (startLine: number, endLine: number) => boolean,
): void {
  let windowStart = 0;
  let windowFirstLine = 1;

  while (windowStart < sample.length) {
    const windowEnd = Math.min(sample.length, windowStart + PROMPT_INJECTION_SCAN_WINDOW_CHARS);
    const window = sample.slice(windowStart, windowEnd);
    for (const variant of promptInjectionScanVariants(window)) {
      for (const pattern of patterns) {
        const matcher = new RegExp(
          pattern.source,
          pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
        );
        for (const match of variant.searchText.matchAll(matcher)) {
          const start = match.index ?? 0;
          const end = start + Math.max(0, match[0].length - 1);
          const startLine = windowFirstLine + countLineBreaks(variant.lineSource, 0, start);
          const endLine = startLine + countLineBreaks(variant.lineSource, start, end);
          if (!visit(startLine, endLine)) return;
        }
      }
    }

    if (windowEnd === sample.length) return;
    const nextWindowStart = windowEnd - PROMPT_INJECTION_SCAN_OVERLAP_CHARS;
    windowFirstLine += countLineBreaks(sample, windowStart, nextWindowStart);
    windowStart = nextWindowStart;
  }
}

function promptInjectionScanVariants(window: string): Array<{
  searchText: string;
  lineSource: string;
}> {
  const variants = [{ searchText: window, lineSource: window }];
  const stripped = stripPromptInjectionEvasion(window);
  addPromptInjectionVariant(variants, stripped, stripped);
  addPromptInjectionVariant(variants, softenPromptInjectionLineBreaks(window), window);
  addPromptInjectionVariant(variants, softenPromptInjectionLineBreaks(stripped), stripped);
  return variants;
}

function addPromptInjectionVariant(
  variants: Array<{ searchText: string; lineSource: string }>,
  searchText: string,
  lineSource: string,
): void {
  if (
    variants.some(
      (variant) => variant.searchText === searchText && variant.lineSource === lineSource,
    )
  ) {
    return;
  }
  variants.push({ searchText, lineSource });
}

function countLineBreaks(text: string, start: number, end: number): number {
  let count = 0;
  for (let index = start; index < end; index += 1) {
    if (text[index] === "\n") count += 1;
  }
  return count;
}
