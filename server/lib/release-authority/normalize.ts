// Tolerant readers for persisted release-authority JSON.
//
// Snapshots and deltas are stored as JSON blobs, so every reader has to cope
// with rows written by an older build, rows written by a newer one, and rows
// that are simply malformed. Anything unusable normalizes to null rather than
// throwing — the same contract as `normalizeReleaseConsistency` and
// `normalizeScanRiskBreakdown`. A null baseline degrades to "no baseline",
// which is a neutral state, never a silent pass.

import { isRecord } from "../platform/guards";

import {
  type AuthorityActionRef,
  type AuthorityArtifact,
  type AuthorityArtifactFlow,
  type AuthorityCoverage,
  type AuthorityEnvironment,
  type AuthorityPermission,
  type AuthorityPublishStep,
  type AuthoritySafeguard,
  type AuthorityTrigger,
  type AuthorityUnresolved,
  type AuthorityUnresolvedReason,
  type AuthorityWorkflowRef,
  type PermissionLevel,
  RELEASE_AUTHORITY_SCHEMA,
  type ReleaseAuthorityRun,
  type ReleaseAuthoritySnapshot,
} from "./snapshot";

const PERMISSION_LEVELS = new Set<PermissionLevel>(["read", "write", "none", "unknown"]);
const UNRESOLVED_REASONS = new Set<AuthorityUnresolvedReason>([
  "not_accessible",
  "fetch_failed",
  "too_large",
  "unparseable",
  "partially_parsed",
  "limit_reached",
]);

export function normalizeReleaseAuthoritySnapshot(value: unknown): ReleaseAuthoritySnapshot | null {
  const record = asRecord(value);
  if (!record) return null;
  if (record.schema !== RELEASE_AUTHORITY_SCHEMA) return null;
  const run = normalizeRun(record.run);
  if (!run) return null;
  return {
    schema: RELEASE_AUTHORITY_SCHEMA,
    run,
    workflows: mapEntries(record.workflows, normalizeWorkflowRef),
    triggers: mapEntries(record.triggers, normalizeTrigger),
    permissions: mapEntries(record.permissions, normalizePermission),
    environments: mapEntries(record.environments, normalizeEnvironment),
    actions: mapEntries(record.actions, normalizeActionRef),
    publishSteps: mapEntries(record.publishSteps, normalizePublishStep),
    safeguards: mapEntries(record.safeguards, normalizeSafeguard),
    artifactFlow: mapEntries(record.artifactFlow, normalizeArtifactFlow),
    artifacts: mapEntries(record.artifacts, normalizeArtifact),
    coverage: normalizeCoverage(record.coverage),
  };
}

function normalizeRun(value: unknown): ReleaseAuthorityRun | null {
  const record = asRecord(value);
  if (!record) return null;
  const repositoryFullName = str(record.repositoryFullName);
  const environment = str(record.environment);
  if (!repositoryFullName || !environment) return null;
  return {
    repositoryFullName,
    environment,
    runId: int(record.runId) ?? 0,
    runAttempt: int(record.runAttempt),
    workflowPath: str(record.workflowPath),
    headSha: str(record.headSha),
    ref: str(record.ref),
    event: str(record.event),
    actor: str(record.actor),
    triggeringActor: str(record.triggeringActor),
  };
}

function normalizeWorkflowRef(value: unknown): AuthorityWorkflowRef | null {
  const record = asRecord(value);
  const path = record && str(record.path);
  if (!record || !path) return null;
  const role = record.role === "entry" || record.role === "referenced" ? record.role : null;
  if (!role) return null;
  return {
    path,
    repositoryFullName: str(record.repositoryFullName) ?? "",
    sha: str(record.sha),
    ref: str(record.ref),
    role,
    rawDigest: str(record.rawDigest),
    authorityDigest: str(record.authorityDigest),
    executionDigest: str(record.executionDigest),
  };
}

function normalizeTrigger(value: unknown): AuthorityTrigger | null {
  const record = asRecord(value);
  const workflow = record && str(record.workflow);
  const event = record && str(record.event);
  if (!record || !workflow || !event) return null;
  return { workflow, event, filter: str(record.filter) ?? "" };
}

