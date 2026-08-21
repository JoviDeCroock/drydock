// Release-authority snapshot: the canonical, bounded projection of *what was
// authorized to publish this release*, as opposed to what bytes it produced.
//
// Trusted publishing proves identity and run context — this repository, this
// workflow, this environment, this run. It does not prove that the authority
// graph behind that identity is still the one maintainers agreed to. The
// snapshot captures that graph so a later release can be compared against the
// last one a maintainer approved (see `delta.ts`).
//
// Two primary digests per workflow make the comparison honest in both directions:
//   - `rawDigest` changes on any edit at all, including comments and reordering;
//   - `authorityDigest` covers only the projected authority, so a cosmetic edit
//     leaves it untouched.
// A third, narrower `executionDigest` lets the delta attribute changes to
// conditions, dependencies, environment mappings, and execution controls
// without persisting their values.
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
  /** sha256 of conditions, dependencies, env mappings, and execution controls. */
  executionDigest: string | null;
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
  /**
   * Digest of authority-sensitive call configuration. Present for publishing
   * actions, safeguards, and reusable-workflow jobs, where `with:` inputs or
   * an explicit `secrets:` mapping can change the release target, protected
   * subject, or credentials without moving the action reference. The values
   * themselves are never persisted.
   */
  configurationDigest: string | null;
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
  /**
   * Bounded digests of local-action directories referenced by this workflow,
   * keyed by the trimmed `uses: ./...` value. The control-plane fetcher builds
   * these from Git blob/tree identities at the workflow's resolved commit.
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

  for (const source of sources) {
    const projection = await projectWorkflow(source);
    // Hash the full authority projection before bounding display fields. If a
    // long command changes after the persisted prefix, the digest must still
    // move; otherwise the raw digest alone would misclassify it as cosmetic.
    const persistedProjection = boundProjectionDetails(projection);
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
      authorityDigest: await sha256Hex(stableJson(canonicalizeProjectionForDigest(projection))),
      executionDigest: await sha256Hex(stableJson(projection.executionContext)),
    });
  }

  return {
    schema: RELEASE_AUTHORITY_SCHEMA,
    run: input.run,
    workflows: workflows.sort(byKey((item) => `${item.role}\u0000${item.path}`)),
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
      actions.sort(byKey((item) => `${item.workflow}\u0000${item.job}\u0000${item.uses}`)),
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
  executionContext: AuthorityExecutionContext[];
  actions: AuthorityActionRef[];
  publishSteps: AuthorityPublishStep[];
  safeguards: AuthoritySafeguard[];
  artifactFlow: AuthorityArtifactFlow[];
}

/**
 * Authority-sensitive execution controls that are hashed but not persisted for
 * display. Conditions and dependencies decide whether a publishing job/step
 * can run, env mappings and matrices can redirect an otherwise unchanged
 * publish command, and `continue-on-error` can make a failed safeguard
 * non-blocking. Hashing the values catches those edits without exposing them
 * in the stored snapshot.
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

async function projectWorkflow(source: WorkflowSource): Promise<WorkflowProjection> {
  const projection: WorkflowProjection = {
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
  projection.permissions.push(...readPermissions(workflow, null, doc.permissions));
  const workflowExecutionContext = await readExecutionContext(
    workflow,
    null,
    null,
    null,
    null,
    doc.env,
  );
  if (workflowExecutionContext) projection.executionContext.push(workflowExecutionContext);

  const jobs = asRecord(doc.jobs);
  if (!jobs) return projection;
  for (const [jobName, rawJob] of Object.entries(jobs)) {
    const job = asRecord(rawJob);
    if (!job) continue;

    projection.permissions.push(...readPermissions(workflow, jobName, job.permissions));
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
        strategy: job.strategy,
        continueOnError: job["continue-on-error"],
        runsOn: job["runs-on"],
        container: job.container,
        services: job.services,
        outputs: job.outputs,
      },
    );
    if (jobExecutionContext) projection.executionContext.push(jobExecutionContext);

    // A job-level `uses:` is a reusable-workflow call: the job's whole body is
    // delegated to another definition, so the reference and whether it inherits
    // secrets are authority, not implementation detail.
    const jobUses = asString(job.uses);
    if (jobUses) {
      projection.actions.push(
        await readActionRef(workflow, jobName, jobUses, job.secrets, job.with, true),
      );
    }

    const steps = Array.isArray(job.steps) ? job.steps : [];
    for (const [stepIndex, rawStep] of steps.entries()) {
      const step = asRecord(rawStep);
      if (!step) continue;
      const stepExecutionContext = await readExecutionContext(
        workflow,
        jobName,
        stepIndex,
        step.if,
        null,
        step.env,
        { continueOnError: step["continue-on-error"] },
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
    strategy?: YamlValue;
    continueOnError?: YamlValue;
    runsOn?: YamlValue;
    container?: YamlValue;
    services?: YamlValue;
    outputs?: YamlValue;
  } = {},
): Promise<AuthorityExecutionContext | null> {
  const condition = asString(conditionValue)?.trim() || null;
  const needs = [...asStringList(needsValue)].sort();
  const env = asRecord(envValue);
  const envDigest = env && Object.keys(env).length > 0 ? await sha256Hex(stableJson(env)) : null;
  const controls: { [key: string]: YamlValue } = {};
  if (controlValues.strategy != null) controls.strategy = controlValues.strategy;
  if (controlValues.continueOnError != null) {
    controls.continueOnError = controlValues.continueOnError;
  }
  if (controlValues.runsOn != null) controls.runsOn = controlValues.runsOn;
  if (controlValues.container != null) controls.container = controlValues.container;
  if (controlValues.services != null) controls.services = controlValues.services;
  if (controlValues.outputs != null) controls.outputs = controlValues.outputs;
  const controlsDigest =
    Object.keys(controls).length > 0 ? await sha256Hex(stableJson(controls)) : null;
  if (!condition && needs.length === 0 && !envDigest && !controlsDigest) return null;
  return { workflow, job, step, condition, needs, envDigest, controlsDigest };
}

/**
 * Hash effective authority rather than redundant syntax. A job-level
 * permissions block identical to the workflow-level block changes no job's
 * effective permissions, so adding or removing that duplicate must remain a
 * cosmetic edit. The explicit blocks stay in the persisted projection for
 * display and delta explanations; only the authority digest is canonicalized.
 */
