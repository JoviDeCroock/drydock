// Release-authority snapshot: the canonical, bounded projection of *what was
// authorized to publish this release*. See `docs/release-authority.md` for the
// model and the role of the raw/authority/execution digests.
//
// Workflow definitions are repository content and are treated as hostile
// evidence: read and projected, never evaluated.

import { sha256Hex } from "../platform/crypto-utils";
import { stableJson, utf8Size } from "../platform/stable-json";
import { type YamlValue, asRecord, asString, asStringList } from "./yaml";

export const RELEASE_AUTHORITY_SCHEMA = "drydock.release-authority.v1";

// Bounds on the persisted blob. A release that exceeds one of these records the
// truncation in `coverage` instead of silently reporting a shorter graph.
const MAX_WORKFLOWS = 32;
const MAX_ENTRIES_PER_LIST = 256;
const MAX_DETAIL_LENGTH = 300;
const MAX_IDENTITY_LENGTH = 4_096;
const MAX_UNRESOLVED = 32;
// D1 caps a text value at 2 MB. Keep the snapshot much smaller so the delta,
// indexes, and other row fields retain ample headroom in the same record.
export const MAX_PERSISTED_SNAPSHOT_BYTES = 256 * 1024;

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
  /** sha256 of this workflow's complete semantic evidence; stable across cosmetic edits. */
  authorityDigest: string | null;
  /** sha256 of conditions, dependencies, env mappings, commands, action ordering, and controls. */
  executionDigest: string | null;
  /** Bounded job identities used to distinguish a removed block from a removed job. */
  jobs: string[] | null;
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
  /** True when the reference cannot move: a 40-hex sha or a commit-bound local path. */
  pinned: boolean;
  /** `secrets: inherit` on a reusable-workflow call hands over the caller's secrets. */
  secretsInherit: boolean;
  /**
   * Digest of call configuration. Present whenever a `with:` input or explicit
   * `secrets:` mapping exists because any action can alter the eventual release
   * authority without moving its reference. The values themselves are never
   * persisted.
   */
  configurationDigest: string | null;
}

export interface AuthorityPublishStep {
  workflow: string;
  job: string;
  kind: "action" | "run";
  /**
   * The publish action reference, or a safe command category plus a digest of
   * the matched command. Raw `run:` text is never persisted because workflow
   * definitions can contain literal credentials.
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
  /**
   * Bounded digests of commit-bound local-action dependency closures referenced
   * by this workflow, keyed by the trimmed `uses: $/...` value. The
   * control-plane fetcher builds these from Git tree identities at the
   * workflow's resolved commit and recursively includes nested self actions.
   * Workspace-relative `./...` actions remain unresolved evidence.
   */
  localActionDigests?: Readonly<Record<string, string>>;
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

  const workflowPathCounts = countWorkflowPaths(sources);
  const workflowPathOccurrences = new Map<string, number>();
  for (const source of sources) {
    const projection = await projectWorkflow(source, unresolved);
    // Hash the complete parsed document, not the categorized display
    // projection. GitHub can add a valid authority-sensitive field before this
    // module learns how to explain it; default-inclusive semantic evidence
    // makes that an unclassified authority change instead of a cosmetic edit.
    // Local actions add commit-bound evidence that is not present in the YAML.
    const semanticEvidence = {
      document: canonicalizeWorkflowAuthorityDocument(source.document),
      localActionDigests: source.localActionDigests ?? {},
    };
    const unclassifiedEvidence = projectUnclassifiedWorkflowSemantics(source.document);
    const occurrence = workflowPathOccurrences.get(source.path) ?? 0;
    workflowPathOccurrences.set(source.path, occurrence + 1);
    const projectionWorkflow = authorityWorkflowProjectionKey(
      source,
      (workflowPathCounts.get(source.path) ?? 0) > 1,
      occurrence,
    );
    const persistedProjection = boundProjectionDetails(
      renameProjectionWorkflow(projection, projectionWorkflow),
    );
    triggers.push(...persistedProjection.triggers);
    permissions.push(...persistedProjection.permissions);
    environments.push(...persistedProjection.environments);
    actions.push(...persistedProjection.actions);
    publishSteps.push(...persistedProjection.publishSteps);
    safeguards.push(...persistedProjection.safeguards);
    artifactFlow.push(...persistedProjection.artifactFlow);
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
      authorityDigest: await sha256Hex(stableJson(semanticEvidence)),
      executionDigest: await sha256Hex(
        stableJson(
          // Keep the original v1 digest stable for workflows whose semantics
          // are fully represented by the typed projections.
          unclassifiedEvidence === null
            ? projection.executionContext
            : { executionContext: projection.executionContext, unclassifiedEvidence },
        ),
      ),
      jobs: boundedJobNames(projection.jobs, source.path, unresolved),
    });
  }

  const snapshot: ReleaseAuthoritySnapshot = {
    schema: RELEASE_AUTHORITY_SCHEMA,
    run: boundRun(input.run),
    workflows: workflows
      .map(boundWorkflowRef)
      .sort(byKey((item) => `${item.role}\u0000${item.path}`)),
    triggers: cappedWithCoverage(
      triggers.sort(byKey((item) => `${item.workflow}\u0000${item.event}`)),
      "triggers",
      unresolved,
    ),
    permissions: cappedWithCoverage(
      permissions.sort(
        byKey((item) => `${item.workflow}\u0000${item.job ?? ""}\u0000${item.scope}`),
      ),
      "permissions",
      unresolved,
    ),
    environments: cappedWithCoverage(
      environments.sort(byKey((item) => `${item.workflow}\u0000${item.job}\u0000${item.name}`)),
      "environments",
      unresolved,
    ),
    actions: cappedWithCoverage(
      // Keep source order among calls to the same action identity. Their refs
      // and configurations still participate in equality, so reordering two
      // distinct invocations remains visible to compareActions.
      actions.sort(
        byKey(
          (item) => `${item.workflow}\u0000${item.job}\u0000${actionReferenceIdentity(item.uses)}`,
        ),
      ),
      "actions",
      unresolved,
    ),
    publishSteps: cappedWithCoverage(
      publishSteps.sort(byKey((item) => `${item.workflow}\u0000${item.job}\u0000${item.detail}`)),
      "publish steps",
      unresolved,
    ),
    safeguards: cappedWithCoverage(
      safeguards.sort(byKey((item) => `${item.workflow}\u0000${item.job}\u0000${item.detail}`)),
      "safeguards",
      unresolved,
    ),
    artifactFlow: cappedWithCoverage(
      artifactFlow.sort(
        byKey(
          (item) => `${item.workflow}\u0000${item.job}\u0000${item.direction}\u0000${item.name}`,
        ),
      ),
      "artifact flow entries",
      unresolved,
    ),
    artifacts: cappedWithCoverage(
      input.artifacts
        .map((artifact) => ({
          name: artifact.name,
          kind: artifact.kind,
          sha256: artifact.sha256.toLowerCase(),
        }))
        .sort(byKey((item) => `${item.name}\u0000${item.sha256}`)),
      "artifacts",
      unresolved,
    ),
    coverage: {
      complete: unresolved.length === 0,
      unresolved: unresolved.slice(0, MAX_UNRESOLVED).map(boundUnresolved),
    },
  };
  return boundSnapshotBytes(snapshot);
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

