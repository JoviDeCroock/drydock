import { DETERMINISTIC_RULE_IDS, DETERMINISTIC_RULES_VERSION } from "./review/rules";
import type { Finding } from "./review";

export const RELEASE_PROCESS_FINDING_FILE = "<release-process>";

export const SOURCE_DRIFT_MIN_PRIOR_SCANS = 3;

export interface PackageScanHistoryRow {
  id: string;
  status: string;
  source: string;
  gateRepositoryFullName: string | null;
  gateEnvironment: string | null;
}

export interface CurrentScanFacts {
  scanId: string;
  packageName: string | null;
  source: string | null;
  gateRepositoryFullName: string | null;
  gateEnvironment: string | null;
}

export interface ReleaseFingerprintArgs {
  current: CurrentScanFacts;
  packageHistory: PackageScanHistoryRow[];
}

export function releaseFingerprintFindings(args: ReleaseFingerprintArgs): Finding[] {
  return sourceDriftFindings(args);
}

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
  if (!current.packageName || !current.source) return [];

  const completed = args.packageHistory.filter(
    (row) => row.status === "complete" && row.id !== current.scanId,
  );
  if (completed.length < SOURCE_DRIFT_MIN_PRIOR_SCANS) return [];

  const priorKeys = new Set(completed.map((row) => releasePathKey(releasePathOf(row))));
  if (priorKeys.size !== 1) return [];

  const priorPath = releasePathOf(completed[0]);
  const currentPath = releasePathOf({
    source: current.source,
    gateRepositoryFullName: current.gateRepositoryFullName,
    gateEnvironment: current.gateEnvironment,
  });
  if (releasePathKey(priorPath) === releasePathKey(currentPath)) return [];

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