function canonicalizeProjectionForDigest(projection: WorkflowProjection): WorkflowProjection {
  const workflowPermissions = new Map<string, AuthorityPermission[]>();
  const jobPermissions = new Map<string, AuthorityPermission[]>();
  for (const permission of projection.permissions) {
    if (permission.job === null) {
      const items = workflowPermissions.get(permission.workflow) ?? [];
      items.push(permission);
      workflowPermissions.set(permission.workflow, items);
      continue;
    }
    const key = `${permission.workflow}\u0000${permission.job}`;
    const items = jobPermissions.get(key) ?? [];
    items.push(permission);
    jobPermissions.set(key, items);
  }

  const redundantJobBlocks = new Set<string>();
  for (const [key, items] of jobPermissions) {
    const separator = key.indexOf("\u0000");
    const workflow = key.slice(0, separator);
    const inherited = workflowPermissions.get(workflow);
    if (inherited && permissionBlocksEqual(items, inherited)) redundantJobBlocks.add(key);
  }

  return {
    ...projection,
    triggers: [...projection.triggers].sort(
      byKey((item) => `${item.workflow}\u0000${item.event}\u0000${item.filter}`),
    ),
    permissions: projection.permissions
      .filter(
        (permission) =>
          permission.job === null ||
          !redundantJobBlocks.has(`${permission.workflow}\u0000${permission.job}`),
      )
      .sort(
        byKey(
          (item) => `${item.workflow}\u0000${item.job ?? ""}\u0000${item.scope}\u0000${item.level}`,
        ),
      ),
    environments: [...projection.environments].sort(
      byKey((item) => `${item.workflow}\u0000${item.job}\u0000${item.name}`),
    ),
    // Job-map key order is cosmetic, while step order inside one job is not.
    // Sort the job groups and preserve their original intra-job order.
    actions: sortJobGroups(projection.actions),
    publishSteps: sortJobGroups(projection.publishSteps),
    safeguards: sortJobGroups(projection.safeguards),
    artifactFlow: sortJobGroups(projection.artifactFlow),
  };
}

