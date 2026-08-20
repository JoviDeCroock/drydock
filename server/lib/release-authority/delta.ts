// Release-authority delta: what changed in the authority to publish, measured
// against the last release a maintainer approved for the same release boundary.
//
// The policy is *review on authority change*, not permanent workflow-hash
// pinning. A pinned hash makes every edit a release-blocking event and pushes
// maintainers to disable the check; comparing against the last approved
// baseline asks the question that actually matters — "is this still the
// authority you agreed to?" — and stays quiet when the answer is yes.
//
// Two distinctions carry most of the signal quality:
//
//   changed vs standing — a reference that has *always* been mutable
//     (`actions/foo@v4`) is a standing property of this release path, not a
//     delta. A reference that *became* mutable is a delta. Reporting the first
//     as a change would make every release look like an incident; reporting it
//     nowhere would hide a real weakness. They go in different buckets.
//
//   authority vs cosmetic — comments, key order and formatting move a
//     workflow's raw digest but not its authority digest. Those releases report
//     `cosmetic` and never raise a high-signal warning.
//
// Nothing here is advisory-to-authoritative: the delta is deterministic
// evidence. Enforcement belongs to the GitHub Environment gate and the policy
// that reads `requiresApproval`, never to a model.

import type {
  AuthorityActionRef,
  AuthorityArtifact,
  AuthorityArtifactFlow,
  AuthorityEnvironment,
  AuthorityPermission,
  AuthorityPublishStep,
  AuthoritySafeguard,
  AuthorityTrigger,
  AuthorityUnresolved,
  AuthorityWorkflowRef,
  PermissionLevel,
  ReleaseAuthoritySnapshot,
} from "./snapshot";

export const RELEASE_AUTHORITY_DELTA_SCHEMA = "drydock.release-authority-delta.v1";

export type AuthorityDeltaStatus = "no_baseline" | "unchanged" | "cosmetic" | "changed";

export type AuthoritySignificance = "low" | "medium" | "high";

export type AuthorityChangeKind =
  | "release_path_changed"
  | "workflow_added"
  | "workflow_removed"
  | "workflow_authority_changed"
  | "workflow_content_changed"
  | "trigger_added"
  | "trigger_removed"
  | "trigger_filter_changed"
  | "trigger_filter_widened"
  | "permission_block_removed"
  | "permission_block_added"
  | "permission_added"
  | "permission_widened"
  | "permission_narrowed"
  | "permission_removed"
  | "environment_added"
  | "environment_changed"
  | "environment_removed"
  | "publish_step_added"
  | "publish_step_removed"
  | "safeguard_added"
  | "safeguard_removed"
  | "action_added"
  | "action_removed"
  | "action_ref_changed"
  | "action_unpinned"
  | "action_pinned"
  | "secrets_inherit_added"
  | "artifact_flow_changed"
  | "artifact_set_changed"
  | "coverage_regressed";

export interface AuthorityChange {
  kind: AuthorityChangeKind;
  significance: AuthoritySignificance;
  /** Where the change lives: `workflow`, `workflow/job`, or a bare category. */
  scope: string;
  /** Short human-readable subject, e.g. the permission scope or action name. */
  subject: string;
  before: string | null;
  after: string | null;
}

export interface AuthorityBaselineRef {
  snapshotId: string;
  gateId: string;
  runId: number;
  headSha: string | null;
  approvedAt: string | null;
}

/**
 * Properties of the current release authority that are not deltas. A standing
 * weakness deserves to be visible without being counted as a change, otherwise
 * every release inherits a warning it cannot clear.
 */
export interface AuthorityStanding {
  /** `uses:` references that a tag or branch can move under, in this release. */
  mutableRefs: string[];
  coverageComplete: boolean;
  unresolved: AuthorityUnresolved[];
  /** Reviewed artifacts with no recomputed digest; breaks the approval binding. */
  artifactsWithoutDigest: number;
}