/**
 * Canonical workflow semantics for the fail-closed authority fingerprint.
 *
 * Mapping order, comments, quoting, and formatting have already disappeared in
 * the parsed document. Preserve every remaining value by default, including
 * fields this release does not yet categorize. Only fields GitHub documents as
 * presentation-only are removed. Equivalent same-repository reusable-workflow
 * syntax and redundant job permission blocks are normalized as well.
 */
function canonicalizeWorkflowAuthorityDocument(document: YamlValue): YamlValue {
  const canonical = canonicalizeWorkflowAuthorityValue(document, []);
  const root = asRecord(canonical);
  const jobs = root ? asRecord(root.jobs) : null;
  if (!root || !jobs || root.permissions == null) return canonical;

  const workflowPermissions = stableJson(root.permissions);
  for (const rawJob of Object.values(jobs)) {
    const job = asRecord(rawJob);
    if (job?.permissions != null && stableJson(job.permissions) === workflowPermissions) {
      // An identical job block has the same effective authority as inheritance.
      delete job.permissions;
    }
  }
  return canonical;
}

function canonicalizeWorkflowAuthorityValue(value: YamlValue, path: string[]): YamlValue {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeWorkflowAuthorityValue(item, [...path, "*"]));
  }
  if (value === null || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !isWorkflowDisplayOnlyField(path, key))
      .map(([key, item]) => {
        const canonical = canonicalizeWorkflowAuthorityValue(item, [...path, key]);
        return [
          key,
          canonicalizeWorkflowPermissionMap(
            path,
            key,
            canonicalizeReusableWorkflowUses(path, key, canonical),
          ),
        ];
      }),
  );
}

function canonicalizeWorkflowPermissionMap(
  path: string[],
  key: string,
  value: YamlValue,
): YamlValue {
  const isWorkflowPermissions = path.length === 0 && key === "permissions";
  const isJobPermissions = path.length === 2 && path[0] === "jobs" && key === "permissions";
  const permissions = isWorkflowPermissions || isJobPermissions ? asRecord(value) : null;
  if (!permissions) return value;

  // Inside an explicit permissions map GitHub assigns `none` to every omitted
  // scope. Spelling one of those denies out is therefore redundant syntax, and
  // an all-`none` map has the same effective authority as `permissions: {}`.
  return Object.fromEntries(
    Object.entries(permissions).filter(
      ([, level]) => asString(level)?.trim().toLowerCase() !== "none",
    ),
  );
}

function isWorkflowDisplayOnlyField(path: string[], key: string): boolean {
  if (path.length === 0) return key === "name" || key === "run-name";
  if (path.length === 2 && path[0] === "jobs") return key === "name";
  if (path.length === 4 && path[0] === "jobs" && path[2] === "steps" && path[3] === "*") {
    return key === "name";
  }
  if (
    path.length === 4 &&
    path[0] === "on" &&
    (path[1] === "workflow_dispatch" || path[1] === "workflow_call") &&
    (path[2] === "inputs" || path[2] === "secrets" || path[2] === "outputs")
  ) {
    return key === "description";
  }
  return false;
}

function canonicalizeReusableWorkflowUses(
  path: string[],
  key: string,
  value: YamlValue,
): YamlValue {
  if (
    path.length === 2 &&
    path[0] === "jobs" &&
    key === "uses" &&
    typeof value === "string" &&
    value.startsWith("$/")
  ) {
    return `.${value.slice(1)}`;
  }
  return value;
}

// ── Per-workflow projection ──────────────────────────────────────────────────

/**
 * Preserve parsed semantics that the typed delta does not already explain.
 *
 * `authorityDigest` proves that the whole workflow changed, while the typed
 * projections explain known trigger, permission, environment, and action
 * changes. This residual projection removes only values those categories fully
 * represent. Hashing it with the execution context means a future GitHub
 * control remains visible even when the same edit also changes a known field.
 */
