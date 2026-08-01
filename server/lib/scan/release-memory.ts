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

/** Bump when the persisted profile shape changes. */
const FINDING_PROFILE_VERSION = 1;

/**
 * Upper bound on entries in the persisted profile. Above it the profile is not
 * stored at all (the reader falls back to the prior scan's artifacts) rather than
 * stored truncated: a truncated profile is indistinguishable from a smaller one,
 * so it would report findings the prior release actually had as "new" — a
 * fabricated `diverged`. Release memory fails closed, never confidently wrong.
 */
const FINDING_PROFILE_MAX_ENTRIES = 2000;

export interface PersistedFindingProfile {
  version: number;
  findings: FindingProfileEntry[];
}

/**
 * The compact, canonically-ordered finding profile persisted on the scan row
 * (`scans.finding_profile_json`) at completion, so a later scan of the same
 * package can read this multiset directly instead of downloading and
 * digest-verifying the whole prior R2 report/files/diff bundle just to project
 * three fields out of it. Deterministic rule findings only — the caller passes
 * the same redacted rule set it persists, and AI findings must never enter a
 * profile (docs/release-memory.md).
 *
 * Returns null when the profile is too large to be worth a D1 column; callers
 * store null and the read path falls back to the artifact projection.
 */
export function buildPersistedFindingProfile(
  findings: ProfileFindingInput[],
): PersistedFindingProfile | null {
  if (findings.length > FINDING_PROFILE_MAX_ENTRIES) return null;
  return { version: FINDING_PROFILE_VERSION, findings: buildFindingProfile(findings) };
}

/**
 * Tolerant reader for the persisted profile. Rows written before the column
 * existed hold null, and a malformed blob must degrade to the legacy artifact
 * path rather than to a fabricated empty profile — an empty profile would mark
 * every current finding new. So anything unusable reads null, and only a
 * structurally valid envelope (including a genuinely empty `findings` array,
 * which is what a clean scan records) is trusted.
 */
export function readPersistedFindingProfile(value: unknown): FindingProfileEntry[] | null {
  const parsed = typeof value === "string" ? safeParseJson(value) : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const item = parsed as Partial<Record<keyof PersistedFindingProfile, unknown>>;
  if (item.version !== FINDING_PROFILE_VERSION || !Array.isArray(item.findings)) return null;
  const entries: FindingProfileEntry[] = [];
  for (const entry of item.findings) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const finding = entry as Partial<FindingProfileEntry>;
    if (
      typeof finding.ruleId !== "string" ||
      typeof finding.severity !== "string" ||
      typeof finding.file !== "string"
    ) {
      return null;
    }
    entries.push({ ruleId: finding.ruleId, severity: finding.severity, file: finding.file });
  }
  return entries;
}

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
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