export interface ReleaseAuthorityDelta {
  schema: typeof RELEASE_AUTHORITY_DELTA_SCHEMA;
  status: AuthorityDeltaStatus;
  baseline: AuthorityBaselineRef | null;
  changes: AuthorityChange[];
  /** Total changes found, which may exceed `changes.length` after capping. */
  changeCount: number;
  highestSignificance: AuthoritySignificance | "none";
  standing: AuthorityStanding;
  /**
   * True when a maintainer must explicitly accept the authority change before
   * the held deployment may be released. Read by policy; the GitHub Environment
   * gate does the enforcing.
   */
  requiresApproval: boolean;
}

export const AUTHORITY_CHANGES_CAP = 100;

// Events that hand release authority to a wider set of actors or contexts.
// Gaining one of these is a different class of change from gaining `push`.
const DANGEROUS_TRIGGERS = new Set([
  "issue_comment",
  "pull_request_target",
  "repository_dispatch",
  "schedule",
  "workflow_dispatch",
  "workflow_run",
]);

const PERMISSION_RANK: Record<PermissionLevel, number> = {
  none: 0,
  read: 1,
  write: 2,
  // An unreadable level is ranked at the top so an unknown never reads as a
  // narrowing. It can produce a redundant warning; it cannot hide a widening.
  unknown: 3,
};

const SIGNIFICANCE_RANK: Record<AuthoritySignificance, number> = { low: 0, medium: 1, high: 2 };

/**
 * Context a delta needs that the two snapshots cannot supply on their own.
 */
export interface DeltaContext {
  /**
   * Entry-workflow paths this release target has already published through
   * under an approved authority, other than the one this release used. Only
   * consulted when there is no baseline for the current path — see
   * `newReleasePathChange`.
   */
  approvedReleasePaths?: string[];
}

/**
 * Compare a release's authority snapshot against the last approved baseline for
 * the same release boundary. A null baseline is the neutral `no_baseline`
 * state — the first gate for a target, and every scan that predates this
 * feature, legitimately has nothing to compare against — *unless* the target has
 * approved history on some other release path, which is a change in itself.
 */
export function computeReleaseAuthorityDelta(
  current: ReleaseAuthoritySnapshot,
  baseline: { snapshot: ReleaseAuthoritySnapshot; ref: AuthorityBaselineRef } | null,
  context: DeltaContext = {},
): ReleaseAuthorityDelta {
  const standing = readStanding(current);
  if (!baseline) {
    const newPath = newReleasePathChange(current, context.approvedReleasePaths ?? []);
    return {
      schema: RELEASE_AUTHORITY_DELTA_SCHEMA,
      status: newPath ? "changed" : "no_baseline",
      // There is no comparable baseline either way: the target's other release
      // paths are named in the change itself, not offered as a diff basis.
      baseline: null,
      changes: newPath ? [newPath] : [],
      changeCount: newPath ? 1 : 0,
      highestSignificance: newPath ? newPath.significance : "none",
      standing,
      requiresApproval: newPath !== null,
    };
  }

  const prior = baseline.snapshot;
  const changes: AuthorityChange[] = [
    ...compareWorkflows(prior.workflows, current.workflows),
    ...compareTriggers(prior.triggers, current.triggers),
    ...comparePermissions(prior.permissions, current.permissions),
    ...compareEnvironments(prior.environments, current.environments),
    ...comparePublishSteps(prior.publishSteps, current.publishSteps),
    ...compareSafeguards(prior.safeguards, current.safeguards),
    ...compareActions(prior.actions, current.actions),
    ...compareArtifactFlow(prior.artifactFlow, current.artifactFlow),
    ...compareArtifactSet(prior.artifacts, current.artifacts),
    ...compareCoverage(prior, current),
  ];

  // A workflow whose authority digest moved without producing any change above
  // means the projection carries something the category comparisons do not
  // read. Say so rather than reporting "unchanged" — a silent gap here is the
  // exact failure this feature exists to prevent.
  changes.push(...unexplainedAuthorityChanges(prior.workflows, current.workflows, changes));

  const substantive = changes.filter((change) => change.kind !== "workflow_content_changed");
  const cosmetic = changes.filter((change) => change.kind === "workflow_content_changed");
  const effective = substantive.length > 0 ? changes : cosmetic;
  const status: AuthorityDeltaStatus =
    substantive.length > 0 ? "changed" : cosmetic.length > 0 ? "cosmetic" : "unchanged";

  const ordered = effective.sort(compareChanges);
  return {
    schema: RELEASE_AUTHORITY_DELTA_SCHEMA,
    status,
    baseline: baseline.ref,
    changes: ordered.slice(0, AUTHORITY_CHANGES_CAP),
    changeCount: ordered.length,
    highestSignificance: ordered.length > 0 ? ordered[0].significance : "none",
    standing,
    requiresApproval: status === "changed",
  };
}