function projectUnclassifiedWorkflowSemantics(document: YamlValue): YamlValue {
  const canonical = canonicalizeWorkflowAuthorityDocument(document);
  const root = asRecord(canonical);
  if (!root) return canonical;

  const residual = { ...root };
  retainUnclassifiedWorkflowField(residual, "on", unclassifiedTriggerEvidence(residual.on));
  retainUnclassifiedWorkflowField(
    residual,
    "permissions",
    unclassifiedPermissionEvidence(residual.permissions),
  );
  removeProjectedExecutionFields(residual, ["env", "concurrency"]);
  retainUnclassifiedWorkflowField(
    residual,
    "defaults",
    unclassifiedDefaultsEvidence(residual.defaults),
  );

  const jobs = asRecord(residual.jobs);
  if (!jobs) return residual;
  const jobRemainders: { [key: string]: YamlValue } = {};
  for (const [jobName, rawJob] of Object.entries(jobs)) {
    const job = asRecord(rawJob);
    if (!job) {
      jobRemainders[jobName] = rawJob;
      continue;
    }
    const jobResidual = { ...job };
    retainUnclassifiedWorkflowField(
      jobResidual,
      "permissions",
      unclassifiedPermissionEvidence(jobResidual.permissions),
    );
    retainUnclassifiedWorkflowField(
      jobResidual,
      "environment",
      unclassifiedEnvironmentEvidence(jobResidual.environment),
    );
    removeProjectedExecutionFields(jobResidual, [
      "if",
      "needs",
      "env",
      "concurrency",
      "strategy",
      "continue-on-error",
      "runs-on",
      "container",
      "services",
      "outputs",
    ]);
    retainUnclassifiedWorkflowField(
      jobResidual,
      "defaults",
      unclassifiedDefaultsEvidence(jobResidual.defaults),
    );
    removeCategorizedActionCall(jobResidual);

    const steps = Array.isArray(jobResidual.steps) ? jobResidual.steps : null;
    if (steps) {
      const stepRemainders: { [key: string]: YamlValue } = {};
      for (const [stepIndex, rawStep] of steps.entries()) {
        const step = asRecord(rawStep);
        if (!step) {
          stepRemainders[String(stepIndex)] = rawStep;
          continue;
        }
        const stepResidual = { ...step };
        removeCategorizedActionCall(stepResidual);
        removeProjectedExecutionFields(stepResidual, [
          "if",
          "env",
          "background",
          "cancel",
          "id",
          "continue-on-error",
          "parallel",
          "run",
          "shell",
          "timeout-minutes",
          "wait",
          "wait-all",
          "working-directory",
        ]);
        if (Object.keys(stepResidual).length > 0 || Object.keys(step).length === 0) {
          stepRemainders[String(stepIndex)] = stepResidual;
        }
      }
      retainUnclassifiedWorkflowField(
        jobResidual,
        "steps",
        Object.keys(stepRemainders).length > 0 ? stepRemainders : null,
      );
    }
    if (Object.keys(jobResidual).length > 0 || Object.keys(job).length === 0) {
      jobRemainders[jobName] = jobResidual;
    }
  }
  retainUnclassifiedWorkflowField(
    residual,
    "jobs",
    Object.keys(jobRemainders).length > 0 ? jobRemainders : null,
  );
  return Object.keys(residual).length > 0 || Object.keys(root).length === 0 ? residual : null;
}

function unclassifiedTriggerEvidence(value: YamlValue): YamlValue {
  if (typeof value === "string") return null;
  if (Array.isArray(value)) {
    const remainder = value.filter((item) => typeof item !== "string");
    return remainder.length > 0 ? remainder : null;
  }
  const events = asRecord(value);
  if (!events) return value;

  const remainder: { [key: string]: YamlValue } = {};
  for (const [event, rawConfig] of Object.entries(events)) {
    if (event === "schedule") {
      const schedule = unclassifiedScheduleEvidence(rawConfig);
      if (schedule !== null) remainder[event] = schedule;
      continue;
    }
    const config = asRecord(rawConfig);
    if (!config) {
      if (rawConfig !== null) remainder[event] = rawConfig;
      continue;
    }
    const configRemainder = { ...config };
    for (const key of TRIGGER_FILTER_KEYS) {
      retainUnclassifiedWorkflowField(
        configRemainder,
        key,
        unclassifiedStringListEvidence(configRemainder[key]),
      );
    }
    if (event === "workflow_dispatch" || event === "workflow_call") {
      retainUnclassifiedWorkflowField(
        configRemainder,
        "inputs",
        unclassifiedNamedTriggerEvidence(configRemainder.inputs, [
          "default",
          "required",
          "type",
          "options",
        ]),
      );
    }
    if (event === "workflow_call") {
      retainUnclassifiedWorkflowField(
        configRemainder,
        "secrets",
        unclassifiedNamedTriggerEvidence(configRemainder.secrets, ["required"]),
      );
      retainUnclassifiedWorkflowField(
        configRemainder,
        "outputs",
        unclassifiedNamedTriggerEvidence(configRemainder.outputs, ["value"]),
      );
    }
    if (Object.keys(configRemainder).length > 0) remainder[event] = configRemainder;
  }
  return Object.keys(remainder).length > 0 ? remainder : null;
}

function unclassifiedScheduleEvidence(value: YamlValue): YamlValue {
  if (!Array.isArray(value)) return value;
  const remainder: YamlValue[] = [];
  for (const rawSchedule of value) {
    const schedule = asRecord(rawSchedule);
    const cron = schedule && asString(schedule.cron)?.trim();
    if (!schedule || !cron) {
      remainder.push(rawSchedule);
      continue;
    }
    const item = { ...schedule };
    delete item.cron;
    if (asString(item.timezone)?.trim()) delete item.timezone;
    if (Object.keys(item).length > 0) remainder.push(item);
  }
  return remainder.length > 0 ? remainder : null;
}

function unclassifiedNamedTriggerEvidence(value: YamlValue, knownKeys: string[]): YamlValue {
  const definitions = asRecord(value);
  if (!definitions) return value;
  const remainder: { [key: string]: YamlValue } = {};
  for (const [name, rawDefinition] of Object.entries(definitions)) {
    const definition = asRecord(rawDefinition);
    if (!definition) {
      remainder[name] = rawDefinition;
      continue;
    }
    const fields = { ...definition };
    for (const key of knownKeys) {
      if (fields[key] !== null && fields[key] !== undefined) delete fields[key];
    }
    if (Object.keys(fields).length > 0) remainder[name] = fields;
  }
  return Object.keys(remainder).length > 0 ? remainder : null;
}

function unclassifiedStringListEvidence(value: YamlValue): YamlValue {
  if (typeof value === "string") return null;
  if (!Array.isArray(value)) return value;
  const remainder = value.filter((item) => typeof item !== "string");
  return remainder.length > 0 ? remainder : null;
}

function unclassifiedPermissionEvidence(value: YamlValue): YamlValue {
  if (typeof value === "string") {
    const shorthand = value.trim().toLowerCase();
    return shorthand === "read-all" || shorthand === "write-all" ? null : value;
  }
  const permissions = asRecord(value);
  if (!permissions) return value;
  const remainder = Object.fromEntries(
    Object.entries(permissions).filter(([, rawLevel]) => {
      const level = asString(rawLevel)?.trim().toLowerCase();
      return level !== "read" && level !== "write" && level !== "none";
    }),
  );
  return Object.keys(remainder).length > 0 ? remainder : null;
}

