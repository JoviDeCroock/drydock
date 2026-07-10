import { DETERMINISTIC_RULE_IDS, DETERMINISTIC_RULES_VERSION } from "./review/rules";
import type { Finding } from "./review";

// Release-process fingerprint rules (release.burst-anomaly / release.source-drift).
//
// These findings are about how a release ARRIVED, not what the artifact
// contains: the dominant compromised-maintainer shape is a stolen credential
// burst-publishing malicious versions across many packages, usually bypassing
// the usual CI release path. Drydock sits pre-publish with per-organization
// scan history, so it can flag releases that deviate from how this org/package
// normally releases.
//
// FP posture: silence over noise. Both rules require enough history to prove
// the deviation is abnormal, and any ambiguity (short history, mixed history,
// prior burst windows, truncated history fetches) suppresses the finding
// entirely instead of emitting a hedged one.
//
// This module is pure — it takes plain history rows plus current-scan facts and
// returns findings — so the thresholds are unit-testable without a database.
// `server/db/release-fingerprint.ts` supplies the org-scoped rows.

/** Synthetic file label for findings that describe the release process itself. */
export const RELEASE_PROCESS_FINDING_FILE = "<release-process>";

/** Burst window: distinct packages scanned inside this span count as one burst. */
export const BURST_WINDOW_MS = 30 * 60 * 1000;
/** Distinct package names inside one window needed to call it a burst. */
export const BURST_DISTINCT_PACKAGE_THRESHOLD = 5;
/** The org needs at least this much scan history before a burst is judgeable. */
export const BURST_MIN_ORG_HISTORY_DAYS = 30;
/** ...and at least this many prior completed scans. */
export const BURST_MIN_PRIOR_COMPLETED_SCANS = 5;
/** How far back the prior-burst sweep looks for an established release train. */
export const BURST_LOOKBACK_DAYS = 180;
/** Cap on package names spelled out in the finding evidence. */
export const BURST_EVIDENCE_PACKAGE_LIMIT = 8;

/** Prior completed scans of the package required before source drift is judgeable. */
export const SOURCE_DRIFT_MIN_PRIOR_SCANS = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

/** One org-scoped scan row from the burst lookback window (current scan excluded). */
export interface OrgScanHistoryRow {
  id: string;
  packageName: string | null;
  status: string;
  createdAt: Date;
}

/** One prior scan of the current package (current scan excluded). */
export interface PackageScanHistoryRow {
  id: string;
  status: string;
  source: string;
  gateRepositoryFullName: string | null;
  gateEnvironment: string | null;
}

/**
 * Facts about the scan being reviewed right now. The scan row may not be
 * persisted (or terminal) yet, so callers pass these explicitly instead of
 * relying on the row existing — the burst count includes the current scan via
 * `packageName`, never via a database row.
 */
export interface CurrentScanFacts {
  scanId: string;
  packageName: string | null;
  /** `scans.source` for this scan, or null when unknown (drift is skipped). */
  source: string | null;
  gateRepositoryFullName: string | null;
  gateEnvironment: string | null;
}

export interface ReleaseFingerprintArgs {
  now: Date;
  current: CurrentScanFacts;
  /** Org scans from the last BURST_LOOKBACK_DAYS, excluding the current scan. */
  orgHistory: OrgScanHistoryRow[];
  /**
   * True when the history fetch hit its row cap, i.e. older rows inside the
   * lookback window were not loaded. An unseen prior burst window could make a
   * "first ever" claim wrong, so a truncated fetch suppresses the burst rule.
   */
  orgHistoryTruncated?: boolean;
  /** Prior scans of the current package, excluding the current scan. */
  packageHistory: PackageScanHistoryRow[];
}

export function releaseFingerprintFindings(args: ReleaseFingerprintArgs): Finding[] {
  return [...burstAnomalyFindings(args), ...sourceDriftFindings(args)];
}

// ── release.burst-anomaly ────────────────────────────────────────────────────

function burstAnomalyFindings(args: ReleaseFingerprintArgs): Finding[] {
  const nowMs = args.now.getTime();
  const windowStartMs = nowMs - BURST_WINDOW_MS;
  const rows = args.orgHistory.filter((row) => row.id !== args.current.scanId);

  // Current 30-minute window, counting the in-flight scan explicitly.
  const windowPackages = new Set<string>();
  if (args.current.packageName) windowPackages.add(args.current.packageName);
  for (const row of rows) {
    const createdAtMs = row.createdAt.getTime();
    if (createdAtMs > windowStartMs && createdAtMs <= nowMs && row.packageName) {
      windowPackages.add(row.packageName);
    }
  }
  if (windowPackages.size < BURST_DISTINCT_PACKAGE_THRESHOLD) return [];

  // A capped fetch may have dropped a prior burst window; without the full
  // lookback we cannot prove the burst is abnormal, so emit nothing.
  if (args.orgHistoryTruncated) return [];

  // The org must have enough history for "this never happens here" to mean
  // anything: >= BURST_MIN_ORG_HISTORY_DAYS of scans and >= 5 prior completions.
  const historyFloorMs = nowMs - BURST_MIN_ORG_HISTORY_DAYS * DAY_MS;
  if (!rows.some((row) => row.createdAt.getTime() <= historyFloorMs)) return [];
  const completedCount = rows.reduce(
    (count, row) => (row.status === "complete" ? count + 1 : count),
    0,
  );
  if (completedCount < BURST_MIN_PRIOR_COMPLETED_SCANS) return [];

  // Monorepo release trains legitimately publish many packages at once; if any
  // prior window already reached the threshold, bursts are normal here.
  const priorEvents = rows
    .filter(
      (row): row is OrgScanHistoryRow & { packageName: string } =>
        row.packageName !== null && row.createdAt.getTime() <= windowStartMs,
    )
    .map((row) => ({ atMs: row.createdAt.getTime(), packageName: row.packageName }))
    .sort((a, b) => a.atMs - b.atMs);
  if (hasPriorBurstWindow(priorEvents)) return [];

  const names = [...windowPackages].sort((a, b) => a.localeCompare(b));
  const shown = names.slice(0, BURST_EVIDENCE_PACKAGE_LIMIT);
  const overflow = names.length - shown.length;
  return [
    {
      severity: "high",
      file: RELEASE_PROCESS_FINDING_FILE,
      evidence: `${names.length} distinct packages staged for release in this organization within 30 minutes: ${shown.join(", ")}${overflow > 0 ? ` (+${overflow} more)` : ""}`,
      reason:
        "this organization has never released this many distinct packages inside one 30-minute window in the last 180 days; a sudden multi-package publish burst is the dominant shape of a compromised maintainer account pushing malicious versions across every package it controls — verify each staged release before publishing",
      ruleId: DETERMINISTIC_RULE_IDS.releaseBurstAnomaly,
      ruleVersion: DETERMINISTIC_RULES_VERSION,
    },
  ];
}

