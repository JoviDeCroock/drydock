import { normalizeReleaseConsistency, type ReleaseConsistency } from "../scan/release-memory";

export function formatPackageLabel(
  packageName: string | null | undefined,
  version: string | null | undefined,
): string {
  if (packageName && version) return `${packageName}@${version}`;
  return packageName ?? "a staged release";
}

export function formatFindingsSummary(
  riskSummary: { releaseFindingCount: number; contextFindingCount: number } | null | undefined,
): string | null {
  if (!riskSummary) return null;
  const total = riskSummary.releaseFindingCount + riskSummary.contextFindingCount;
  if (total === 0) return "No findings";
  return `${total} findings (${riskSummary.releaseFindingCount} on the release diff)`;
}

export function formatReleaseMemory(summaryJson: unknown): string | null {
  if (!summaryJson || typeof summaryJson !== "object" || Array.isArray(summaryJson)) return null;
  const consistency = normalizeReleaseConsistency(
    (summaryJson as { releaseConsistency?: unknown }).releaseConsistency,
  );
  if (!consistency || consistency.status === "none") return null;

  const prior = priorReleaseLabel(consistency);
  if (consistency.status === "diverged") {
    const count = consistency.newFindingCount;
    return `${count} new deterministic ${count === 1 ? "finding" : "findings"} since ${prior}.`;
  }
  if (consistency.currentFindingCount === 0) {
    return `No deterministic findings; compared with ${prior}, which was already reviewed and published.`;
  }
  if (consistency.status === "subset") {
    return `No new deterministic findings since ${prior}; every current finding was already reviewed and published.`;
  }
  return `Finding profile matches ${prior}; the same deterministic findings were already reviewed and published.`;
}

function priorReleaseLabel(consistency: ReleaseConsistency): string {
  return consistency.priorVersion ? `v${consistency.priorVersion}` : "the last approved release";
}

/**
 * A UTC date for an email body. Deliberately not localized: the recipient's
 * timezone is unknown here, and an unlabelled local-looking timestamp is worse
 * than an explicitly-UTC one.
 */
export function formatTimestamp(value: Date | string | number | null): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  const ms = date.getTime();
  if (Number.isNaN(ms)) return null;
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}
