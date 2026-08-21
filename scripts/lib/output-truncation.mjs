// Condenses a failed check's buffered output before it is re-printed by
// scripts/test.mjs and scripts/verify.mjs. Large vitest runs interleave
// hundreds of passing-file lines before the failure section; dumping all of it
// burns agent context without adding signal. The rule is conservative:
// everything from the first failure-looking line to the end is always kept
// verbatim — only the passing/noise region before it may be elided.

// Lines that can open a failure region. Matching too eagerly is safe (an early
// match keeps MORE output); missing a marker is covered by the guaranteed-tail
// fallback below.
const FAILURE_MARKERS = [
  /^\s*(?:FAIL|ERROR)\b/,
  /^\s*[✗×❯]\s/,
  /\bFailed (?:Tests|Suites)\b/,
  /\bUnhandled (?:Error|Rejection)/i,
  /\b(?:\w*Error|AssertionError)\b\s*:/,
  /⎯⎯/,
];

/**
 * Returns `output` unchanged when it is small (<= maxLines) or when the first
 * failure marker appears too early for eliding to be worthwhile. Otherwise
 * keeps the first `headLines` lines (run header/config context), inserts an
 * explicit elision marker, and keeps everything from the first failure marker
 * (or at minimum the last `minTailLines` lines) to the end.
 */
export function condenseFailureOutput(output, options = {}) {
  const {
    maxLines = 400,
    headLines = 40,
    minTailLines = 250,
    minElidedLines = 50,
    rerunHint = "rerun scoped for full output: pnpm test -- <file>",
  } = options;

  const lines = output.split("\n");
  if (lines.length <= maxLines) return output;

  const firstFailure = lines.findIndex((line) =>
    FAILURE_MARKERS.some((marker) => marker.test(line)),
  );
  // Never keep less than the last minTailLines, even without a marker match —
  // failure detail overwhelmingly lives at the end of a buffered run.
  const guaranteedTail = lines.length - minTailLines;
  const cut = firstFailure === -1 ? guaranteedTail : Math.min(firstFailure, guaranteedTail);

  const elided = cut - headLines;
  if (elided < minElidedLines) return output;

  return [
    ...lines.slice(0, headLines),
    `[... ${elided} lines elided (passing tests / noise) — ${rerunHint}]`,
    ...lines.slice(cut),
  ].join("\n");
}