function unclassifiedEnvironmentEvidence(value: YamlValue): YamlValue {
  if (typeof value === "string") return value.trim() ? null : value;
  const environment = asRecord(value);
  if (!environment) return value;
  const remainder = { ...environment };
  if (asString(remainder.name)?.trim()) delete remainder.name;
  return Object.keys(remainder).length > 0 ? remainder : null;
}

function removeCategorizedActionCall(value: { [key: string]: YamlValue }): void {
  if (!asString(value.uses)) return;
  delete value.uses;
  if (asRecord(value.with)) delete value.with;
  const secrets = value.secrets;
  if (asRecord(secrets) || asString(secrets)?.trim().toLowerCase() === "inherit") {
    delete value.secrets;
  }
}

function unclassifiedDefaultsEvidence(value: YamlValue): YamlValue {
  const defaults = asRecord(value);
  if (!defaults) return value;
  const remainder = { ...defaults };
  delete remainder.run;
  return Object.keys(remainder).length > 0 ? remainder : null;
}

function removeProjectedExecutionFields(
  record: { [key: string]: YamlValue },
  fields: string[],
): void {
  for (const field of fields) delete record[field];
}

function retainUnclassifiedWorkflowField(
  record: { [key: string]: YamlValue },
  key: string,
  remainder: YamlValue | undefined,
): void {
  if (remainder == null) delete record[key];
  else record[key] = remainder;
}

interface WorkflowProjection {
  jobs: string[];
  triggers: AuthorityTrigger[];
  permissions: AuthorityPermission[];
  environments: AuthorityEnvironment[];
  executionContext: AuthorityExecutionContext[];
  actions: AuthorityActionRef[];
  publishSteps: AuthorityPublishStep[];
  safeguards: AuthoritySafeguard[];
  artifactFlow: AuthorityArtifactFlow[];
}

/**
 * Authority-sensitive execution controls that are hashed but not persisted for
 * display. Conditions and dependencies decide whether a publishing job/step
 * can run, step identifiers connect outputs to later consumers, env mappings,
 * matrices, and preceding commands can redirect an otherwise unchanged
 * publish command, and `continue-on-error` can make a failed safeguard
 * non-blocking. Hashing the values catches those edits without exposing them in
 * the stored snapshot.
 */
interface AuthorityExecutionContext {
  workflow: string;
  /** Null for workflow-level environment mappings. */
  job: string | null;
  step: number | null;
  condition: string | null;
  needs: string[];
  envDigest: string | null;
  controlsDigest: string | null;
}

async function projectWorkflow(
  source: WorkflowSource,
  unresolved: AuthorityUnresolved[],
): Promise<WorkflowProjection> {
  const projection: WorkflowProjection = {
    jobs: [],
    triggers: [],
    permissions: [],
    environments: [],
    executionContext: [],
    actions: [],
    publishSteps: [],
    safeguards: [],
    artifactFlow: [],
  };
  const doc = asRecord(source.document);
  if (!doc) return projection;
  const workflow = source.path;

  projection.triggers.push(...(await readTriggers(workflow, doc.on)));
  const workflowPermissions = readPermissions(workflow, null, doc.permissions);
  projection.permissions.push(...workflowPermissions);
  const workflowExecutionContext = await readExecutionContext(
    workflow,
    null,
    null,
    null,
    null,
    doc.env,
    {
      concurrency: doc.concurrency,
      runDefaults: asRecord(doc.defaults)?.run,
    },
  );
  if (workflowExecutionContext) projection.executionContext.push(workflowExecutionContext);

  const jobs = asRecord(doc.jobs);
  if (!jobs) return projection;
  for (const [jobName, rawJob] of Object.entries(jobs)) {
    const job = asRecord(rawJob);
    if (!job) continue;
    projection.jobs.push(jobName);

    const jobPermissions = readPermissions(workflow, jobName, job.permissions);
    projection.permissions.push(...jobPermissions);
    if (
      source.role === "entry" &&
      workflowPermissions.length === 0 &&
      jobPermissions.length === 0
    ) {
      // GitHub fills an omitted permissions block from mutable repository or
      // organization settings. The run payload does not carry an immutable
      // copy of that effective default, so treating two identical workflow
      // files as equal could hide a read -> write widening between releases.
      // Called workflows inherit the caller's token ceiling, so the entry
      // workflow is the boundary where this external default enters the graph.
      unresolved.push({
        path: `${workflow}/${jobName} -> repository default workflow permissions`,
        reason: "not_accessible",
      });
    }
    const environment = readEnvironmentName(job.environment);
    if (environment) projection.environments.push({ workflow, job: jobName, name: environment });
    const jobExecutionContext = await readExecutionContext(
      workflow,
      jobName,
      null,
      job.if,
      job.needs,
      job.env,
      {
        concurrency: job.concurrency,
        strategy: job.strategy,
        continueOnError: job["continue-on-error"],
        runsOn: job["runs-on"],
        container: job.container,
        services: job.services,
        outputs: job.outputs,
        runDefaults: asRecord(job.defaults)?.run,
        timeoutMinutes: job["timeout-minutes"],
      },
    );
    if (jobExecutionContext) projection.executionContext.push(jobExecutionContext);

    // A job-level `uses:` is a reusable-workflow call: the job's whole body is
    // delegated to another definition, so the reference and whether it inherits
    // secrets are authority, not implementation detail.
    const jobUses = asString(job.uses);
    if (jobUses) {
      projection.actions.push(
        await readActionRef(
          workflow,
          jobName,
          jobUses,
          job.secrets,
          job.with,
          null,
          "workflow_commit",
        ),
      );
    }

    const steps = Array.isArray(job.steps) ? job.steps : [];
    for (const [stepIndex, rawStep] of steps.entries()) {
      const step = asRecord(rawStep);
      if (!step) continue;
      const stepUses = asString(step.uses);
      const stepExecutionContext = await readExecutionContext(
        workflow,
        jobName,
        stepIndex,
        step.if,
        null,
        step.env,
        {
          action: stepUses ? actionIdentity(stepUses) : undefined,
          background: step.background,
          cancel: step.cancel,
          id: step.id,
          continueOnError: step["continue-on-error"],
          parallel: step.parallel,
          run: step.run,
          shell: step.shell,
          timeoutMinutes: step["timeout-minutes"],
          wait: step.wait,
          // `wait-all:` is a presence-only control whose parsed YAML value is
          // null, so carry an explicit sentinel into the execution digest.
          waitAll: "wait-all" in step ? "present" : undefined,
          workingDirectory: step["working-directory"],
        },
      );
      if (stepExecutionContext) projection.executionContext.push(stepExecutionContext);
      await readStep(projection, source, workflow, jobName, step);
    }
  }

  projection.executionContext.sort(
    byKey(
      (item) =>
        `${item.workflow}\u0000${item.job ?? ""}\u0000${
          item.job === null ? "workflow" : item.step === null ? "job" : `step:${item.step}`
        }`,
    ),
  );

  return projection;
}

