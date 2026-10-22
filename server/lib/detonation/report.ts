import { isRecord } from "../platform/guards";
import {
  DETONATION_HARNESS_VERSION,
  type DetonationStep,
  type HarnessCoverage,
  type HarnessEvent,
  type HarnessEventSource,
  type HarnessFileOp,
  type HarnessReport,
  type HarnessStepResult,
} from "./types";

/**
 * Re-validates the harness report. It was produced by root code inside the
 * container, but the package ran next to it and may have crashed, outlived,
 * or confused it, so every field is narrowed and bounded here rather than
 * trusted for shape. Malformed events are dropped individually; a malformed
 * envelope rejects the whole report.
 */

const MAX_EVENTS = 2000;
const MAX_STEPS = 200;
const MAX_STRING = 512;
const MAX_ARGV = 16;
const MAX_ARG = 256;

const STEPS = new Set<DetonationStep>([
  "lifecycle",
  "require",
  "import",
  "bin",
  "startup",
  "build",
]);
const FILE_OPS = new Set<HarnessFileOp>(["read", "write", "create", "delete", "chmod", "rename"]);
const SOURCES = new Set<HarnessEventSource>(["syscall", "runtime-hook"]);
const INSTALL_STATES = new Set<HarnessCoverage["dependencyInstall"]>([
  "complete",
  "partial",
  "failed",
]);

function boundedString(value: unknown, max = MAX_STRING): string | null {
  if (typeof value !== "string") return null;
  // Control characters would let a crafted path forge extra evidence lines in the UI.
  // eslint-disable-next-line no-control-regex -- stripping C0 is the point
  return value.replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, max);
}

function boundedInt(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function parseStep(value: unknown): HarnessStepResult | null {
  if (!isRecord(value)) return null;
  const step = value.step as DetonationStep;
  const target = boundedString(value.target);
  const durationMs = boundedInt(value.durationMs);
  if (!STEPS.has(step) || target === null || durationMs === null) return null;
  return {
    step,
    target,
    exitCode: value.exitCode === null ? null : boundedInt(value.exitCode),
    timedOut: value.timedOut === true,
    durationMs: Math.max(0, durationMs),
  };
}

function parseEvent(value: unknown): HarnessEvent | null {
  if (!isRecord(value)) return null;
  const step = value.step as DetonationStep;
  const via = value.via as HarnessEventSource;
  const target = boundedString(value.target);
  const pid = boundedInt(value.pid) ?? 0;
  if (!STEPS.has(step) || !SOURCES.has(via) || target === null) return null;
  const base = { step, target, pid, via };

  switch (value.kind) {
    case "exec": {
      const path = boundedString(value.path);
      if (path === null || !Array.isArray(value.argv)) return null;
      const argv = value.argv
        .slice(0, MAX_ARGV)
        .map((arg) => boundedString(arg, MAX_ARG))
        .filter((arg): arg is string => arg !== null);
      return { ...base, kind: "exec", path, argv };
    }
    case "file": {
      const path = boundedString(value.path);
      const op = value.op as HarnessFileOp;
      if (path === null || !FILE_OPS.has(op)) return null;
      return { ...base, kind: "file", op, path };
    }
    case "connect": {
      const address = boundedString(value.address);
      const family = value.family;
      if (address === null || (family !== "inet" && family !== "inet6" && family !== "unix")) {
        return null;
      }
      const port = value.port === null ? null : boundedInt(value.port);
      return { ...base, kind: "connect", family, address, port };
    }
    case "dns": {
      const hostname = boundedString(value.hostname, 253);
      if (hostname === null) return null;
      return { ...base, kind: "dns", hostname };
    }
    default:
      return null;
  }
}

function parseCoverage(value: unknown): HarnessCoverage | null {
  if (!isRecord(value)) return null;
  const dependencyInstall = value.dependencyInstall as HarnessCoverage["dependencyInstall"];
  if (!INSTALL_STATES.has(dependencyInstall)) return null;
  return {
    // Absent means npm, as on every result stored before PyPI runs existed.
    ...(value.ecosystem === "pypi" ? { ecosystem: "pypi" as const } : {}),
    syscallTracing: value.syscallTracing === true,
    runtimeHooks: value.runtimeHooks === true,
    dependencyInstall,
    stepsSkipped: Math.max(0, boundedInt(value.stepsSkipped) ?? 0),
    exercise: "load",
    browserTargeted: value.browserTargeted === true,
  };
}

export function parseHarnessReport(value: unknown): HarnessReport | null {
  if (!isRecord(value) || value.version !== DETONATION_HARNESS_VERSION) return null;
  const coverage = parseCoverage(value.coverage);
  if (!coverage || !Array.isArray(value.steps) || !Array.isArray(value.events)) return null;

  const steps = value.steps
    .slice(0, MAX_STEPS)
    .map(parseStep)
    .filter((step): step is HarnessStepResult => step !== null);
  const events = value.events
    .slice(0, MAX_EVENTS)
    .map(parseEvent)
    .filter((event): event is HarnessEvent => event !== null);

  return {
    version: DETONATION_HARNESS_VERSION,
    coverage,
    steps,
    events,
    truncated:
      value.truncated === true ||
      value.events.length > MAX_EVENTS ||
      value.steps.length > MAX_STEPS,
  };
}

/** Best-effort read of the prepare response; only the install outcome is used. */
export function parsePrepareInstall(value: unknown): HarnessCoverage["dependencyInstall"] | null {
  if (!isRecord(value)) return null;
  const state = value.dependencyInstall as HarnessCoverage["dependencyInstall"];
  return INSTALL_STATES.has(state) ? state : null;
}