// How many other release paths to name before summarizing the rest.
const MAX_NAMED_RELEASE_PATHS = 8;

/**
 * A release arriving on an entry workflow this target has never published
 * through, while it *has* approved history on other paths.
 *
 * Baselines are deliberately per release path, so there is nothing to diff —
 * but reporting that as `no_baseline` would say "first reviewed release here",
 * and this is close to the opposite: an additional way to publish appeared on
 * an established release target. Adding a second publish workflow leaves the
 * package diff clean while changing who is allowed to publish, which is the
 * exact shape this feature exists to catch, so it is a change in its own right
 * rather than a quiet first run.
 */
function newReleasePathChange(
  current: ReleaseAuthoritySnapshot,
  approvedReleasePaths: string[],
): AuthorityChange | null {
  const after = current.run.workflowPath;
  // An unreadable entry path is a coverage problem and is already reported as
  // one. Claiming the release path changed *from* something would be a stronger
  // statement than the evidence supports.
  if (!after) return null;
  const others = [...new Set(approvedReleasePaths)].filter((path) => path && path !== after).sort();
  if (others.length === 0) return null;
  return {
    kind: "release_path_changed",
    significance: "high",
    scope: current.run.environment,
    subject: "entry workflow",
    before: describeReleasePaths(others),
    after,
  };
}

function describeReleasePaths(paths: string[]): string {
  if (paths.length <= MAX_NAMED_RELEASE_PATHS) return paths.join(", ");
  const named = paths.slice(0, MAX_NAMED_RELEASE_PATHS);
  return `${named.join(", ")} +${paths.length - MAX_NAMED_RELEASE_PATHS} more`;
}

// ── Standing properties ──────────────────────────────────────────────────────

function readStanding(snapshot: ReleaseAuthoritySnapshot): AuthorityStanding {
  const mutableRefs = [
    ...new Set(snapshot.actions.filter((action) => !action.pinned).map((action) => action.uses)),
  ].sort();
  return {
    mutableRefs,
    coverageComplete: snapshot.coverage.complete,
    unresolved: snapshot.coverage.unresolved,
    artifactsWithoutDigest: snapshot.artifacts.filter((artifact) => !artifact.sha256).length,
  };
}

// ── Category comparisons ─────────────────────────────────────────────────────

function compareWorkflows(
  prior: AuthorityWorkflowRef[],
  current: AuthorityWorkflowRef[],
): AuthorityChange[] {
  const priorByPath = keyBy(prior, (item) => item.path);
  const currentByPath = keyBy(current, (item) => item.path);
  const changes: AuthorityChange[] = [];

  for (const [path, item] of currentByPath) {
    const before = priorByPath.get(path);
    if (!before) {
      changes.push({
        kind: "workflow_added",
        significance: "medium",
        scope: path,
        subject: item.role === "referenced" ? "reusable workflow" : "workflow",
        before: null,
        after: item.sha ?? item.ref ?? path,
      });
      continue;
    }
    // Authority equal but bytes moved: a comment, reordering, or formatting
    // edit. Recorded so the review can say "the file changed, the authority did
    // not" — and deliberately kept at low significance.
    if (
      before.authorityDigest &&
      item.authorityDigest &&
      before.authorityDigest === item.authorityDigest &&
      before.rawDigest &&
      item.rawDigest &&
      before.rawDigest !== item.rawDigest
    ) {
      changes.push({
        kind: "workflow_content_changed",
        significance: "low",
        scope: path,
        subject: "cosmetic edit",
        before: before.sha,
        after: item.sha,
      });
    }
  }

  for (const [path, item] of priorByPath) {
    if (currentByPath.has(path)) continue;
    changes.push({
      kind: "workflow_removed",
      significance: "medium",
      scope: path,
      subject: item.role === "referenced" ? "reusable workflow" : "workflow",
      before: item.sha ?? item.ref ?? path,
      after: null,
    });
  }

  return changes;
}