async function readExecutionContext(
  workflow: string,
  job: string | null,
  step: number | null,
  conditionValue: YamlValue,
  needsValue: YamlValue,
  envValue: YamlValue,
  controlValues: {
    action?: YamlValue;
    background?: YamlValue;
    cancel?: YamlValue;
    concurrency?: YamlValue;
    id?: YamlValue;
    parallel?: YamlValue;
    strategy?: YamlValue;
    continueOnError?: YamlValue;
    runsOn?: YamlValue;
    container?: YamlValue;
    services?: YamlValue;
    outputs?: YamlValue;
    runDefaults?: YamlValue;
    run?: YamlValue;
    shell?: YamlValue;
    timeoutMinutes?: YamlValue;
    wait?: YamlValue;
    waitAll?: YamlValue;
    workingDirectory?: YamlValue;
  } = {},
): Promise<AuthorityExecutionContext | null> {
  const condition = asString(conditionValue)?.trim() || null;
  const needs = [...asStringList(needsValue)].sort();
  const env = asRecord(envValue);
  const envDigest = env && Object.keys(env).length > 0 ? await sha256Hex(stableJson(env)) : null;
  const controls: { [key: string]: YamlValue } = {};
  for (const [key, value] of Object.entries(controlValues)) {
    if (value != null) controls[key] = value;
  }
  const controlsDigest =
    Object.keys(controls).length > 0 ? await sha256Hex(stableJson(controls)) : null;
  if (!condition && needs.length === 0 && !envDigest && !controlsDigest) return null;
  return { workflow, job, step, condition, needs, envDigest, controlsDigest };
}

