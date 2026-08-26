import type { CapabilityDelta, Finding } from "../review";
import { combineRisk, type RiskLevel } from "../review";
import type { PublicPackageDiff } from ".";

/**
 * `drydock.verdict.v1` — the machine-readable projection of an anonymous
 * public diff. This is the payload dependency-update tooling reads at scale,
 * so its posture is stricter than the page the humans read:
 *
 * - Counts, tiers, capability deltas, and ages only — never finding prose. A
 *   verdict endpoint automates public statements about third-party releases;
 *   rule evidence text stays on the page a human chose to open.
 * - Deterministic only (the anonymous plane never runs AI review), which is
 *   what makes a verdict citable and reproducible for a given rulesVersion.
 * - The worst grade is "needs-review". The anonymous plane cannot prove
 *   malice and this schema has no word for it.
 *
 * A strict projection of the cached computed payload: building a verdict must
 * never cost more than serving the diff it summarizes.
 */
export const PUBLIC_VERDICT_SCHEMA = "drydock.verdict.v1";

type VerdictGrade = "clear" | "notable" | "needs-review";

export interface PublicDiffVerdict {
  schema: typeof PUBLIC_VERDICT_SCHEMA;
  ecosystem: string;
  package: string;
  displayName: string | null;
  from: { version: string; publishedAt: string | null };
  to: { version: string; publishedAt: string | null };
  /** Analysis identity: deterministic-rules segment + risk-aggregation version. */
  rulesVersion: string;
  grade: VerdictGrade;
  risk: { artifactRisk: RiskLevel; releaseRisk: RiskLevel };
  findingCounts: Record<Finding["severity"], number>;
  capabilities: CapabilityDelta;
  sourceBinding: { from: string | null; to: string | null; changed: boolean };
  coverage: {
    /** Null when the pair predates per-side coverage accounting. */
    fromUninspectedFiles: number | null;
    toUninspectedFiles: number;
    /** Server-authored acquisition caveats (never package-controlled text). */
    notices: string[];
  };
  /** The page a human should read before acting on this verdict. */
  diffUrl: string | null;
  computedAt: string;
}

export function buildPublicDiffVerdict(
  payload: PublicPackageDiff,
  options: { rulesVersion: string; diffUrl: string | null },
): PublicDiffVerdict {
  return {
    schema: PUBLIC_VERDICT_SCHEMA,
    ecosystem: payload.ecosystem,
    package: payload.packageName,
    displayName: payload.displayName ?? null,
    from: { version: payload.fromVersion, publishedAt: payload.fromPublishedAt ?? null },
    to: { version: payload.toVersion, publishedAt: payload.toPublishedAt ?? null },
    rulesVersion: options.rulesVersion,
    grade: verdictGrade(combineRisk(payload.risk.artifactRisk, payload.risk.releaseRisk)),
    risk: { artifactRisk: payload.risk.artifactRisk, releaseRisk: payload.risk.releaseRisk },
    findingCounts: countFindingSeverities(payload.findings),
    capabilities: payload.capabilities,
    sourceBinding: payload.sourceBinding,
    coverage: {
      fromUninspectedFiles: payload.capabilities.from?.uninspectedFiles ?? null,
      toUninspectedFiles: payload.capabilities.to.uninspectedFiles,
      notices: payload.notices ?? [],
    },
    diffUrl: options.diffUrl,
    computedAt: payload.cachedAt,
  };
}

// Ceiling is "needs-review", never an accusation: high and critical both fold
// into the tier that says a human must read the diff before acting.
function verdictGrade(risk: RiskLevel): VerdictGrade {
  if (risk === "high" || risk === "critical") return "needs-review";
  if (risk === "medium") return "notable";
  return "clear";
}

function countFindingSeverities(
  findings: ReadonlyArray<Pick<Finding, "severity">>,
): Record<Finding["severity"], number> {
  const counts: Record<Finding["severity"], number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
  };
  for (const finding of findings) {
    if (finding.severity in counts) counts[finding.severity]++;
  }
  return counts;
}