function unexplainedAuthorityChanges(
  prior: AuthorityWorkflowRef[],
  current: AuthorityWorkflowRef[],
  explained: AuthorityChange[],
): AuthorityChange[] {
  const priorByPath = keyBy(prior, (item) => item.path);
  // A change's scope is either the workflow path or `<workflow path>/<job>`,
  // and workflow paths themselves contain slashes — so this matches on the
  // prefix rather than splitting.
  const explainedScopes = explained
    .filter((change) => change.kind !== "workflow_content_changed")
    .map((change) => change.scope);
  const changes: AuthorityChange[] = [];
  for (const item of current) {
    const before = priorByPath.get(item.path);
    if (!before || !before.authorityDigest || !item.authorityDigest) continue;
    if (before.authorityDigest === item.authorityDigest) continue;
    const explainedHere = explainedScopes.some(
      (scope) => scope === item.path || scope.startsWith(`${item.path}/`),
    );
    if (explainedHere) continue;
    changes.push({
      kind: "workflow_authority_changed",
      significance: "medium",
      scope: item.path,
      subject: "authority projection",
      before: before.authorityDigest.slice(0, 12),
      after: item.authorityDigest.slice(0, 12),
    });
  }
  return changes;
}

function compareTriggers(
  prior: AuthorityTrigger[],
  current: AuthorityTrigger[],
): AuthorityChange[] {
  const priorByKey = keyBy(prior, (item) => `${item.workflow}\u0000${item.event}`);
  const currentByKey = keyBy(current, (item) => `${item.workflow}\u0000${item.event}`);
  const changes: AuthorityChange[] = [];

  for (const [key, item] of currentByKey) {
    const before = priorByKey.get(key);
    if (!before) {
      changes.push({
        kind: "trigger_added",
        significance: DANGEROUS_TRIGGERS.has(item.event) ? "high" : "medium",
        scope: item.workflow,
        subject: item.event,
        before: null,
        after: item.filter || item.event,
      });
      continue;
    }
    if (before.filter === item.filter) continue;
    // Losing every filter means the event now fires on refs it previously
    // could not, which is a widening rather than a plain edit.
    const widened = before.filter.length > 0 && item.filter.length === 0;
    changes.push({
      kind: widened ? "trigger_filter_widened" : "trigger_filter_changed",
      significance: widened ? "high" : "medium",
      scope: item.workflow,
      subject: item.event,
      before: before.filter || "(unfiltered)",
      after: item.filter || "(unfiltered)",
    });
  }

  for (const [key, item] of priorByKey) {
    if (currentByKey.has(key)) continue;
    changes.push({
      kind: "trigger_removed",
      significance: "low",
      scope: item.workflow,
      subject: item.event,
      before: item.filter || item.event,
      after: null,
    });
  }

  return changes;
}

