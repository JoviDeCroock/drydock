import { DETERMINISTIC_RULE_IDS, DETERMINISTIC_RULES_VERSION } from "./review/rules";
import type { Finding } from "./review";

// Release-process fingerprint rules (release.source-drift).
//
// These findings are about how a release ARRIVED, not what the artifact
// contains: the dominant compromised-maintainer shape is a stolen credential
// publishing malicious versions outside the maintainer's normal CI release
// path. Drydock sits pre-publish with per-organization scan history, so it can
// flag a package that suddenly arrives through a different release path.
//
// A companion rule, `release.burst-anomaly`, used to live here: it flagged an
// organization staging >= 5 distinct packages inside 30 minutes for the first
// time. It was removed because a monorepo release train is exactly that shape.
// The suppression it relied on ("some earlier window in the last 180 days also
// burst") only holds once a train is already in history, so an org's first
// coordinated release — and every release train spaced more than 180 days
// apart — raised a high release finding, which rejects a workflow gate. The
// true-positive side never justified that: an attacker holding a stolen npm
// token publishes directly, not through the victim's staged-publish flow or CI
// gate, so the only bursts Drydock can actually observe are the legitimate
// ones. If the burst signal comes back it must be non-blocking, or conditioned
// on the packages also drifting off their usual release path.
//
// FP posture: silence over noise. The rule requires enough history to prove the
// deviation is abnormal, and any ambiguity (short history, mixed history)
// suppresses the finding entirely instead of emitting a hedged one.
//
// This module is pure — it takes plain history rows plus current-scan facts and
// returns findings — so the thresholds are unit-testable without a database.
// `server/db/release-fingerprint.ts` supplies the org-scoped rows.

/** Synthetic file label for findings that describe the release process itself. */
export const RELEASE_PROCESS_FINDING_FILE = "<release-process>";

/** Prior completed scans of the package required before source drift is judgeable. */
export const SOURCE_DRIFT_MIN_PRIOR_SCANS = 3;

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
 * relying on the row existing.
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
  current: CurrentScanFacts;
  /** Prior scans of the current package, excluding the current scan. */
  packageHistory: PackageScanHistoryRow[];
}

export function releaseFingerprintFindings(args: ReleaseFingerprintArgs): Finding[] {
  return sourceDriftFindings(args);
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
  // NUL-separated like every other composite key in the codebase, so a
  // repository or environment name containing the separator cannot make two
  // different gates read as the same release path.
  return `workflow_gate\0${path.repositoryFullName ?? ""}\0${path.environment ?? ""}`;
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
