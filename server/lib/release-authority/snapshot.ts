// Release-authority snapshot: the canonical, bounded projection of *what was
// authorized to publish this release*, as opposed to what bytes it produced.
//
// Trusted publishing proves identity and run context — this repository, this
// workflow, this environment, this run. It does not prove that the authority
// graph behind that identity is still the one maintainers agreed to. The
// snapshot captures that graph so a later release can be compared against the
// last one a maintainer approved (see `delta.ts`).
//
// Two digests per workflow make the comparison honest in both directions:
//   - `rawDigest` changes on any edit at all, including comments and reordering;
//   - `authorityDigest` covers only the projected authority, so a cosmetic edit
//     leaves it untouched.
// A release where raw digests moved but authority digests did not is exactly
// the "cosmetic change" case that must never raise a high-signal warning.
//
// Workflow definitions are repository content and are treated as hostile
// evidence: read and projected, never evaluated.

import { sha256Hex, stableJson } from "../platform/stable-json";
import { type YamlValue, asRecord, asString, asStringList } from "./yaml";

export const RELEASE_AUTHORITY_SCHEMA = "drydock.release-authority.v1";

// Bounds on the persisted blob. A release that exceeds one of these records the
// truncation in `coverage` instead of silently reporting a shorter graph.
const MAX_WORKFLOWS = 32;
const MAX_ENTRIES_PER_LIST = 256;
const MAX_DETAIL_LENGTH = 300;
const MAX_UNRESOLVED = 32;

export type PermissionLevel = "read" | "write" | "none" | "unknown";

export interface ReleaseAuthorityRun {
  repositoryFullName: string;
  environment: string;
  runId: number;
  runAttempt: number | null;
  workflowPath: string | null;
  headSha: string | null;
  ref: string | null;
  event: string | null;
  actor: string | null;
  triggeringActor: string | null;
}

export interface AuthorityWorkflowRef {
  /** Repo-qualified so a referenced workflow from another repo is unambiguous. */
  path: string;
  repositoryFullName: string;
  sha: string | null;
  ref: string | null;
  role: "entry" | "referenced";
  /** sha256 of the raw definition; moves on any edit, cosmetic included. */
  rawDigest: string | null;
  /** sha256 of this workflow's authority projection; stable across cosmetic edits. */
  authorityDigest: string | null;
}

export interface AuthorityTrigger {
  workflow: string;
  event: string;
  /** Normalized branch/tag/path/type filters, or "" when the event is unfiltered. */
  filter: string;
}

export interface AuthorityPermission {
  workflow: string;
  /** null for a workflow-level `permissions:` block. */
  job: string | null;
  /** A named scope such as `id-token`, or `*` for the `read-all`/`write-all` shorthands. */
  scope: string;
  level: PermissionLevel;
}

export interface AuthorityEnvironment {
  workflow: string;
  job: string;
  name: string;
}

export interface AuthorityActionRef {
  workflow: string;
  job: string;
  uses: string;
  /** The part after `@`, or null for a local path reference. */
  ref: string | null;
  /** True when the reference cannot move: a 40-hex commit sha, or a local path. */
  pinned: boolean;
  /** `secrets: inherit` on a reusable-workflow call hands over the caller's secrets. */
  secretsInherit: boolean;
}

export interface AuthorityPublishStep {
  workflow: string;
  job: string;
  kind: "action" | "run";
  /**
   * The publish action reference, or the matched command line, truncated.
   *
   * A `run:` line is stored as written, which means an expression such as
   * `${{ secrets.PYPI_TOKEN }}` is retained as that literal template text —
   * never as a resolved value, because nothing here evaluates expressions. That
   * is the point: which credential a publish step reaches for is exactly the
   * kind of authority a maintainer needs to see change.
   */
  detail: string;
}

export interface AuthoritySafeguard {
  workflow: string;
  job: string;
  kind: "attestation" | "signing" | "provenance";
  detail: string;
}

export interface AuthorityArtifactFlow {
  workflow: string;
  job: string;
  direction: "upload" | "download";
  name: string;
  path: string;
}

export interface AuthorityArtifact {
  name: string;
  kind: string;
  sha256: string;
}

export type AuthorityUnresolvedReason =
  | "not_accessible"
  | "fetch_failed"
  | "too_large"
  | "unparseable"
  | "partially_parsed"
  | "limit_reached";

export interface AuthorityUnresolved {
  path: string;
  reason: AuthorityUnresolvedReason;
}