function comparePermissions(
  prior: AuthorityPermission[],
  current: AuthorityPermission[],
): AuthorityChange[] {
  const blockKey = (item: AuthorityPermission) => `${item.workflow}\u0000${item.job ?? ""}`;
  const scopeKey = (item: AuthorityPermission) => `${blockKey(item)}\u0000${item.scope}`;
  const priorByScope = keyBy(prior, scopeKey);
  const currentByScope = keyBy(current, scopeKey);
  const priorBlocks = keyBy(prior, blockKey);
  const currentBlocks = keyBy(current, blockKey);
  const changes: AuthorityChange[] = [];

  // Dropping the `permissions:` block entirely is not a narrowing — the job
  // falls back to the repository default, which is usually broader than any
  // explicit block. This is the widening that looks like a deletion.
  for (const [key, item] of priorBlocks) {
    if (currentBlocks.has(key)) continue;
    changes.push({
      kind: "permission_block_removed",
      significance: "high",
      scope: scopeLabel(item.workflow, item.job),
      subject: "permissions block",
      before: "explicit",
      after: "repository default",
    });
  }
  for (const [key, item] of currentBlocks) {
    if (priorBlocks.has(key)) continue;
    changes.push({
      kind: "permission_block_added",
      significance: "low",
      scope: scopeLabel(item.workflow, item.job),
      subject: "permissions block",
      before: "repository default",
      after: "explicit",
    });
  }

  for (const [key, item] of currentByScope) {
    const before = priorByScope.get(key);
    const scope = scopeLabel(item.workflow, item.job);
    if (!before) {
      // A scope appearing inside a block that already existed is an addition;
      // a whole new block is reported once, above, so skip its scopes.
      if (!priorBlocks.has(blockKey(item))) continue;
      changes.push({
        kind: "permission_added",
        significance: PERMISSION_RANK[item.level] >= PERMISSION_RANK.write ? "high" : "medium",
        scope,
        subject: item.scope,
        before: null,
        after: item.level,
      });
      continue;
    }
    if (before.level === item.level) continue;
    const widened = PERMISSION_RANK[item.level] > PERMISSION_RANK[before.level];
    changes.push({
      kind: widened ? "permission_widened" : "permission_narrowed",
      significance: widened ? "high" : "low",
      scope,
      subject: item.scope,
      before: before.level,
      after: item.level,
    });
  }

  for (const [key, item] of priorByScope) {
    if (currentByScope.has(key)) continue;
    if (!currentBlocks.has(blockKey(item))) continue;
    changes.push({
      kind: "permission_removed",
      significance: "low",
      scope: scopeLabel(item.workflow, item.job),
      subject: item.scope,
      before: item.level,
      after: null,
    });
  }

  return changes;
}

function compareEnvironments(
  prior: AuthorityEnvironment[],
  current: AuthorityEnvironment[],
): AuthorityChange[] {
  const key = (item: AuthorityEnvironment) => `${item.workflow}\u0000${item.job}`;
  const priorByJob = keyBy(prior, key);
  const currentByJob = keyBy(current, key);
  const changes: AuthorityChange[] = [];

  for (const [jobKey, item] of currentByJob) {
    const before = priorByJob.get(jobKey);
    if (!before) {
      changes.push({
        kind: "environment_added",
        significance: "low",
        scope: scopeLabel(item.workflow, item.job),
        subject: "environment",
        before: null,
        after: item.name,
      });
      continue;
    }
    if (before.name === item.name) continue;
    changes.push({
      kind: "environment_changed",
      significance: "high",
      scope: scopeLabel(item.workflow, item.job),
      subject: "environment",
      before: before.name,
      after: item.name,
    });
  }

  // Losing the environment removes the deployment-protection boundary itself —
  // the gate that holds the publish job. Always high.
  for (const [jobKey, item] of priorByJob) {
    if (currentByJob.has(jobKey)) continue;
    changes.push({
      kind: "environment_removed",
      significance: "high",
      scope: scopeLabel(item.workflow, item.job),
      subject: "environment",
      before: item.name,
      after: null,
    });
  }

  return changes;
}