async function readStep(
  projection: WorkflowProjection,
  source: WorkflowSource,
  workflow: string,
  job: string,
  step: { [key: string]: YamlValue },
): Promise<void> {
  const uses = asString(step.uses);
  const run = asString(step.run);
  const inputs = asRecord(step.with);

  if (uses) {
    const actionName = actionIdentity(uses);
    const safeguard = safeguardForAction(actionName);
    projection.actions.push(
      await readActionRef(
        workflow,
        job,
        uses,
        step.secrets,
        step.with,
        source.localActionDigests?.[uses.trim()] ?? null,
        uses.trim().startsWith("$/") ? "workflow_commit" : "workspace",
      ),
    );
    if (isPublishAction(actionName)) {
      projection.publishSteps.push({ workflow, job, kind: "action", detail: uses });
    }
    if (safeguard) {
      projection.safeguards.push({ workflow, job, kind: safeguard, detail: uses });
    }
    const flow = artifactFlowForAction(actionName, inputs);
    if (flow) projection.artifactFlow.push({ workflow, job, ...flow });
  }

  // Some publisher actions expose a safeguard as a boolean input. Only infer
  // semantics for known publishers and explicit literal `true`; expressions
  // and arbitrary values remain covered by the action's input digest without
  // being persisted or presented as enabled safeguards.
  const publisherInputSafeguard = safeguardForPublisherInput(actionIdentity(uses ?? ""), inputs);
  if (publisherInputSafeguard) {
    projection.safeguards.push({ workflow, job, ...publisherInputSafeguard });
  }

  if (run) {
    for (const command of publishCommands(run)) {
      projection.publishSteps.push({
        workflow,
        job,
        kind: "run",
        detail: await commandEvidence(command.label, command.raw),
      });
    }
    for (const safeguard of safeguardCommands(run)) {
      projection.safeguards.push({
        workflow,
        job,
        kind: safeguard.kind,
        detail: await commandEvidence(safeguard.label, safeguard.raw),
      });
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
  "workflows",
];

const ORDER_SENSITIVE_TRIGGER_FILTER_KEYS = new Set(["branches", "paths", "tags"]);

async function readTriggers(workflow: string, value: YamlValue): Promise<AuthorityTrigger[]> {
  if (typeof value === "string") return [{ workflow, event: value, filter: "" }];
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string")
      .map((event) => ({ workflow, event, filter: "" }));
  }
  const record = asRecord(value);
  if (!record) return [];
  return Promise.all(
    Object.entries(record).map(async ([event, config]) => ({
      workflow,
      event,
      filter: await boundTriggerFilterEvidence(await normalizeTriggerFilter(event, config)),
    })),
  );
}

async function boundTriggerFilterEvidence(filter: string): Promise<string> {
  if (filter.length <= MAX_DETAIL_LENGTH) return filter;
  const suffix = ` [sha256:${await sha256Hex(filter)}]`;
  return `${filter.slice(0, MAX_DETAIL_LENGTH - suffix.length)}${suffix}`;
}

async function normalizeTriggerFilter(event: string, config: YamlValue): Promise<string> {
  if (event === "schedule") return normalizeScheduleFilter(config);
  const record = asRecord(config);
  if (!record) return "";
  const parts: string[] = [];
  for (const key of TRIGGER_FILTER_KEYS) {
    const values = asStringList(record[key]);
    if (values.length === 0) continue;
    // Positive and negative branch/tag/path globs are evaluated in order: a
    // later positive can re-include something a preceding `!` excluded. Keep
    // that order when a list contains a negative pattern; lists whose order is
    // semantically irrelevant remain sorted so reformatting stays cosmetic.
    const canonicalValues =
      ORDER_SENSITIVE_TRIGGER_FILTER_KEYS.has(key) && values.some((value) => value.startsWith("!"))
        ? values
        : [...values].sort();
    parts.push(`${key}=[${canonicalValues.join(",")}]`);
  }
  const configuration = triggerInputConfiguration(event, record);
  if (configuration) {
    parts.push(`configuration-sha256=${await sha256Hex(stableJson(configuration))}`);
  }
  return parts.join(";");
}

function normalizeScheduleFilter(config: YamlValue): string {
  if (!Array.isArray(config)) return "";
  const schedules = config
    .map((item) => asRecord(item))
    .map((item) => {
      const cron = item ? asString(item.cron)?.trim() : null;
      if (!cron) return null;
      const timezone = item ? asString(item.timezone)?.trim() : null;
      return timezone ? `${cron} (${timezone})` : cron;
    })
    .filter((schedule): schedule is string => Boolean(schedule));
  return schedules.length > 0 ? `cron=[${[...new Set(schedules)].sort().join(",")}]` : "";
}

function triggerInputConfiguration(
  event: string,
  config: { [key: string]: YamlValue },
): { [key: string]: YamlValue } | null {
  if (event !== "workflow_dispatch" && event !== "workflow_call") return null;
  const projection: { [key: string]: YamlValue } = {};
  const inputs = projectNamedTriggerConfiguration(config.inputs, [
    "default",
    "required",
    "type",
    "options",
  ]);
  if (inputs) projection.inputs = inputs;
  if (event === "workflow_call") {
    const secrets = projectNamedTriggerConfiguration(config.secrets, ["required"]);
    if (secrets) projection.secrets = secrets;
    const outputs = projectNamedTriggerConfiguration(config.outputs, ["value"]);
    if (outputs) projection.outputs = outputs;
  }
  return Object.keys(projection).length > 0 ? projection : null;
}

function projectNamedTriggerConfiguration(
  value: YamlValue,
  authorityKeys: string[],
): { [key: string]: YamlValue } | null {
  const definitions = asRecord(value);
  if (!definitions) return null;
  const projection: { [key: string]: YamlValue } = {};
  for (const [name, rawDefinition] of Object.entries(definitions)) {
    const definition = asRecord(rawDefinition);
    if (!definition) continue;
    const fields: { [key: string]: YamlValue } = {};
    for (const key of authorityKeys) {
      if (definition[key] != null) fields[key] = definition[key];
    }
    // The existence of an accepted input or secret is itself authority even
    // when GitHub supplies every option's default. Descriptions are omitted so
    // editing help text remains cosmetic.
    projection[name] = fields;
  }
  return Object.keys(projection).length > 0 ? projection : null;
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

async function readActionRef(
  workflow: string,
  job: string,
  uses: string,
  secrets: YamlValue,
  inputs: YamlValue,
  localActionDigest: string | null = null,
  localResolution: "workflow_commit" | "workspace" = "workspace",
): Promise<AuthorityActionRef> {
  const trimmed = uses.trim();
  const local = trimmed.startsWith("./") || trimmed.startsWith("../") || trimmed.startsWith("$/");
  const separator = trimmed.lastIndexOf("@");
  const ref = !local && separator > 0 ? trimmed.slice(separator + 1) : null;
  const inputMap = asRecord(inputs);
  const secretMap = asRecord(secrets);
  const hasConfiguration =
    localActionDigest !== null ||
    (inputMap && Object.keys(inputMap).length > 0) ||
    (secretMap && Object.keys(secretMap).length > 0);
  return {
    workflow,
    job,
    uses: trimmed,
    ref,
    // A reusable workflow's local path and a step action using `$/` resolve at
    // the caller's commit. A step action using `./` resolves from
    // `github.workspace`, whose checkout may point at another repository/ref.
    pinned:
      (localResolution === "workflow_commit" &&
        (trimmed.startsWith("./") || trimmed.startsWith("$/"))) ||
      isCommitSha(ref),
    secretsInherit: asString(secrets)?.trim().toLowerCase() === "inherit",
    configurationDigest: hasConfiguration
      ? await sha256Hex(
          stableJson({
            inputs: inputMap ?? {},
            secrets: secretMap ?? {},
            localActionDigest,
          }),
        )
      : null,
  };
}

function isCommitSha(ref: string | null): boolean {
  return typeof ref === "string" && /^[0-9a-f]{40}$/i.test(ref);
}

/** Full action/reusable-workflow identity with only its revision removed. */
export function actionReferenceIdentity(uses: string): string {
  const trimmed = uses.trim();
  const canonical = trimmed.startsWith("$/") ? `.${trimmed.slice(1)}` : trimmed;
  const separator = canonical.lastIndexOf("@");
  return separator > 0 ? canonical.slice(0, separator) : canonical;
}

/** `owner/name` for a marketplace action, lowercased; local paths keep their path. */
function actionIdentity(uses: string): string {
  const trimmed = uses.trim().toLowerCase();
  const canonical = trimmed.startsWith("$/") ? `.${trimmed.slice(1)}` : trimmed;
  const withoutRef = canonical.includes("@")
    ? canonical.slice(0, canonical.lastIndexOf("@"))
    : canonical;
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

const PUBLISH_COMMAND_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bnpm\b[^;&|\n]*\bpublish\b/, label: "npm publish" },
  { pattern: /\bpnpm\b[^;&|\n]*\bpublish\b/, label: "pnpm publish" },
  { pattern: /\byarn\b[^;&|\n]*\bpublish\b/, label: "yarn publish" },
  { pattern: /\bbun\b[^;&|\n]*\bpublish\b/, label: "bun publish" },
  {
    pattern: /\b(?:(?:python(?:3(?:\.\d+)*)?)\s+-m\s+)?twine\s+upload\b/,
    label: "twine upload",
  },
  { pattern: /\buv\s+publish\b/, label: "uv publish" },
  { pattern: /\bpoetry\s+publish\b/, label: "poetry publish" },
  { pattern: /\bflit\s+publish\b/, label: "flit publish" },
  { pattern: /\bhatch\s+publish\b/, label: "hatch publish" },
  { pattern: /\bmaturin\s+publish\b/, label: "maturin publish" },
  { pattern: /\bcargo\s+publish\b/, label: "cargo publish" },
  { pattern: /\b(?:npx\s+)?vsce\s+publish\b/, label: "vsce publish" },
  { pattern: /\b(?:npx\s+)?ovsx\s+publish\b/, label: "ovsx publish" },
  { pattern: /\bgem\s+push\b/, label: "gem push" },
];

const SAFEGUARD_ACTIONS = new Map<string, AuthoritySafeguard["kind"]>([
  ["actions/attest-build-provenance", "attestation"],
  ["actions/attest", "attestation"],
  ["sigstore/gh-action-sigstore-python", "signing"],
  ["sigstore/cosign-installer", "signing"],
  ["slsa-framework/slsa-github-generator", "provenance"],
]);

const PUBLISHER_INPUT_SAFEGUARDS = new Map<
  string,
  { input: string; kind: AuthoritySafeguard["kind"] }
>([
  ["pypa/gh-action-pypi-publish", { input: "attestations", kind: "attestation" }],
  ["js-devtools/npm-publish", { input: "provenance", kind: "provenance" }],
  ["jsdevtools/npm-publish", { input: "provenance", kind: "provenance" }],
]);

const SAFEGUARD_COMMAND_PATTERNS: Array<{
  pattern: RegExp;
  kind: AuthoritySafeguard["kind"];
  label: string;
}> = [
  { pattern: /--provenance\b/, kind: "provenance", label: "provenance flag" },
  { pattern: /\bcosign\s+sign\b/, kind: "signing", label: "cosign sign" },
  { pattern: /\bgpg\s+--detach-sig/, kind: "signing", label: "gpg detached signature" },
  { pattern: /\bpython\s+-m\s+sigstore\b/, kind: "signing", label: "sigstore sign" },
  {
    pattern: /\bgh\s+attestation\s+verify\b/,
    kind: "attestation",
    label: "GitHub attestation verify",
  },
];

function isPublishAction(actionName: string): boolean {
  return PUBLISH_ACTIONS.has(actionName);
}

function safeguardForAction(actionName: string): AuthoritySafeguard["kind"] | null {
  return SAFEGUARD_ACTIONS.get(actionName) ?? null;
}

function safeguardForPublisherInput(
  actionName: string,
  inputs: { [key: string]: YamlValue } | null,
): Pick<AuthoritySafeguard, "kind" | "detail"> | null {
  const safeguard = PUBLISHER_INPUT_SAFEGUARDS.get(actionName);
  if (!safeguard || !inputs) return null;
  const entry = Object.entries(inputs).find(([key]) => key.toLowerCase() === safeguard.input);
  if (!entry || asString(entry[1])?.trim().toLowerCase() !== "true") return null;
  return {
    kind: safeguard.kind,
    detail: `with.${safeguard.input}=true`,
  };
}

function publishCommands(run: string): Array<{ label: string; raw: string }> {
  const found: Array<{ label: string; raw: string }> = [];
  for (const line of shellLogicalLines(run)) {
    const command = line.trim();
    if (!command || command.startsWith("#")) continue;
    for (const { pattern, label } of PUBLISH_COMMAND_PATTERNS) {
      if (pattern.test(command)) found.push({ label, raw: command });
    }
  }
  return found;
}

function safeguardCommands(
  run: string,
): Array<{ kind: AuthoritySafeguard["kind"]; label: string; raw: string }> {
  const found: Array<{ kind: AuthoritySafeguard["kind"]; label: string; raw: string }> = [];
  for (const line of shellLogicalLines(run)) {
    const command = line.trim();
    if (!command || command.startsWith("#")) continue;
    for (const { pattern, kind, label } of SAFEGUARD_COMMAND_PATTERNS) {
      if (pattern.test(command)) found.push({ kind, label, raw: command });
    }
  }
  return found;
}

async function commandEvidence(label: string, command: string): Promise<string> {
  return `${label} [sha256:${await sha256Hex(command)}]`;
}

/** Join shell lines whose final unescaped backslash continues the command. */
function shellLogicalLines(run: string): string[] {
  const logical: string[] = [];
  let current = "";
  for (const physicalLine of run.split("\n")) {
    const combined = current ? `${current}${physicalLine.trimStart()}` : physicalLine;
    const trailingBackslashes = combined.match(/\\+$/)?.[0].length ?? 0;
    if (trailingBackslashes % 2 === 1) {
      current = combined.slice(0, -1);
      continue;
    }
    logical.push(combined);
    current = "";
  }
  if (current) logical.push(current);
  return logical;
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
    name: asString(inputs?.name ?? null) ?? "",
    path: asString(inputs?.path ?? null) ?? "",
  };
}