export interface AuthorityCoverage {
  /**
   * False when any part of the graph could not be read. A partial snapshot must
   * never be presented as "no authority change" — an unreadable reusable
   * workflow is precisely where a change would hide.
   */
  complete: boolean;
  unresolved: AuthorityUnresolved[];
}

export interface ReleaseAuthoritySnapshot {
  schema: typeof RELEASE_AUTHORITY_SCHEMA;
  run: ReleaseAuthorityRun;
  workflows: AuthorityWorkflowRef[];
  triggers: AuthorityTrigger[];
  permissions: AuthorityPermission[];
  environments: AuthorityEnvironment[];
  actions: AuthorityActionRef[];
  publishSteps: AuthorityPublishStep[];
  safeguards: AuthoritySafeguard[];
  artifactFlow: AuthorityArtifactFlow[];
  artifacts: AuthorityArtifact[];
  coverage: AuthorityCoverage;
}

/** One workflow definition to project, already fetched by the caller. */
export interface WorkflowSource {
  path: string;
  repositoryFullName: string;
  sha: string | null;
  ref: string | null;
  role: "entry" | "referenced";
  /** Raw YAML text. Never executed; parsed by the bounded reader in `yaml.ts`. */
  content: string;
  /** Parsed document, or null when the reader could not read it at all. */
  document: YamlValue;
  /** False when the reader stopped early; recorded as partial coverage. */
  documentComplete: boolean;
}

export interface BuildSnapshotInput {
  run: ReleaseAuthorityRun;
  workflows: WorkflowSource[];
  artifacts: AuthorityArtifact[];
  /** Definitions the caller could not fetch at all. */
  unresolved: AuthorityUnresolved[];
}

/**
 * Project fetched workflow definitions, run context, and the reviewed artifact
 * digests into the canonical snapshot. Every list is sorted so two runs with
 * the same authority serialize identically — the property the delta and the
 * digests both depend on.
 */
export async function buildReleaseAuthoritySnapshot(
  input: BuildSnapshotInput,
): Promise<ReleaseAuthoritySnapshot> {
  const unresolved: AuthorityUnresolved[] = [...input.unresolved];
  const sources = input.workflows.slice(0, MAX_WORKFLOWS);
  if (input.workflows.length > MAX_WORKFLOWS) {
    unresolved.push({
      path: `+${input.workflows.length - MAX_WORKFLOWS} more`,
      reason: "limit_reached",
    });
  }

  const workflows: AuthorityWorkflowRef[] = [];
  const triggers: AuthorityTrigger[] = [];
  const permissions: AuthorityPermission[] = [];
  const environments: AuthorityEnvironment[] = [];
  const actions: AuthorityActionRef[] = [];
  const publishSteps: AuthorityPublishStep[] = [];
  const safeguards: AuthoritySafeguard[] = [];
  const artifactFlow: AuthorityArtifactFlow[] = [];

  for (const source of sources) {
    const projection = projectWorkflow(source);
    triggers.push(...projection.triggers);
    permissions.push(...projection.permissions);
    environments.push(...projection.environments);
    actions.push(...projection.actions);
    publishSteps.push(...projection.publishSteps);
    safeguards.push(...projection.safeguards);
    artifactFlow.push(...projection.artifactFlow);
    if (!source.documentComplete) {
      unresolved.push({ path: source.path, reason: "partially_parsed" });
    }
    workflows.push({
      path: source.path,
      repositoryFullName: source.repositoryFullName,
      sha: source.sha,
      ref: source.ref,
      role: source.role,
      rawDigest: await sha256Hex(source.content),
      authorityDigest: await sha256Hex(stableJson(projection)),
    });
  }

  return {
    schema: RELEASE_AUTHORITY_SCHEMA,
    run: input.run,
    workflows: workflows.sort(byKey((item) => `${item.role}\u0000${item.path}`)),
    triggers: capped(triggers.sort(byKey((item) => `${item.workflow}\u0000${item.event}`))),
    permissions: capped(
      permissions.sort(
        byKey((item) => `${item.workflow}\u0000${item.job ?? ""}\u0000${item.scope}`),
      ),
    ),
    environments: capped(
      environments.sort(byKey((item) => `${item.workflow}\u0000${item.job}\u0000${item.name}`)),
    ),
    actions: capped(
      actions.sort(byKey((item) => `${item.workflow}\u0000${item.job}\u0000${item.uses}`)),
    ),
    publishSteps: capped(
      publishSteps.sort(byKey((item) => `${item.workflow}\u0000${item.job}\u0000${item.detail}`)),
    ),
    safeguards: capped(
      safeguards.sort(byKey((item) => `${item.workflow}\u0000${item.job}\u0000${item.detail}`)),
    ),
    artifactFlow: capped(
      artifactFlow.sort(
        byKey(
          (item) => `${item.workflow}\u0000${item.job}\u0000${item.direction}\u0000${item.name}`,
        ),
      ),
    ),
    artifacts: capped(
      input.artifacts
        .map((artifact) => ({
          name: artifact.name,
          kind: artifact.kind,
          sha256: artifact.sha256.toLowerCase(),
        }))
        .sort(byKey((item) => `${item.name}\u0000${item.sha256}`)),
    ),
    coverage: {
      complete: unresolved.length === 0,
      unresolved: unresolved.slice(0, MAX_UNRESOLVED),
    },
  };
}