function comparePublishSteps(
  prior: AuthorityPublishStep[],
  current: AuthorityPublishStep[],
): AuthorityChange[] {
  const key = (item: AuthorityPublishStep) =>
    `${item.workflow}\u0000${item.job}\u0000${item.kind}\u0000${item.detail}`;
  return diffSets(prior, current, key, {
    added: (item) => ({
      kind: "publish_step_added",
      significance: "high",
      scope: scopeLabel(item.workflow, item.job),
      subject: item.kind === "action" ? "publish action" : "publish command",
      before: null,
      after: item.detail,
    }),
    removed: (item) => ({
      kind: "publish_step_removed",
      significance: "medium",
      scope: scopeLabel(item.workflow, item.job),
      subject: item.kind === "action" ? "publish action" : "publish command",
      before: item.detail,
      after: null,
    }),
  });
}

function compareSafeguards(
  prior: AuthoritySafeguard[],
  current: AuthoritySafeguard[],
): AuthorityChange[] {
  const key = (item: AuthoritySafeguard) =>
    `${item.workflow}\u0000${item.job}\u0000${item.kind}\u0000${item.detail}`;
  return diffSets(prior, current, key, {
    // Removing attestation, signing, or provenance keeps the release working
    // while deleting the evidence that it was built by the workflow it claims.
    // This is the change the bittensor-wallet 4.0.2 replay is built around.
    removed: (item) => ({
      kind: "safeguard_removed",
      significance: "high",
      scope: scopeLabel(item.workflow, item.job),
      subject: item.kind,
      before: item.detail,
      after: null,
    }),
    added: (item) => ({
      kind: "safeguard_added",
      significance: "low",
      scope: scopeLabel(item.workflow, item.job),
      subject: item.kind,
      before: null,
      after: item.detail,
    }),
  });
}

function compareActions(
  prior: AuthorityActionRef[],
  current: AuthorityActionRef[],
): AuthorityChange[] {
  const key = (item: AuthorityActionRef) =>
    `${item.workflow}\u0000${item.job}\u0000${actionIdentity(item.uses)}`;
  const priorByKey = keyBy(prior, key);
  const currentByKey = keyBy(current, key);
  const changes: AuthorityChange[] = [];

  for (const [actionKey, item] of currentByKey) {
    const before = priorByKey.get(actionKey);
    const scope = scopeLabel(item.workflow, item.job);
    if (!before) {
      changes.push({
        kind: "action_added",
        significance: "medium",
        scope,
        subject: actionIdentity(item.uses),
        before: null,
        after: item.uses,
      });
      continue;
    }
    if (!item.pinned && before.pinned) {
      // A pinned reference that became mutable can now change under the
      // approval without any further review. A reference that was always
      // mutable is standing, not a delta, and is reported separately.
      changes.push({
        kind: "action_unpinned",
        significance: "high",
        scope,
        subject: actionIdentity(item.uses),
        before: before.ref,
        after: item.ref,
      });
    } else if (item.pinned && !before.pinned) {
      changes.push({
        kind: "action_pinned",
        significance: "low",
        scope,
        subject: actionIdentity(item.uses),
        before: before.ref,
        after: item.ref,
      });
    } else if (before.ref !== item.ref) {
      changes.push({
        kind: "action_ref_changed",
        significance: "medium",
        scope,
        subject: actionIdentity(item.uses),
        before: before.ref,
        after: item.ref,
      });
    }
    if (item.secretsInherit && !before.secretsInherit) {
      changes.push({
        kind: "secrets_inherit_added",
        significance: "high",
        scope,
        subject: actionIdentity(item.uses),
        before: "explicit secrets",
        after: "inherit",
      });
    }
  }

  for (const [actionKey, item] of priorByKey) {
    if (currentByKey.has(actionKey)) continue;
    changes.push({
      kind: "action_removed",
      significance: "low",
      scope: scopeLabel(item.workflow, item.job),
      subject: actionIdentity(item.uses),
      before: item.uses,
      after: null,
    });
  }

  return changes;
}

