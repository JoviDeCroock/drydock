import type { AppDb } from "../../db/client";
import type { AnyPackageAdapter } from "../ecosystems/package-adapter";
import type { FileRecord, PackageJsonSummary } from "../review";
import type { TarSuspiciousEntry } from "../tar-parser.js";

export type WorkflowArtifactKind = string;

export interface ParsedGateArtifact {
  path: string;
  sha256: string;
  sha1: string;
  ecosystem: string;
  kind: WorkflowArtifactKind;
  files: FileRecord[];
  packageJson: PackageJsonSummary | null;
  suspiciousEntries?: TarSuspiciousEntry[];
}

export interface ArchiveContents {
  files: FileRecord[];
  packageJson: PackageJsonSummary | null;
}

export interface PreparedReleaseCandidate {
  ecosystem: string;
  pipelineInput: Record<string, unknown>;
  package: { name: string; version: string };
}

export interface WorkflowGateAdapter {
  readonly ecosystem: string;
  readonly artifactName: string;

  readonly shardedArtifactNames?: boolean;
  readonly packageAdapter: AnyPackageAdapter;

  classifyArtifact(path: string): WorkflowArtifactKind | null;

  /**
   * Claim an extension-ambiguous archive (`.tgz` is both npm and sdist) by
   * content. Ecosystems whose artifacts have an unambiguous extension omit it.
   */
  detectArtifact?(contents: ArchiveContents): WorkflowArtifactKind | null;

  // Artifacts contain parsed evidence only; no installation token reaches adapters.
  prepareReleaseCandidates(artifacts: ParsedGateArtifact[]): PreparedReleaseCandidate[];

  narrowParsedArtifact?(
    artifact: ParsedGateArtifact,
    retainedSamples: Map<string, string>,
  ): ParsedGateArtifact;

  /**
   * Basenames of small non-distribution files this adapter reads from the
   * bundle (PyPI: `pypi-stage.json`). Collected bounded and handed to
   * `prepareStagedReleaseCandidates`; never parsed as release artifacts.
   */
  readonly sidecarFileNames?: readonly string[];

  /**
   * Review registry-held staged bytes named by a sidecar instead of (or bound
   * to) the bundle's own distributions. Runs only when this adapter's sidecars
   * are present; otherwise the gate calls `prepareReleaseCandidates` as before.
   * Failures throw `WorkflowArtifactError`, which rejects the deployment.
   */
  prepareStagedReleaseCandidates?(input: StagedReleaseInput): Promise<PreparedReleaseCandidate[]>;

  /**
   * Registry-held releases Drydock controls for a gate (PyPI PEP 694 mode B).
   * Publish and cancel run only inside a maintainer's decision; the cron only
   * keeps held releases alive and observes them.
   */
  readonly heldReleases?: HeldReleaseHooks;
}

export interface HeldReleaseHooks {
  list(db: AppDb, organizationId: string, gateId: string): Promise<PublicHeldRelease[]>;
  /** Before the completing approval is recorded; publishes nothing. Refusal blocks it. */
  verify(
    env: Cloudflare.Env,
    db: AppDb,
    organizationId: string,
    gateId: string,
  ): Promise<{ ok: true } | { ok: false; error: string }>;
  /**
   * Only after the completing approval won the gate CAS. A refusal means the
   * release did not (fully) publish; the route turns the approval into a
   * fail-closed rejection.
   */
  publish(
    env: Cloudflare.Env,
    db: AppDb,
    organizationId: string,
    gateId: string,
    actorUserId: string,
  ): Promise<{ ok: true } | { ok: false; error: string }>;
  /** After a maintainer's rejection is recorded; never blocks it. */
  cancel(env: Cloudflare.Env, db: AppDb, organizationId: string, gateId: string): Promise<void>;
  /** Cron upkeep: bounded and idempotent. */
  sweep(env: Cloudflare.Env, db: AppDb, now: number): Promise<void>;
  /**
   * Approved gates GitHub has not acknowledged long after the decision, with
   * how to settle each: `deliver` once every held release is published,
   * `reject` (fail-closed) when one never will be. Gates still publishing are
   * omitted.
   */
  undeliveredApprovals(
    db: AppDb,
    now: number,
  ): Promise<Array<{ organizationId: string; gateId: string; settlement: "deliver" | "reject" }>>;
}

/** Browser-safe view of a held release; never carries URLs or credentials. */
export interface PublicHeldRelease {
  ecosystem: string;
  projectName: string;
  version: string;
  index: string;
  state: string;
  stateDetail: string | null;
  expiresAt: number | null;
  updatedAt: number;
}

interface GateSidecarFile {
  path: string;
  bytes: Uint8Array;
}

export interface StagedReleaseInput {
  env: Cloudflare.Env;
  db: AppDb;
  organizationId: string;
  gateId: string;
  sidecars: GateSidecarFile[];
  /** This ecosystem's slice of the bundle's parsed distributions (may be empty). */
  artifacts: ParsedGateArtifact[];
  /** Parse fetched bytes through the same credentials-free sandbox router. */
  parse(file: GateStagedFile): Promise<ParsedGateArtifact>;
  /**
   * Stream this ecosystem's release files from the workflow run again, one at
   * a time, for an adapter that must hand the reviewed bytes on (PEP 694 mode
   * B uploads them). Parsed evidence keeps no raw bytes; callers check each
   * file's sha256 against the reviewed digest before using it.
   */
  rereadReleaseFiles(onFile: (file: GateStagedFile) => Promise<void>): Promise<void>;
}

interface GateStagedFile {
  path: string;
  bytes: Uint8Array;
  sha256: string;
  sha1: string;
  ecosystem: string;
  kind: WorkflowArtifactKind;
}