/**
 * The binding between an approval and the exact bytes it accepted: a digest
 * over the reviewed artifacts' own digests, sorted so it does not depend on
 * discovery order. Stored alongside the approval so an accepted authority
 * snapshot can be shown to belong to one specific release rather than to a run
 * id that could be re-run with different content.
 *
 * Returns null when any reviewed artifact is missing a digest — an incomplete
 * binding must be absent rather than look authoritative.
 */
export async function computeArtifactBindingDigest(
  artifacts: AuthorityArtifact[],
): Promise<string | null> {
  if (artifacts.length === 0) return null;
  if (artifacts.some((artifact) => !artifact.sha256)) return null;
  const canonical = artifacts
    .map((artifact) => `${artifact.kind}:${artifact.sha256.toLowerCase()}`)
    .sort()
    .join("\n");
  return sha256Hex(canonical);
}

// ── Per-workflow projection ──────────────────────────────────────────────────

interface WorkflowProjection {
  triggers: AuthorityTrigger[];
  permissions: AuthorityPermission[];
  environments: AuthorityEnvironment[];
  actions: AuthorityActionRef[];
  publishSteps: AuthorityPublishStep[];
  safeguards: AuthoritySafeguard[];
  artifactFlow: AuthorityArtifactFlow[];
}

function projectWorkflow(source: WorkflowSource): WorkflowProjection {
  const projection: WorkflowProjection = {
    triggers: [],
    permissions: [],
    environments: [],
    actions: [],
    publishSteps: [],
    safeguards: [],
    artifactFlow: [],
  };
  const doc = asRecord(source.document);
  if (!doc) return projection;
  const workflow = source.path;

  projection.triggers.push(...readTriggers(workflow, doc.on));
  projection.permissions.push(...readPermissions(workflow, null, doc.permissions));

  const jobs = asRecord(doc.jobs);
  if (!jobs) return projection;
  for (const [jobName, rawJob] of Object.entries(jobs)) {
    const job = asRecord(rawJob);
    if (!job) continue;

    projection.permissions.push(...readPermissions(workflow, jobName, job.permissions));
    const environment = readEnvironmentName(job.environment);
    if (environment) projection.environments.push({ workflow, job: jobName, name: environment });

    // A job-level `uses:` is a reusable-workflow call: the job's whole body is
    // delegated to another definition, so the reference and whether it inherits
    // secrets are authority, not implementation detail.
    const jobUses = asString(job.uses);
    if (jobUses) {
      projection.actions.push(readActionRef(workflow, jobName, jobUses, job.secrets));
    }

    const steps = Array.isArray(job.steps) ? job.steps : [];
    for (const rawStep of steps) {
      const step = asRecord(rawStep);
      if (!step) continue;
      readStep(projection, workflow, jobName, step);
    }
  }

  return projection;
}

function readStep(
  projection: WorkflowProjection,
  workflow: string,
  job: string,
  step: { [key: string]: YamlValue },
): void {
  const uses = asString(step.uses);
  const run = asString(step.run);
  const inputs = asRecord(step.with);

  if (uses) {
    projection.actions.push(readActionRef(workflow, job, uses, step.secrets));
    const actionName = actionIdentity(uses);
    if (isPublishAction(actionName)) {
      projection.publishSteps.push({ workflow, job, kind: "action", detail: truncate(uses) });
    }
    const safeguard = safeguardForAction(actionName);
    if (safeguard) {
      projection.safeguards.push({ workflow, job, kind: safeguard, detail: truncate(uses) });
    }
    const flow = artifactFlowForAction(actionName, inputs);
    if (flow) projection.artifactFlow.push({ workflow, job, ...flow });
  }

  // Safeguards can also be step inputs rather than separate steps: PyPI
  // publishing takes `attestations`, npm takes `provenance`. Losing either is
  // the same class of change as deleting an attestation step.
  for (const [key, value] of Object.entries(inputs ?? {})) {
    const normalizedKey = key.toLowerCase();
    const enabled = asString(value);
    if (normalizedKey === "attestations" && enabled !== "false") {
      projection.safeguards.push({
        workflow,
        job,
        kind: "attestation",
        detail: truncate(`with.attestations=${enabled ?? "true"}`),
      });
    }
    if (normalizedKey === "provenance" && enabled !== "false") {
      projection.safeguards.push({
        workflow,
        job,
        kind: "provenance",
        detail: truncate(`with.provenance=${enabled ?? "true"}`),
      });
    }
  }

  if (run) {
    for (const command of publishCommands(run)) {
      projection.publishSteps.push({ workflow, job, kind: "run", detail: truncate(command) });
    }
    for (const safeguard of safeguardCommands(run)) {
      projection.safeguards.push({ workflow, job, ...safeguard });
    }
  }
}

