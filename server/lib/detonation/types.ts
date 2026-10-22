/**
 * Contract between the detonation container harness
 * (`containers/detonation/harness.mjs`) and the trusted parent Worker.
 *
 * Everything the harness reports was produced inside a container that is
 * running the package under review, so it is hostile-influenced evidence: the
 * parent re-validates and bounds it (`parseHarnessReport`) and never treats a
 * missing event as proof that nothing happened. Egress events are different:
 * they are recorded by `DetonationEgress` outside the container, so package
 * code cannot suppress or forge them.
 */

export const DETONATION_HARNESS_VERSION = 1;

/** The ecosystem whose install and entry points a run drives. */
export type DetonationEcosystem = "npm" | "pypi";

/**
 * Which part of the run produced an event. npm runs `lifecycle`, `require`,
 * `import`, and `bin`. PyPI runs `startup` (a bare interpreter start, which is
 * when `.pth` files and `sitecustomize` execute), `import`, `bin` (a
 * `console_scripts` entry point with `--help`), and `build` (the sdist's PEP 517
 * build backend, which is what `pip install` of the sdist executes).
 */
export type DetonationStep = "lifecycle" | "require" | "import" | "bin" | "startup" | "build";

export type DetonationPhase = "prepare" | "detonate";

export interface HarnessStepResult {
  step: DetonationStep;
  /**
   * e.g. `left-pad@1.3.0:postinstall`, `left-pad:require`, `left-pad:bin:lp`;
   * for PyPI `litellm:startup`, `litellm:import:litellm`, `litellm:bin:litellm`,
   * `litellm:build`.
   */
  target: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
}

export type HarnessFileOp = "read" | "write" | "create" | "delete" | "chmod" | "rename";

/**
 * `syscall` events come from strace running as root outside the package's
 * uid; `runtime-hook` events come from the Node preload observer, which runs
 * inside the package's own process and can be disabled by it.
 */
export type HarnessEventSource = "syscall" | "runtime-hook";

interface HarnessEventBase {
  step: DetonationStep;
  /** The `HarnessStepResult.target` that was running, so writes can be attributed to a package. */
  target: string;
  pid: number;
  via: HarnessEventSource;
}

export type HarnessEvent = HarnessEventBase &
  (
    | { kind: "exec"; path: string; argv: string[] }
    | { kind: "file"; op: HarnessFileOp; path: string }
    | { kind: "connect"; family: "inet" | "inet6" | "unix"; address: string; port: number | null }
    | { kind: "dns"; hostname: string }
  );

export interface HarnessCoverage {
  /** Absent on results stored before PyPI runs existed, which were all npm. */
  ecosystem?: DetonationEcosystem;
  /** strace attached to every package process; false means runtime hooks only. */
  syscallTracing: boolean;
  /**
   * The in-process observer loaded: the Node preload for npm, the audit-hook
   * `.pth` for PyPI. Both run as the package user, so both are tamperable.
   */
  runtimeHooks: boolean;
  dependencyInstall: "complete" | "partial" | "failed";
  /**
   * Steps the harness never started because the time budget ran out. A run
   * that skipped the reviewed package's own steps is not a clean run.
   */
  stepsSkipped: number;
  /**
   * How far the package's code was driven. `load`: lifecycle scripts,
   * require/import, and bins with `--help`; no export was called, so a payload
   * that waits for a call or a browser never ran.
   */
  exercise: "load";
  /** The manifest ships a browser build, whose code paths never run in Node. */
  browserTargeted: boolean;
}

export interface HarnessReport {
  version: typeof DETONATION_HARNESS_VERSION;
  coverage: HarnessCoverage;
  steps: HarnessStepResult[];
  events: HarnessEvent[];
  /** The harness hit its own event cap and dropped the rest. */
  truncated: boolean;
}

/** A file the harness plants before detonation; its content holds a canary. */
export interface CanaryFile {
  path: string;
  content: string;
  mode: number;
}

