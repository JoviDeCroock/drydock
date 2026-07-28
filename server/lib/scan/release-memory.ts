// Release memory: advisory prior-release consistency for a scan.
//
// When a maintainer already reviewed and decided "publish" for a version of a
// package whose deterministic finding profile matches the current scan, the new
// scan says so instead of presenting the same capability findings as if they
// were novel (test runners legitimately spawn processes on every release).
//
// Findings are never edited, hidden, or re-severitied here — deterministic
// findings stay authoritative. The one scoring effect lives in `risk.ts`:
// package-context findings already present in the approved profile stop
// anchoring the headline risk. Release-delta findings are excluded from that
// adjustment, so `releaseRisk` (and the workflow gate reading it) cannot move.
// See docs/release-memory.md.

type ReleaseConsistencyStatus = "match" | "subset" | "diverged" | "none";

export interface FindingProfileEntry {
  ruleId: string;
  severity: string;
  file: string;
}

export interface ReleaseConsistency {
  status: ReleaseConsistencyStatus;
  /** The prior approved scan this scan was compared against; null for "none". */
  priorScanId: string | null;
  /** The prior approved scan's staged version, when it recorded one. */
  priorVersion: string | null;
  /** ISO timestamp of the prior scan's publish decision. */
  decidedAt: string | null;
  currentFindingCount: number;
  priorFindingCount: number;
  /** Total findings present now but absent from the approved profile. */
  newFindingCount: number;
  /** The new findings themselves, capped at NEW_FINDINGS_CAP entries. */
  newFindings: FindingProfileEntry[];
}

export const RELEASE_CONSISTENCY_NEW_FINDINGS_CAP = 25;

const STATUSES = new Set<ReleaseConsistencyStatus>(["match", "subset", "diverged", "none"]);

export interface ProfileFindingInput {
  ruleId?: string | null;
  severity: string;
  file: string;
}

/**
 * Build the finding profile: the multiset of (ruleId, severity, file) over rule
 * findings. `line` and `evidence` are deliberately ignored — a finding that
 * moved lines or re-rendered its evidence is still the same profile entry.
 * Findings without a ruleId participate as ruleId "unknown". Sorted stably by
 * (ruleId, severity, file) so equal multisets serialize identically.
 */
export function buildFindingProfile(findings: ProfileFindingInput[]): FindingProfileEntry[] {
  return findings
    .map((finding) => ({
      ruleId: finding.ruleId ?? "unknown",
      severity: finding.severity,
      file: finding.file,
    }))
    .sort(compareProfileEntries);
}

export interface ProfileComparison {
  status: "match" | "subset" | "diverged";
  newFindings: FindingProfileEntry[];
  newFindingCount: number;
}

/**
 * Compare two finding profiles as multisets:
 * - identical multisets → "match";
 * - current is a strict subset of the approved profile → "subset";
 * - anything present now that the approved profile lacked → "diverged", with
 *   the multiset difference (current − prior) reported as `newFindings`.
 */
export function compareFindingProfiles(
  current: FindingProfileEntry[],
  prior: FindingProfileEntry[],
): ProfileComparison {
  const priorCounts = countEntries(prior);

  const newFindings: FindingProfileEntry[] = [];
  for (const entry of [...current].sort(compareProfileEntries)) {
    const key = entryKey(entry);
    const remaining = priorCounts.get(key) ?? 0;
    if (remaining > 0) {
      priorCounts.set(key, remaining - 1);
    } else {
      newFindings.push(entry);
    }
  }

  if (newFindings.length > 0) {
    return {
      status: "diverged",
      newFindingCount: newFindings.length,
      newFindings: newFindings.slice(0, RELEASE_CONSISTENCY_NEW_FINDINGS_CAP),
    };
  }
  const status = current.length === prior.length ? "match" : "subset";
  return { status, newFindings: [], newFindingCount: 0 };
}

export interface PriorApprovedProfile {
  scanId: string;
  stagedVersion: string | null;
  decidedAt: Date | string | null;
  findings: ProfileFindingInput[];
}

/**
 * Fold a prior approved scan (or its absence) and the current scan's rule
 * findings into the persisted ReleaseConsistency object.
 */
export function computeReleaseConsistency(
  currentFindings: ProfileFindingInput[],
  prior: PriorApprovedProfile | null,
): ReleaseConsistency {
  const currentProfile = buildFindingProfile(currentFindings);
  if (!prior) return noneReleaseConsistency(currentProfile.length);

  const priorProfile = buildFindingProfile(prior.findings);
  const comparison = compareFindingProfiles(currentProfile, priorProfile);
  return {
    status: comparison.status,
    priorScanId: prior.scanId,
    priorVersion: prior.stagedVersion,
    decidedAt: toIsoOrNull(prior.decidedAt),
    currentFindingCount: currentProfile.length,
    priorFindingCount: priorProfile.length,
    newFindingCount: comparison.newFindingCount,
    newFindings: comparison.newFindings,
  };
}

export function noneReleaseConsistency(currentFindingCount = 0): ReleaseConsistency {
  return {
    status: "none",
    priorScanId: null,
    priorVersion: null,
    decidedAt: null,
    currentFindingCount,
    priorFindingCount: 0,
    newFindingCount: 0,
    newFindings: [],
  };
}

/**
 * Tolerant reader for the persisted `summary.releaseConsistency` blob. Old
 * scans predate the field entirely and malformed values must never break a
 * reader, so anything unusable normalizes to null (treated as "none"). Follows
 * the normalizeScanRiskBreakdown pattern in `risk.ts`.
 */
export function normalizeReleaseConsistency(value: unknown): ReleaseConsistency | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Partial<Record<keyof ReleaseConsistency, unknown>>;
  if (typeof item.status !== "string" || !STATUSES.has(item.status as ReleaseConsistencyStatus)) {
    return null;
  }
  return {
    status: item.status as ReleaseConsistencyStatus,
    priorScanId: typeof item.priorScanId === "string" ? item.priorScanId : null,
    priorVersion: typeof item.priorVersion === "string" ? item.priorVersion : null,
    decidedAt: typeof item.decidedAt === "string" ? item.decidedAt : null,
    currentFindingCount: normalizeCount(item.currentFindingCount),
    priorFindingCount: normalizeCount(item.priorFindingCount),
    newFindingCount: normalizeCount(item.newFindingCount),
    newFindings: normalizeNewFindings(item.newFindings),
  };
}

function normalizeCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function normalizeNewFindings(value: unknown): FindingProfileEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: FindingProfileEntry[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const item = entry as Partial<FindingProfileEntry>;
    if (
      typeof item.ruleId !== "string" ||
      typeof item.severity !== "string" ||
      typeof item.file !== "string"
    ) {
      continue;
    }
    entries.push({ ruleId: item.ruleId, severity: item.severity, file: item.file });
    if (entries.length >= RELEASE_CONSISTENCY_NEW_FINDINGS_CAP) break;
  }
  return entries;
}

function compareProfileEntries(a: FindingProfileEntry, b: FindingProfileEntry): number {
  return cmp(a.ruleId, b.ruleId) || cmp(a.severity, b.severity) || cmp(a.file, b.file);
}

function entryKey(entry: FindingProfileEntry): string {
  return `${entry.ruleId}\u0000${entry.severity}\u0000${entry.file}`;
}

function countEntries(entries: FindingProfileEntry[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const key = entryKey(entry);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function toIsoOrNull(value: Date | string | null): string | null {
  if (value == null) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  return value;
}