// ── Shared helpers ───────────────────────────────────────────────────────────

function boundProjectionDetails(projection: WorkflowProjection): WorkflowProjection {
  return {
    jobs: projection.jobs,
    triggers: projection.triggers.map((item) => ({ ...item, filter: truncate(item.filter) })),
    permissions: projection.permissions,
    environments: projection.environments,
    executionContext: projection.executionContext,
    actions: projection.actions.map((item) => ({ ...item, uses: truncate(item.uses) })),
    publishSteps: projection.publishSteps.map((item) => ({
      ...item,
      detail: truncate(item.detail),
    })),
    safeguards: projection.safeguards.map((item) => ({
      ...item,
      detail: truncate(item.detail),
    })),
    artifactFlow: projection.artifactFlow.map((item) => ({
      ...item,
      name: truncate(item.name),
      path: truncate(item.path),
    })),
  };
}

function renameProjectionWorkflow(
  projection: WorkflowProjection,
  workflow: string,
): WorkflowProjection {
  return {
    jobs: projection.jobs,
    triggers: projection.triggers.map((item) => ({ ...item, workflow })),
    permissions: projection.permissions.map((item) => ({ ...item, workflow })),
    environments: projection.environments.map((item) => ({ ...item, workflow })),
    executionContext: projection.executionContext,
    actions: projection.actions.map((item) => ({ ...item, workflow })),
    publishSteps: projection.publishSteps.map((item) => ({ ...item, workflow })),
    safeguards: projection.safeguards.map((item) => ({ ...item, workflow })),
    artifactFlow: projection.artifactFlow.map((item) => ({ ...item, workflow })),
  };
}

