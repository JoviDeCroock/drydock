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

/**
 * Detonation is advisory, so the red Badge deterministic findings use is kept
 * for the two signals that are unambiguous on their own: a planted credential
 * leaving the machine, or a write to the registry. Everything else (a
 * telemetry ping is a `high` network-egress signal) reads as plain text.
 */
const BADGED_SIGNALS: ReadonlySet<DetonationSignal["id"]> = new Set([
  "dynamic.canary-exfiltration",
  "dynamic.registry-publish-attempt",
]);

export function signalNeedsBadge(id: DetonationSignal["id"]): boolean {
  return BADGED_SIGNALS.has(id);
}

/**
 * Only the ways a run fell short of full coverage. The intro already says the
 * package is installed and loaded, so a fully covered run has no parts.
 */
export function coverageParts(coverage: HarnessCoverage | null, truncated: boolean): string[] {
  const parts = coverage
    ? [
        coverage.syscallTracing ? null : "syscall tracing off",
        coverage.runtimeHooks ? null : "runtime hooks off",
        coverage.dependencyInstall === "complete"
          ? null
          : `dependency install ${coverage.dependencyInstall}`,
        coverage.stepsSkipped > 0
          ? `${coverage.stepsSkipped} ${coverage.stepsSkipped === 1 ? "step" : "steps"} not run`
          : null,
      ].filter((part): part is string => part !== null)
    : ["coverage not reported"];
  if (truncated) parts.push("record truncated");
  return parts;
}

/**
 * What a clean run cannot vouch for, or null when coverage was full for a
 * load-only run. A browser build never runs in the Node sandbox, so a web
 * library's payload (a wrapped `fetch` or wallet hook) would not show up.
 */
export function cleanRunCaveat(
  coverage: HarnessCoverage | null,
  truncated: boolean,
): string | null {
  if (coverage?.browserTargeted) {
    return "This package ships a browser build, which never runs in the sandbox, so a clean run does not cover it.";
  }
  const weak =
    !coverage ||
    !coverage.syscallTracing ||
    coverage.dependencyInstall !== "complete" ||
    coverage.stepsSkipped > 0 ||
    truncated;
  return weak ? "Limited coverage makes a clean run weaker evidence." : null;
}