function compareArtifactFlow(
  prior: AuthorityArtifactFlow[],
  current: AuthorityArtifactFlow[],
): AuthorityChange[] {
  const key = (item: AuthorityArtifactFlow) =>
    `${item.workflow}\u0000${item.job}\u0000${item.direction}\u0000${item.name}`;
  const priorByKey = keyBy(prior, key);
  const currentByKey = keyBy(current, key);
  const changes: AuthorityChange[] = [];

  for (const [flowKey, item] of currentByKey) {
    const before = priorByKey.get(flowKey);
    if (before && before.path === item.path) continue;
    changes.push({
      kind: "artifact_flow_changed",
      significance: "medium",
      scope: scopeLabel(item.workflow, item.job),
      subject: `${item.direction} ${item.name || "(unnamed)"}`,
      before: before ? before.path : null,
      after: item.path,
    });
  }

  for (const [flowKey, item] of priorByKey) {
    if (currentByKey.has(flowKey)) continue;
    changes.push({
      kind: "artifact_flow_changed",
      significance: "medium",
      scope: scopeLabel(item.workflow, item.job),
      subject: `${item.direction} ${item.name || "(unnamed)"}`,
      before: item.path,
      after: null,
    });
  }

  return changes;
}

/**
 * Compare the *shape* of the artifact set, never the digests. Digests change on
 * every release by construction, so diffing them would flag every release;
 * they are bound to the approval record instead. What is comparable is how many
 * artifacts of each kind a release produces.
 */
function compareArtifactSet(
  prior: AuthorityArtifact[],
  current: AuthorityArtifact[],
): AuthorityChange[] {
  const before = describeArtifactShape(prior);
  const after = describeArtifactShape(current);
  if (before === after) return [];
  return [
    {
      kind: "artifact_set_changed",
      significance: "medium",
      scope: "artifacts",
      subject: "release shape",
      before,
      after,
    },
  ];
}

function describeArtifactShape(artifacts: AuthorityArtifact[]): string {
  const counts = new Map<string, number>();
  for (const artifact of artifacts) {
    const kind = artifact.kind || "unknown";
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([kind, count]) => `${count}×${kind}`)
    .join(", ");
}

/**
 * Only a *regression* in coverage is a change. A reusable workflow that was
 * already unreadable at the approved baseline is a standing limitation, and
 * reporting it every release would train maintainers to click through the one
 * signal that means "a change could be hiding here".
 */
function compareCoverage(
  prior: ReleaseAuthoritySnapshot,
  current: ReleaseAuthoritySnapshot,
): AuthorityChange[] {
  if (current.coverage.complete || !prior.coverage.complete) return [];
  return [
    {
      kind: "coverage_regressed",
      significance: "medium",
      scope: "coverage",
      subject: "authority graph",
      before: "complete",
      after: current.coverage.unresolved.map((item) => `${item.path} (${item.reason})`).join("; "),
    },
  ];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function actionIdentity(uses: string): string {
  const separator = uses.lastIndexOf("@");
  return separator > 0 ? uses.slice(0, separator) : uses;
}

function scopeLabel(workflow: string, job: string | null): string {
  return job ? `${workflow}/${job}` : workflow;
}

function keyBy<T>(items: T[], key: (item: T) => string): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of items) {
    if (!map.has(key(item))) map.set(key(item), item);
  }
  return map;
}

function diffSets<T>(
  prior: T[],
  current: T[],
  key: (item: T) => string,
  build: { added: (item: T) => AuthorityChange; removed: (item: T) => AuthorityChange },
): AuthorityChange[] {
  const priorKeys = new Set(prior.map(key));
  const currentKeys = new Set(current.map(key));
  const changes: AuthorityChange[] = [];
  for (const item of current) {
    if (!priorKeys.has(key(item))) changes.push(build.added(item));
  }
  for (const item of prior) {
    if (!currentKeys.has(key(item))) changes.push(build.removed(item));
  }
  return changes;
}

function compareChanges(a: AuthorityChange, b: AuthorityChange): number {
  const bySignificance = SIGNIFICANCE_RANK[b.significance] - SIGNIFICANCE_RANK[a.significance];
  if (bySignificance !== 0) return bySignificance;
  return cmp(a.kind, b.kind) || cmp(a.scope, b.scope) || cmp(a.subject, b.subject);
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
