const FAILURE_MARKERS = [
  /^\s*(?:FAIL|ERROR)\b/,
  /^\s*[✗×❯]\s/,
  /\bFailed (?:Tests|Suites)\b/,
  /\bUnhandled (?:Error|Rejection)/i,
  /\b(?:\w*Error|AssertionError)\b\s*:/,
  /⎯⎯/,
];

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