// ── Field readers ────────────────────────────────────────────────────────────

const TRIGGER_FILTER_KEYS = [
  "branches",
  "branches-ignore",
  "paths",
  "paths-ignore",
  "tags",
  "tags-ignore",
  "types",
];

function readTriggers(workflow: string, value: YamlValue): AuthorityTrigger[] {
  if (typeof value === "string") return [{ workflow, event: value, filter: "" }];
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string")
      .map((event) => ({ workflow, event, filter: "" }));
  }
  const record = asRecord(value);
  if (!record) return [];
  return Object.entries(record).map(([event, config]) => ({
    workflow,
    event,
    filter: normalizeTriggerFilter(config),
  }));
}

function normalizeTriggerFilter(config: YamlValue): string {
  const record = asRecord(config);
  if (!record) return "";
  const parts: string[] = [];
  for (const key of TRIGGER_FILTER_KEYS) {
    const values = asStringList(record[key]);
    if (values.length === 0) continue;
    parts.push(`${key}=[${[...values].sort().join(",")}]`);
  }
  return truncate(parts.join(";"));
}

function readPermissions(
  workflow: string,
  job: string | null,
  value: YamlValue,
): AuthorityPermission[] {
  // `read-all` / `write-all` set every scope at once; an empty mapping drops
  // them all. Both are recorded against the `*` scope so the delta can compare
  // a shorthand against an explicit block without special cases.
  if (typeof value === "string") {
    const shorthand = value.trim().toLowerCase();
    if (shorthand === "read-all") return [{ workflow, job, scope: "*", level: "read" }];
    if (shorthand === "write-all") return [{ workflow, job, scope: "*", level: "write" }];
    return [{ workflow, job, scope: "*", level: "unknown" }];
  }
  const record = asRecord(value);
  if (!record) return [];
  const entries = Object.entries(record);
  if (entries.length === 0) return [{ workflow, job, scope: "*", level: "none" }];
  return entries.map(([scope, level]) => ({
    workflow,
    job,
    scope: scope.toLowerCase(),
    level: normalizePermissionLevel(asString(level)),
  }));
}

function normalizePermissionLevel(value: string | null): PermissionLevel {
  const level = value?.trim().toLowerCase();
  if (level === "read" || level === "write" || level === "none") return level;
  return "unknown";
}

function readEnvironmentName(value: YamlValue): string | null {
  if (typeof value === "string") return value.trim() || null;
  const record = asRecord(value);
  const name = record ? asString(record.name) : null;
  return name?.trim() || null;
}

function readActionRef(
  workflow: string,
  job: string,
  uses: string,
  secrets: YamlValue,
): AuthorityActionRef {
  const trimmed = uses.trim();
  const local = trimmed.startsWith("./") || trimmed.startsWith("../");
  const separator = trimmed.lastIndexOf("@");
  const ref = !local && separator > 0 ? trimmed.slice(separator + 1) : null;
  return {
    workflow,
    job,
    uses: truncate(trimmed),
    ref,
    // A local path rides the same commit as the caller, so it moves only when
    // the caller's commit does. Everything else is pinned only by a full sha.
    pinned: local || isCommitSha(ref),
    secretsInherit: asString(secrets)?.trim().toLowerCase() === "inherit",
  };
}

function isCommitSha(ref: string | null): boolean {
  return typeof ref === "string" && /^[0-9a-f]{40}$/i.test(ref);
}

