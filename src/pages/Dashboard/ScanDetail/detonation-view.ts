import type {
  DetonationErrorCode,
  DetonationSignal,
  HarnessCoverage,
} from "../../../../server/lib/detonation/types";
import { sortFindingsBySeverity } from "../../../lib/findings";
import type { ScanDetonationResponse } from "../../../models/scan";

export type DetonationView =
  | { kind: "hidden" }
  | { kind: "not-run"; canRun: true }
  | { kind: "pending"; label: string }
  | { kind: "stalled"; message: string; canRun: boolean }
  | { kind: "unfinished"; message: string; canRun: boolean }
  | {
      kind: "complete";
      signals: DetonationSignal[];
      coverage: HarnessCoverage | null;
      truncated: boolean;
      canRun: boolean;
    };

const ERROR_MESSAGES: Record<DetonationErrorCode, string> = {
  artifact_too_large: "Skipped: the package is over the 16 MiB sandbox limit.",
  artifact_digest_mismatch:
    "Refused: the staged bytes changed since this review, so they were not run.",
  artifact_unavailable: "The staged tarball could not be fetched for the run.",
  container_unavailable: "The sandbox container was unavailable.",
  harness_failed: "The sandbox harness failed before reporting.",
  harness_report_invalid: "The sandbox returned a report that could not be read.",
  timeout: "The run timed out before the sandbox reported.",
};

// Both outcomes depend only on the reviewed bytes, so a rerun would spend a
// rate-limited run to get the same answer.
const DETERMINISTIC_ERRORS: ReadonlySet<DetonationErrorCode> = new Set([
  "artifact_too_large",
  "artifact_digest_mismatch",
]);

function detonationErrorMessage(code: DetonationErrorCode | null): string {
  return code ? ERROR_MESSAGES[code] : "The run did not complete.";
}

export function detonationView(data: ScanDetonationResponse | null): DetonationView {
  if (!data) return { kind: "hidden" };
  const run = data.detonation;
  if (!run) return data.eligible ? { kind: "not-run", canRun: true } : { kind: "hidden" };
  if (run.status === "queued" || run.status === "running") {
    if (run.stale) {
      return {
        kind: "stalled",
        message: "The run stalled before the sandbox reported.",
        canRun: data.eligible,
      };
    }
    return {
      kind: "pending",
      label: run.status === "queued" ? "Detonation queued" : "Running in the sandbox",
    };
  }
  if (run.status === "complete" && run.result) {
    return {
      kind: "complete",
      signals: sortFindingsBySeverity(run.result.signals),
      coverage: run.result.coverage,
      truncated: run.result.truncated,
      canRun: data.eligible,
    };
  }
  const code = run.errorCode ?? run.result?.errorCode ?? null;
  return {
    kind: "unfinished",
    message: detonationErrorMessage(code),
    canRun: data.eligible && !(code && DETERMINISTIC_ERRORS.has(code)),
  };
}

export function signalSourceHint(source: DetonationSignal["source"]): string {
  if (source === "egress") return "seen at the network boundary";
  if (source === "syscall") return "seen by syscall tracing";
  return "seen by an in-process hook the package can disable";
}

/** Badges are reserved for the severities that need attention. */
export function signalNeedsBadge(severity: DetonationSignal["severity"]): boolean {
  return severity === "critical" || severity === "high";
}

export function coverageParts(coverage: HarnessCoverage | null, truncated: boolean): string[] {
  const parts = coverage
    ? [
        `syscall tracing ${coverage.syscallTracing ? "on" : "off"}`,
        coverage.runtimeHooks ? null : "runtime hooks off",
        `dependency install ${coverage.dependencyInstall}`,
        coverage.stepsSkipped > 0
          ? `${coverage.stepsSkipped} ${coverage.stepsSkipped === 1 ? "step" : "steps"} not run`
          : null,
      ].filter((part): part is string => part !== null)
    : ["coverage not reported"];
  if (truncated) parts.push("record truncated");
  return parts;
}

/**
 * A clean run proves less when only the tamperable in-process hooks watched
 * it, or when some of the package never ran.
 */
export function weakCleanResult(coverage: HarnessCoverage | null, truncated: boolean): boolean {
  return (
    !coverage ||
    !coverage.syscallTracing ||
    coverage.dependencyInstall !== "complete" ||
    coverage.stepsSkipped > 0 ||
    truncated
  );
}