function normalizePermission(value: unknown): AuthorityPermission | null {
  const record = asRecord(value);
  const workflow = record && str(record.workflow);
  const scope = record && str(record.scope);
  if (!record || !workflow || !scope) return null;
  const level = record.level as PermissionLevel;
  return {
    workflow,
    job: str(record.job),
    scope,
    level: PERMISSION_LEVELS.has(level) ? level : "unknown",
  };
}

function normalizeEnvironment(value: unknown): AuthorityEnvironment | null {
  const record = asRecord(value);
  const workflow = record && str(record.workflow);
  const job = record && str(record.job);
  const name = record && str(record.name);
  if (!record || !workflow || !job || !name) return null;
  return { workflow, job, name };
}

function normalizeActionRef(value: unknown): AuthorityActionRef | null {
  const record = asRecord(value);
  const workflow = record && str(record.workflow);
  const job = record && str(record.job);
  const uses = record && str(record.uses);
  if (!record || !workflow || !job || !uses) return null;
  return {
    workflow,
    job,
    uses,
    ref: str(record.ref),
    pinned: record.pinned === true,
    secretsInherit: record.secretsInherit === true,
    configurationDigest: str(record.configurationDigest),
  };
}

function normalizePublishStep(value: unknown): AuthorityPublishStep | null {
  const record = asRecord(value);
  const workflow = record && str(record.workflow);
  const job = record && str(record.job);
  const detail = record && str(record.detail);
  if (!record || !workflow || !job || !detail) return null;
  const kind = record.kind === "action" || record.kind === "run" ? record.kind : null;
  if (!kind) return null;
  return { workflow, job, kind, detail };
}

function normalizeSafeguard(value: unknown): AuthoritySafeguard | null {
  const record = asRecord(value);
  const workflow = record && str(record.workflow);
  const job = record && str(record.job);
  const detail = record && str(record.detail);
  if (!record || !workflow || !job || !detail) return null;
  const kind =
    record.kind === "attestation" || record.kind === "signing" || record.kind === "provenance"
      ? record.kind
      : null;
  if (!kind) return null;
  return { workflow, job, kind, detail };
}

function normalizeArtifactFlow(value: unknown): AuthorityArtifactFlow | null {
  const record = asRecord(value);
  const workflow = record && str(record.workflow);
  const job = record && str(record.job);
  if (!record || !workflow || !job) return null;
  const direction =
    record.direction === "upload" || record.direction === "download" ? record.direction : null;
  if (!direction) return null;
  return { workflow, job, direction, name: str(record.name) ?? "", path: str(record.path) ?? "" };
}

function normalizeArtifact(value: unknown): AuthorityArtifact | null {
  const record = asRecord(value);
  const name = record && str(record.name);
  const sha256 = record && str(record.sha256);
  if (!record || !name || !sha256) return null;
  return { name, kind: str(record.kind) ?? "", sha256: sha256.toLowerCase() };
}

function normalizeCoverage(value: unknown): AuthorityCoverage {
  const record = asRecord(value);
  if (!record) return { complete: false, unresolved: [] };
  const unresolved = mapEntries(record.unresolved, normalizeUnresolved);
  return { complete: record.complete === true && unresolved.length === 0, unresolved };
}

function normalizeUnresolved(value: unknown): AuthorityUnresolved | null {
  const record = asRecord(value);
  const path = record && str(record.path);
  if (!record || !path) return null;
  const reason = record.reason as AuthorityUnresolvedReason;
  return { path, reason: UNRESOLVED_REASONS.has(reason) ? reason : "fetch_failed" };
}

// ── Primitives ───────────────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function mapEntries<T>(value: unknown, read: (entry: unknown) => T | null): T[] {
  if (!Array.isArray(value)) return [];
  const entries: T[] = [];
  for (const entry of value) {
    const normalized = read(entry);
    if (normalized) entries.push(normalized);
  }
  return entries;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function int(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : null;
}
