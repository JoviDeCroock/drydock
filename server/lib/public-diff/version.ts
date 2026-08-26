import type { PublicDiffAdapter } from "./types";

// Bump this when risk aggregation changes without a deterministic-rules bump.
export const PUBLIC_DIFF_RISK_VERSION = "1";

/** Full identity for payload, rule, and risk semantics exposed by a verdict. */
export function publicDiffAnalysisVersion(
  adapter: Pick<PublicDiffAdapter, "payloadVersion" | "rulesVersionSegment">,
): string {
  return `${adapter.rulesVersionSegment}+risk-${PUBLIC_DIFF_RISK_VERSION}+payload-${adapter.payloadVersion}`;
}