function countWorkflowPaths(items: Array<Pick<WorkflowSource, "path">>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.path, (counts.get(item.path) ?? 0) + 1);
  return counts;
}

/**
 * Projection-list identity for one workflow occurrence. Ordinary snapshots
 * keep the readable path; repeated paths add the immutable resolved revision so
 * category comparisons cannot collapse two different reusable-workflow SHAs.
 */
export function authorityWorkflowProjectionKey(
  workflow: Pick<AuthorityWorkflowRef, "path" | "sha" | "ref">,
  repeated: boolean,
  occurrence = 0,
): string {
  if (!repeated) return workflow.path;
  return `${workflow.path}@${workflow.sha ?? workflow.ref ?? `occurrence-${occurrence + 1}`}`;
}

function boundRun(run: ReleaseAuthorityRun): ReleaseAuthorityRun {
  return {
    ...run,
    repositoryFullName: truncate(run.repositoryFullName),
    environment: truncate(run.environment),
    workflowPath: nullableIdentity(run.workflowPath),
    headSha: nullableTruncate(run.headSha),
    ref: nullableTruncate(run.ref),
    event: nullableTruncate(run.event),
    actor: nullableTruncate(run.actor),
    triggeringActor: nullableTruncate(run.triggeringActor),
  };
}

function boundWorkflowRef(workflow: AuthorityWorkflowRef): AuthorityWorkflowRef {
  return {
    ...workflow,
    path: truncateIdentity(workflow.path),
    repositoryFullName: truncate(workflow.repositoryFullName),
    sha: nullableTruncate(workflow.sha),
    ref: nullableTruncate(workflow.ref),
    jobs: workflow.jobs?.map(truncateIdentity) ?? null,
  };
}

function boundUnresolved(unresolved: AuthorityUnresolved): AuthorityUnresolved {
  return { ...unresolved, path: truncate(unresolved.path) };
}

function boundedJobNames(
  jobs: string[],
  workflow: string,
  unresolved: AuthorityUnresolved[],
): string[] | null {
  if (jobs.length <= MAX_ENTRIES_PER_LIST) return [...jobs].sort();
  unresolved.push({
    path: `${workflow} jobs (+${jobs.length - MAX_ENTRIES_PER_LIST} more)`,
    reason: "limit_reached",
  });
  return null;
}

/**
 * Apply a final UTF-8 budget after every full-value digest has been computed.
 * Evidence that does not fit is omitted only alongside explicit incomplete
 * coverage, so persistence can never fail open or imply a complete graph.
 */
function boundSnapshotBytes(snapshot: ReleaseAuthoritySnapshot): ReleaseAuthoritySnapshot {
  if (utf8Size(stableJson(snapshot)) <= MAX_PERSISTED_SNAPSHOT_BYTES) return snapshot;

  const marker: AuthorityUnresolved = {
    path: "release authority snapshot byte budget",
    reason: "limit_reached",
  };
  const unresolved = snapshot.coverage.unresolved.filter(
    (item) => item.path !== marker.path || item.reason !== marker.reason,
  );
  if (unresolved.length >= MAX_UNRESOLVED) unresolved[MAX_UNRESOLVED - 1] = marker;
  else unresolved.push(marker);

  const bounded: ReleaseAuthoritySnapshot = {
    ...snapshot,
    workflows: [],
    triggers: [],
    permissions: [],
    environments: [],
    actions: [],
    publishSteps: [],
    safeguards: [],
    artifactFlow: [],
    artifacts: [],
    coverage: { complete: false, unresolved },
  };
  const remaining = {
    bytes: Math.max(0, MAX_PERSISTED_SNAPSHOT_BYTES - utf8Size(stableJson(bounded))),
  };
  bounded.workflows = fitWithinByteBudget(snapshot.workflows, remaining);
  bounded.artifacts = fitWithinByteBudget(snapshot.artifacts, remaining);
  bounded.triggers = fitWithinByteBudget(snapshot.triggers, remaining);
  bounded.permissions = fitWithinByteBudget(snapshot.permissions, remaining);
  bounded.environments = fitWithinByteBudget(snapshot.environments, remaining);
  bounded.actions = fitWithinByteBudget(snapshot.actions, remaining);
  bounded.publishSteps = fitWithinByteBudget(snapshot.publishSteps, remaining);
  bounded.safeguards = fitWithinByteBudget(snapshot.safeguards, remaining);
  bounded.artifactFlow = fitWithinByteBudget(snapshot.artifactFlow, remaining);
  return bounded;
}

function fitWithinByteBudget<T>(items: T[], remaining: { bytes: number }): T[] {
  const kept: T[] = [];
  for (const item of items) {
    const cost = utf8Size(stableJson(item)) + (kept.length > 0 ? 1 : 0);
    if (cost > remaining.bytes) continue;
    kept.push(item);
    remaining.bytes -= cost;
  }
  return kept;
}

function truncate(value: string): string {
  return value.length > MAX_DETAIL_LENGTH ? value.slice(0, MAX_DETAIL_LENGTH) : value;
}

function truncateIdentity(value: string): string {
  return value.length > MAX_IDENTITY_LENGTH ? value.slice(0, MAX_IDENTITY_LENGTH) : value;
}

function nullableTruncate(value: string | null): string | null {
  return value === null ? null : truncate(value);
}

function nullableIdentity(value: string | null): string | null {
  return value === null ? null : truncateIdentity(value);
}

function cappedWithCoverage<T>(
  items: T[],
  category: string,
  unresolved: AuthorityUnresolved[],
): T[] {
  if (items.length <= MAX_ENTRIES_PER_LIST) return items;
  unresolved.push({
    path: `+${items.length - MAX_ENTRIES_PER_LIST} ${category}`,
    reason: "limit_reached",
  });
  return items.slice(0, MAX_ENTRIES_PER_LIST);
}

function byKey<T>(key: (item: T) => string): (a: T, b: T) => number {
  return (a, b) => {
    const left = key(a);
    const right = key(b);
    return left < right ? -1 : left > right ? 1 : 0;
  };
}