/**
 * Linear two-pointer sweep over time-ascending (atMs, packageName) events:
 * returns true when any trailing BURST_WINDOW_MS window holds
 * BURST_DISTINCT_PACKAGE_THRESHOLD distinct package names.
 */
function hasPriorBurstWindow(events: Array<{ atMs: number; packageName: string }>): boolean {
  const counts = new Map<string, number>();
  let left = 0;
  for (const event of events) {
    counts.set(event.packageName, (counts.get(event.packageName) ?? 0) + 1);
    while (events[left].atMs <= event.atMs - BURST_WINDOW_MS) {
      const name = events[left].packageName;
      const count = counts.get(name) ?? 0;
      if (count <= 1) counts.delete(name);
      else counts.set(name, count - 1);
      left += 1;
    }
    if (counts.size >= BURST_DISTINCT_PACKAGE_THRESHOLD) return true;
  }
  return false;
}

// ── release.source-drift ─────────────────────────────────────────────────────

/**
 * A release path is the route a scan arrived through. Manual and
 * auto-discovery scans collapse into one "staged" path on purpose: they review
 * the same staged publish endpoint (the cron and the "Check npm" button are
 * interchangeable triggers), so treating them as distinct paths would flag
 * routine behavior. Workflow-gate scans additionally carry repository +
 * environment, because "same gate, different repo" is itself a drift.
 */
interface ReleasePath {
  kind: "staged" | "workflow_gate";
  repositoryFullName: string | null;
  environment: string | null;
}

function releasePathOf(row: {
  source: string;
  gateRepositoryFullName: string | null;
  gateEnvironment: string | null;
}): ReleasePath {
  if (row.source === "workflow_gate") {
    return {
      kind: "workflow_gate",
      repositoryFullName: row.gateRepositoryFullName,
      environment: row.gateEnvironment,
    };
  }
  return { kind: "staged", repositoryFullName: null, environment: null };
}

function releasePathKey(path: ReleasePath): string {
  if (path.kind === "staged") return "staged";
  return `workflow_gate ${path.repositoryFullName ?? ""} ${path.environment ?? ""}`;
}

function describeReleasePath(path: ReleasePath): string {
  if (path.kind === "staged") return "a staged-publish review (manual or auto-discovery)";
  const repo = path.repositoryFullName ?? "unknown repository";
  const environment = path.environment ?? "unknown environment";
  return `the ${repo} workflow gate (${environment})`;
}

function sourceDriftFindings(args: ReleaseFingerprintArgs): Finding[] {
  const { current } = args;
  // Without a package identity or a known source there is no fingerprint to
  // compare against; emit nothing.
  if (!current.packageName || !current.source) return [];

  const completed = args.packageHistory.filter(
    (row) => row.status === "complete" && row.id !== current.scanId,
  );
  if (completed.length < SOURCE_DRIFT_MIN_PRIOR_SCANS) return [];

  const priorKeys = new Set(completed.map((row) => releasePathKey(releasePathOf(row))));
  // Mixed history: this package has no single established release path.
  if (priorKeys.size !== 1) return [];

  const priorPath = releasePathOf(completed[0]);
  const currentPath = releasePathOf({
    source: current.source,
    gateRepositoryFullName: current.gateRepositoryFullName,
    gateEnvironment: current.gateEnvironment,
  });
  if (releasePathKey(priorPath) === releasePathKey(currentPath)) return [];

  // The credential-compromise shape: a package that always ships through its
  // CI workflow gate suddenly arriving outside it. Other drifts (repo or
  // environment change, staged -> gate) are notable but weaker evidence.
  const bypassedGate = priorPath.kind === "workflow_gate" && currentPath.kind !== "workflow_gate";
  return [
    {
      severity: bypassedGate ? "high" : "medium",
      file: RELEASE_PROCESS_FINDING_FILE,
      evidence: `all ${completed.length} prior completed scans of ${current.packageName} arrived via ${describeReleasePath(priorPath)}; this release arrived via ${describeReleasePath(currentPath)}`,
      reason: bypassedGate
        ? "every prior release of this package went through its CI workflow gate; a release that bypasses that gate matches the compromised-account shape where an attacker publishes directly with a stolen token instead of through CI — confirm this release was intentional before publishing"
        : "this release arrived through a different release path than every prior scan of this package; a changed release process is worth confirming with the maintainer before publishing",
      ruleId: DETERMINISTIC_RULE_IDS.releaseSourceDrift,
      ruleVersion: DETERMINISTIC_RULES_VERSION,
    },
  ];
}