function sortJobGroups<T extends { workflow: string; job: string }>(items: T[]): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort(
      (left, right) =>
        compareStrings(
          `${left.item.workflow}\u0000${left.item.job}`,
          `${right.item.workflow}\u0000${right.item.job}`,
        ) || left.index - right.index,
    )
    .map(({ item }) => item);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function permissionBlocksEqual(left: AuthorityPermission[], right: AuthorityPermission[]): boolean {
  const canonical = (items: AuthorityPermission[]) =>
    items
      .map((item) => `${item.scope}\u0000${item.level}`)
      .sort()
      .join("\u0001");
  return canonical(left) === canonical(right);
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
        isPublishAction(actionName) || safeguard !== null,
        source.localActionDigests?.[uses.trim()] ?? null,
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
        detail: `with.attestations=${enabled ?? "true"}`,
      });
    }
    if (normalizedKey === "provenance" && enabled !== "false") {
      projection.safeguards.push({
        workflow,
        job,
        kind: "provenance",
        detail: `with.provenance=${enabled ?? "true"}`,
      });
    }
  }

  if (run) {
    for (const command of publishCommands(run)) {
      projection.publishSteps.push({ workflow, job, kind: "run", detail: command });
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
      filter: await normalizeTriggerFilter(event, config),
    })),
  );
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
  const crons = config
    .map((item) => asRecord(item))
    .map((item) => (item ? asString(item.cron)?.trim() : null))
    .filter((cron): cron is string => Boolean(cron));
  return crons.length > 0 ? `cron=[${[...new Set(crons)].sort().join(",")}]` : "";
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
  trackConfiguration: boolean,
  localActionDigest: string | null = null,
): Promise<AuthorityActionRef> {
  const trimmed = uses.trim();
  const local = trimmed.startsWith("./") || trimmed.startsWith("../");
  const separator = trimmed.lastIndexOf("@");
  const ref = !local && separator > 0 ? trimmed.slice(separator + 1) : null;
  const inputMap = asRecord(inputs);
  const secretMap = asRecord(secrets);
  const hasConfiguration =
    localActionDigest !== null ||
    (trackConfiguration &&
      ((inputMap && Object.keys(inputMap).length > 0) ||
        (secretMap && Object.keys(secretMap).length > 0)));
  return {
    workflow,
    job,
    uses: trimmed,
    ref,
    // A local path rides the same commit as the caller, so it moves only when
    // the caller's commit does. Everything else is pinned only by a full sha.
    pinned: local || isCommitSha(ref),
    secretsInherit: asString(secrets)?.trim().toLowerCase() === "inherit",
    configurationDigest: hasConfiguration
      ? await sha256Hex(
          stableJson({
            inputs: trackConfiguration ? (inputMap ?? {}) : {},
            secrets: trackConfiguration ? (secretMap ?? {}) : {},
            localActionDigest,
          }),
        )
      : null,
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
  /\b(?:npm|pnpm|yarn|bun)\b[^;&|\n]*\bpublish\b/,
  /\b(?:(?:python(?:3(?:\.\d+)*)?)\s+-m\s+)?twine\s+upload\b/,
  /\b(?:uv|poetry|flit|hatch|maturin)\s+publish\b/,
  /\bcargo\s+publish\b/,
  /\b(?:npx\s+)?(?:vsce|ovsx)\s+publish\b/,
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
      if (pattern.test(command)) found.push({ kind, detail: command });
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
    name: asString(inputs?.name ?? null) ?? "",
    path: asString(inputs?.path ?? null) ?? "",
  };
}

// ── Shared helpers ───────────────────────────────────────────────────────────

function boundProjectionDetails(projection: WorkflowProjection): WorkflowProjection {
  return {
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

function truncate(value: string): string {
  return value.length > MAX_DETAIL_LENGTH ? value.slice(0, MAX_DETAIL_LENGTH) : value;
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
