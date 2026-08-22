// Tolerant reader for the persisted release-authority delta.
//
// Same contract as `normalize.ts`: a row written by another build, or a
// malformed one, reads as null rather than throwing. A null delta renders as
// "not assessed", which is neutral — it never reads as "no change found".

import { isRecord } from "../platform/guards";

import {
  AUTHORITY_CHANGES_CAP,
  type AuthorityBaselineRef,
  type AuthorityChange,
  type AuthorityChangeKind,
  type AuthorityDeltaStatus,
  type AuthoritySignificance,
  type AuthorityStanding,
  RELEASE_AUTHORITY_DELTA_SCHEMA,
  type ReleaseAuthorityDelta,
} from "./delta";
import type { AuthorityUnresolved, AuthorityUnresolvedReason } from "./snapshot";

const STATUSES = new Set<AuthorityDeltaStatus>(["no_baseline", "unchanged", "cosmetic", "changed"]);

const SIGNIFICANCES = new Set<AuthoritySignificance>(["low", "medium", "high"]);

const CHANGE_KINDS = new Set<AuthorityChangeKind>([
  "baseline_unreadable",
  "release_path_changed",
  "workflow_added",
  "workflow_removed",
  "workflow_authority_changed",
  "workflow_content_changed",
  "trigger_added",
  "trigger_removed",
  "trigger_filter_changed",
  "trigger_filter_widened",
  "permission_block_removed",
  "permission_block_added",
  "permission_added",
  "permission_widened",
  "permission_narrowed",
  "permission_removed",
  "environment_added",
  "environment_changed",
  "environment_removed",
  "publish_step_added",
  "publish_step_removed",
  "safeguard_added",
  "safeguard_removed",
  "action_added",
  "action_removed",
  "action_ref_changed",
  "action_configuration_changed",
  "action_unpinned",
  "action_pinned",
  "secrets_inherit_added",
  "artifact_flow_changed",
  "artifact_set_changed",
  "coverage_regressed",
]);

const UNRESOLVED_REASONS = new Set<AuthorityUnresolvedReason>([
  "not_accessible",
  "fetch_failed",
  "too_large",
  "unparseable",
  "partially_parsed",
  "limit_reached",
]);

export function normalizeReleaseAuthorityDelta(value: unknown): ReleaseAuthorityDelta | null {
  const record = asRecord(value);
  if (!record) return null;
  if (record.schema !== RELEASE_AUTHORITY_DELTA_SCHEMA) return null;
  const status = record.status as AuthorityDeltaStatus;
  if (!STATUSES.has(status)) return null;

  const changes = normalizeChanges(record.changes);
  const significance = record.highestSignificance as AuthoritySignificance;
  return {
    schema: RELEASE_AUTHORITY_DELTA_SCHEMA,
    status,
    baseline: normalizeBaseline(record.baseline),
    changes,
    changeCount: count(record.changeCount) ?? changes.length,
    highestSignificance: SIGNIFICANCES.has(significance) ? significance : "none",
    standing: normalizeStanding(record.standing),
    // Recomputed rather than trusted: the persisted flag is what policy reads
    // to hold a deployment, so it must follow from the stored status.
    requiresApproval: status === "changed",
  };
}

function normalizeBaseline(value: unknown): AuthorityBaselineRef | null {
  const record = asRecord(value);
  if (!record) return null;
  const snapshotId = str(record.snapshotId);
  const gateId = str(record.gateId);
  if (!snapshotId || !gateId) return null;
  return {
    snapshotId,
    gateId,
    runId: count(record.runId) ?? 0,
    headSha: str(record.headSha),
    approvedAt: str(record.approvedAt),
  };
}

function normalizeChanges(value: unknown): AuthorityChange[] {
  if (!Array.isArray(value)) return [];
  const changes: AuthorityChange[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (!record) continue;
    const kind = record.kind as AuthorityChangeKind;
    const significance = record.significance as AuthoritySignificance;
    const scope = str(record.scope);
    if (!CHANGE_KINDS.has(kind) || !SIGNIFICANCES.has(significance) || !scope) continue;
    changes.push({
      kind,
      significance,
      scope,
      subject: str(record.subject) ?? "",
      before: str(record.before),
      after: str(record.after),
    });
    if (changes.length >= AUTHORITY_CHANGES_CAP) break;
  }
  return changes;
}

function normalizeStanding(value: unknown): AuthorityStanding {
  const record = asRecord(value);
  if (!record) {
    return {
      mutableRefs: [],
      coverageComplete: false,
      unresolved: [],
      artifactsWithoutDigest: 0,
    };
  }
  const unresolved = normalizeUnresolved(record.unresolved);
  return {
    mutableRefs: Array.isArray(record.mutableRefs)
      ? record.mutableRefs.filter((item): item is string => typeof item === "string")
      : [],
    coverageComplete: record.coverageComplete === true && unresolved.length === 0,
    unresolved,
    artifactsWithoutDigest: count(record.artifactsWithoutDigest) ?? 0,
  };
}

function normalizeUnresolved(value: unknown): AuthorityUnresolved[] {
  if (!Array.isArray(value)) return [];
  const entries: AuthorityUnresolved[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    const path = record && str(record.path);
    if (!record || !path) continue;
    const reason = record.reason as AuthorityUnresolvedReason;
    entries.push({ path, reason: UNRESOLVED_REASONS.has(reason) ? reason : "fetch_failed" });
  }
  return entries;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : null;
}