/**
 * POST /prepare takes the raw `.tgz` as an `application/octet-stream` body
 * (the parent has already pinned its SHA-256) and installs it with
 * `--ignore-scripts`, so no package code runs during this phase.
 */
export interface HarnessPrepareResponse {
  ok: boolean;
  packageName: string | null;
  dependencyInstall: HarnessCoverage["dependencyInstall"];
}

/**
 * A reviewed PyPI distribution handed to the harness. POST /prepare-pypi takes
 * these framed by `encodePyPiPrepareBundle` (`server/lib/detonation/pypi.ts`),
 * installs the wheel with every dependency restricted to binary wheels, and
 * unpacks the sdist; no package code runs during that phase either.
 */
export interface PyPiDetonationFile {
  /** Bare distribution filename (`litellm-1.0.0-py3-none-any.whl`), never a path. */
  name: string;
  kind: "wheel" | "sdist";
  bytes: Uint8Array;
}

/** POST /detonate body: plant canaries, then run package code under observation. */
export interface HarnessDetonateRequest {
  version: typeof DETONATION_HARNESS_VERSION;
  canaryEnv: Record<string, string>;
  canaryFiles: CanaryFile[];
  /** Wall-clock budget per step; the harness kills the step's process group on expiry. */
  stepTimeoutMs: number;
  totalTimeoutMs: number;
}

export type CanaryKind =
  | "npm-token"
  | "pypi-token"
  | "github-token"
  | "aws-key"
  | "ssh-key"
  | "ci-oidc";

/** Recorded by `DetonationEgress` for every HTTP(S) request the container makes. */
export interface DetonationEgressEvent {
  phase: DetonationPhase;
  method: string;
  host: string;
  /** Path + query, truncated, with canary values replaced by `[canary:<kind>]`. */
  path: string;
  bodyBytes: number;
  canaryHits: CanaryKind[];
  action: "forwarded" | "sinkholed";
}

export type DetonationSignalId =
  | "dynamic.canary-exfiltration"
  | "dynamic.registry-publish-attempt"
  | "dynamic.network-egress"
  | "dynamic.credential-file-read"
  | "dynamic.persistence-write"
  | "dynamic.package-tampering"
  | "dynamic.suspicious-process"
  | "dynamic.sensitive-file-read";

export type DetonationSeverity = "low" | "medium" | "high" | "critical";

/** One classified behavior. Advisory: never merged into findings or risk. */
export interface DetonationSignal {
  id: DetonationSignalId;
  severity: DetonationSeverity;
  title: string;
  /** Bounded, redacted evidence lines (paths, hosts, argv), never request bodies. */
  evidence: string[];
  /** Where the behavior was observed. Egress-derived signals cannot be forged by the package. */
  source: "egress" | HarnessEventSource;
  step: DetonationStep | null;
}

export type DetonationStatus = "queued" | "running" | "complete" | "failed" | "skipped";

export type DetonationErrorCode =
  | "artifact_unavailable"
  | "artifact_digest_mismatch"
  | "artifact_too_large"
  /** No reviewed wheel installs on the sandbox's CPython/linux-x86_64, and there is no sdist. */
  | "platform_unsupported"
  | "container_unavailable"
  | "harness_failed"
  | "harness_report_invalid"
  | "timeout";

/**
 * One reviewed file a run executed, bound to the digest the scan recorded for
 * it. A PyPI run can carry a wheel and the release's sdist.
 */
export interface DetonationArtifact {
  path: string;
  sha256: string;
  role: "wheel" | "sdist";
}

/** Persisted summary of a run, as the API returns it. */
export interface DetonationResult {
  status: DetonationStatus;
  signals: DetonationSignal[];
  coverage: HarnessCoverage | null;
  steps: HarnessStepResult[];
  egress: DetonationEgressEvent[];
  /** Events or egress were truncated by a bound; the record is incomplete. */
  truncated: boolean;
  errorCode: DetonationErrorCode | null;
  /** PyPI runs only: which reviewed distributions ran, by bundle path and digest. */
  artifacts?: DetonationArtifact[];
}