/** `owner/name` for a marketplace action, lowercased; local paths keep their path. */
function actionIdentity(uses: string): string {
  const trimmed = uses.trim().toLowerCase();
  const withoutRef = trimmed.includes("@") ? trimmed.slice(0, trimmed.lastIndexOf("@")) : trimmed;
  const segments = withoutRef.split("/");
  if (withoutRef.startsWith("./") || withoutRef.startsWith("../")) return withoutRef;
  return segments.length > 2 ? segments.slice(0, 2).join("/") : withoutRef;
}

// ── Publish-path and safeguard detection ─────────────────────────────────────

// Actions whose whole purpose is to push a release to a registry. Kept as an
// explicit list: a substring match on "publish" would sweep in unrelated
// actions and turn every release into a review.
const PUBLISH_ACTIONS = new Set([
  "pypa/gh-action-pypi-publish",
  "js-devtools/npm-publish",
  "jsdevtools/npm-publish",
  "changesets/action",
  "haaleo/publish-vscode-extension",
  "katex/publish-crates",
  "rust-lang/crates-io-auth-action",
]);

const PUBLISH_COMMAND_PATTERNS: RegExp[] = [
  /\b(?:npm|pnpm|yarn|bun)\s+publish\b/,
  /\btwine\s+upload\b/,
  /\b(?:uv|poetry|flit|hatch|maturin)\s+publish\b/,
  /\bcargo\s+publish\b/,
  /\b(?:vsce|ovsx)\s+publish\b/,
  /\bgem\s+push\b/,
];

const SAFEGUARD_ACTIONS = new Map<string, AuthoritySafeguard["kind"]>([
  ["actions/attest-build-provenance", "attestation"],
  ["actions/attest", "attestation"],
  ["sigstore/gh-action-sigstore-python", "signing"],
  ["sigstore/cosign-installer", "signing"],
  ["slsa-framework/slsa-github-generator", "provenance"],
]);

const SAFEGUARD_COMMAND_PATTERNS: Array<{ pattern: RegExp; kind: AuthoritySafeguard["kind"] }> = [
  { pattern: /--provenance\b/, kind: "provenance" },
  { pattern: /\bcosign\s+sign\b/, kind: "signing" },
  { pattern: /\bgpg\s+--detach-sig/, kind: "signing" },
  { pattern: /\bpython\s+-m\s+sigstore\b/, kind: "signing" },
  { pattern: /\bgh\s+attestation\s+verify\b/, kind: "attestation" },
];

function isPublishAction(actionName: string): boolean {
  return PUBLISH_ACTIONS.has(actionName);
}

function safeguardForAction(actionName: string): AuthoritySafeguard["kind"] | null {
  return SAFEGUARD_ACTIONS.get(actionName) ?? null;
}

function publishCommands(run: string): string[] {
  const found: string[] = [];
  for (const line of run.split("\n")) {
    const command = line.trim();
    if (!command || command.startsWith("#")) continue;
    if (PUBLISH_COMMAND_PATTERNS.some((pattern) => pattern.test(command))) found.push(command);
  }
  return found;
}

function safeguardCommands(
  run: string,
): Array<{ kind: AuthoritySafeguard["kind"]; detail: string }> {
  const found: Array<{ kind: AuthoritySafeguard["kind"]; detail: string }> = [];
  for (const line of run.split("\n")) {
    const command = line.trim();
    if (!command || command.startsWith("#")) continue;
    for (const { pattern, kind } of SAFEGUARD_COMMAND_PATTERNS) {
      if (pattern.test(command)) found.push({ kind, detail: truncate(command) });
    }
  }
  return found;
}

function artifactFlowForAction(
  actionName: string,
  inputs: { [key: string]: YamlValue } | null,
): Omit<AuthorityArtifactFlow, "workflow" | "job"> | null {
  const direction =
    actionName === "actions/upload-artifact"
      ? "upload"
      : actionName === "actions/download-artifact"
        ? "download"
        : null;
  if (!direction) return null;
  return {
    direction,
    name: truncate(asString(inputs?.name ?? null) ?? ""),
    path: truncate(asString(inputs?.path ?? null) ?? ""),
  };
}

// ── Shared helpers ───────────────────────────────────────────────────────────

function truncate(value: string): string {
  return value.length > MAX_DETAIL_LENGTH ? value.slice(0, MAX_DETAIL_LENGTH) : value;
}

function capped<T>(items: T[]): T[] {
  return items.length > MAX_ENTRIES_PER_LIST ? items.slice(0, MAX_ENTRIES_PER_LIST) : items;
}

function byKey<T>(key: (item: T) => string): (a: T, b: T) => number {
  return (a, b) => {
    const left = key(a);
    const right = key(b);
    return left < right ? -1 : left > right ? 1 : 0;
  };
}
