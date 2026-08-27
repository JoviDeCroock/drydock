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
    const promptLine = firstPromptInjectionLine(
      sample,
      PROMPT_INJECTION_PATTERN_SET,
      REVIEW_MANIPULATION_PATTERN_SET,
    );

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
  excludedPatterns: RegExp[] = [],
): number | undefined {
  let firstLine: number | undefined;
  const excludedRanges = promptInjectionMatchRanges(sample, excludedPatterns);
  visitPromptInjectionMatches(sample, patterns, (startLine, endLine) => {
    if (overlapsPromptInjectionRange(startLine, endLine, excludedRanges)) return true;
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
    patterns === PROMPT_INJECTION_PATTERN_SET ? REVIEW_MANIPULATION_PATTERN_SET : [],
  );
}

export function promptInjectionPatternsMatchChangedLines(
  sample: string,
  changedLines: Set<number>,
  patterns: RegExp[],
  excludedPatterns: RegExp[] = [],
): boolean {
  if (changedLines.size === 0) return false;
  let matched = false;
  const excludedRanges = promptInjectionMatchRanges(sample, excludedPatterns);
  visitPromptInjectionMatches(sample, patterns, (startLine, endLine) => {
    if (overlapsPromptInjectionRange(startLine, endLine, excludedRanges)) return true;
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

interface PromptInjectionMatchRange {
  startLine: number;
  endLine: number;
}

function promptInjectionMatchRanges(
  sample: string,
  patterns: RegExp[],
): PromptInjectionMatchRange[] {
  if (patterns.length === 0) return [];
  const ranges: PromptInjectionMatchRange[] = [];
  visitPromptInjectionMatches(sample, patterns, (startLine, endLine) => {
    ranges.push({ startLine, endLine });
    return true;
  });
  ranges.sort((left, right) => left.startLine - right.startLine || left.endLine - right.endLine);
  const merged: PromptInjectionMatchRange[] = [];
  for (const range of ranges) {
    const previous = merged[merged.length - 1];
    if (previous && range.startLine <= previous.endLine) {
      previous.endLine = Math.max(previous.endLine, range.endLine);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function overlapsPromptInjectionRange(
  startLine: number,
  endLine: number,
  ranges: PromptInjectionMatchRange[],
): boolean {
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (ranges[middle].startLine <= endLine) low = middle + 1;
    else high = middle;
  }
  return low > 0 && ranges[low - 1].endLine >= startLine;
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
          const originalStart = originalPromptInjectionOffset(variant, start);
          const originalEnd = originalPromptInjectionOffset(variant, end);
          if (
            isPromptInjectionPatternSet(patterns) &&
            isBenignPromptInjectionDocumentation(window, originalStart, originalEnd)
          ) {
            continue;
          }
          const startLine = windowFirstLine + countLineBreaks(window, 0, originalStart);
          const endLine = startLine + countLineBreaks(window, originalStart, originalEnd);
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

const PROMPT_EXAMPLE_LEAD =
  /\b(?:prompt[\s-]+injection|review[\s-]+manipulation|jailbreak|attacks?|attackers?|filters?|detectors?|guardrails?|tests?|fixtures?|samples?|examples?)\b[^\n.!?]{0,120}\b(?:say|says|include|includes|contain|contains|reject|detect|block|match|phrase|text|message|input|such\s+as|like)\b[^\n.!?]{0,40}$/i;
const LABELED_PROMPT_EXAMPLE =
  /\b(?:examples?|samples?|fixtures?|test\s+cases?)\s*[:-]\s*[["'`(<]*$/i;
const DEFENSIVE_PROMPT_DIRECTIVE =
  /\b(?:ignore|disregard|do\s+not\s+follow|don'?t\s+follow)\s+(?:any\s+|the\s+)?(?:instructions?|prompts?|commands?|directives?)\b[^\n.!?]{0,40}\b(?:(?:embedded|contained|found)\s+in|(?:coming|received)\s+from|from)\s+(?:untrusted|retrieved|external|package|user[\s-]+supplied|tool[\s-]+output)(?:\s+(?:documents?|content|inputs?|outputs?))?\b(?=\s*(?:[.!?]|$))/i;

// Security and LLM libraries legitimately quote canonical attack strings in
// threat guides and tell assistants to ignore instructions from untrusted
// content. Those are descriptions of the trust boundary, not attempts to cross
// it. Require an explicit example/defense cue; a bare quoted directive remains
// hostile evidence because package-delivered injection is commonly wrapped in
// a string, comment, or Markdown code span.
function isBenignPromptInjectionDocumentation(text: string, start: number, end: number): boolean {
  const sentenceStart = Math.max(
    text.lastIndexOf("\n", start - 1),
    text.lastIndexOf(".", start - 1),
    text.lastIndexOf("!", start - 1),
    text.lastIndexOf("?", start - 1),
  );
  const boundaryCandidates = [
    text.indexOf("\n", end),
    text.indexOf(".", end),
    text.indexOf("!", end),
    text.indexOf("?", end),
  ].filter((index) => index >= 0);
  const sentenceEnd = boundaryCandidates.length ? Math.min(...boundaryCandidates) : text.length;
  const sentence = text.slice(sentenceStart + 1, sentenceEnd);
  if (DEFENSIVE_PROMPT_DIRECTIVE.test(sentence)) return true;

  const lead = text.slice(Math.max(sentenceStart + 1, start - 180), start);
  const isThreatExample = PROMPT_EXAMPLE_LEAD.test(lead) || LABELED_PROMPT_EXAMPLE.test(lead);
  return isThreatExample && hasMatchingExampleQuotes(text, start, end, sentenceStart, sentenceEnd);
}

function isPromptInjectionPatternSet(patterns: RegExp[]): boolean {
  return patterns === PROMPT_INJECTION_PATTERN_SET || patterns === REVIEW_MANIPULATION_PATTERN_SET;
}

function hasMatchingExampleQuotes(
  text: string,
  start: number,
  end: number,
  sentenceStart: number,
  sentenceEnd: number,
): boolean {
  const before = text.slice(Math.max(sentenceStart + 1, start - 8), start);
  const after = text.slice(end + 1, Math.min(text.length, sentenceEnd + 4, end + 12));
  const opening = /^["'`]/.test(text.slice(start)) ? text[start] : before.match(/(["'`])\s*$/)?.[1];
  const closing = after.match(/^\s*[.,;:]?\s*(["'`])/)?.[1];
  return opening !== undefined && opening === closing;
}

interface PromptInjectionScanVariant {
  searchText: string;
  originalOffsets?: number[];
}

function promptInjectionScanVariants(window: string): PromptInjectionScanVariant[] {
  const variants: PromptInjectionScanVariant[] = [{ searchText: window }];
  const stripped = stripPromptInjectionEvasion(window);
  const strippedOffsets =
    stripped === window ? undefined : originalOffsetsForSubsequence(window, stripped);
  addPromptInjectionVariant(variants, stripped, strippedOffsets);
  addPromptInjectionVariant(variants, softenPromptInjectionLineBreaks(window));
  addPromptInjectionVariant(variants, softenPromptInjectionLineBreaks(stripped), strippedOffsets);
  return variants;
}

function addPromptInjectionVariant(
  variants: PromptInjectionScanVariant[],
  searchText: string,
  originalOffsets?: number[],
): void {
  if (variants.some((variant) => variant.searchText === searchText)) return;
  variants.push({ searchText, ...(originalOffsets ? { originalOffsets } : {}) });
}

function originalOffsetsForSubsequence(source: string, subsequence: string): number[] {
  const offsets: number[] = [];
  let sourceIndex = 0;
  for (let index = 0; index < subsequence.length; index += 1) {
    const character = subsequence[index];
    while (source[sourceIndex] !== character) sourceIndex += 1;
    offsets.push(sourceIndex);
    sourceIndex += 1;
  }
  return offsets;
}

function originalPromptInjectionOffset(
  variant: PromptInjectionScanVariant,
  offset: number,
): number {
  return variant.originalOffsets?.[offset] ?? offset;
}

function countLineBreaks(text: string, start: number, end: number): number {
  let count = 0;
  for (let index = start; index < end; index += 1) {
    if (text[index] === "\n") count += 1;
  }
  return count;
}
