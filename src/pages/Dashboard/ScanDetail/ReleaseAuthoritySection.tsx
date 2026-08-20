import type {
  AuthorityChange,
  AuthorityChangeKind,
  AuthoritySignificance,
  ReleaseAuthorityDelta,
} from "../../../../server/lib/release-authority/delta";
import type { AuthorityWorkflowRef } from "../../../../server/lib/release-authority/snapshot";
import type { PersistedReleaseAuthority } from "../../../models/scan";
import { Alert } from "../../../components/Alert";
import { Badge, type BadgeTone } from "../../../components/Badge";
import { MonoDetail, MonoLabel, SectionLabel } from "../../../components/Typography";
import { formatDateTime, pluralize } from "../../../lib/format";

// Release authority: what was allowed to publish this release, and what changed
// about it since the last release a maintainer approved.
//
// The section answers a different question from the package diff above it. The
// diff says what is in the release; this says whether the machinery that
// produced it is still the machinery that was agreed to. It renders only for
// workflow-gate reviews, and never for a scan whose authority was never
// captured — an absent record says "not assessed", which must not be dressed up
// as a clean result.

const SIGNIFICANCE_TONE: Record<AuthoritySignificance, BadgeTone> = {
  high: "high",
  medium: "medium",
  low: "low",
};

// Plain-language subject for each change kind. The `subject`/`before`/`after`
// fields carry the specifics; this is the sentence that frames them.
const CHANGE_LABEL: Record<AuthorityChangeKind, string> = {
  release_path_changed: "Release workflow has no approved history",
  workflow_added: "Workflow added to the release graph",
  workflow_removed: "Workflow dropped from the release graph",
  workflow_authority_changed: "Workflow authority changed",
  workflow_content_changed: "Workflow edited without changing its authority",
  trigger_added: "Trigger added",
  trigger_removed: "Trigger removed",
  trigger_filter_changed: "Trigger filter changed",
  trigger_filter_widened: "Trigger no longer filtered",
  permission_block_removed: "Permissions block removed — falls back to the repository default",
  permission_block_added: "Permissions block added",
  permission_added: "Permission added",
  permission_widened: "Permission widened",
  permission_narrowed: "Permission narrowed",
  permission_removed: "Permission removed",
  environment_added: "Environment added",
  environment_changed: "Environment changed",
  environment_removed: "Environment boundary removed",
  publish_step_added: "Publish step added",
  publish_step_removed: "Publish step removed",
  safeguard_added: "Release safeguard added",
  safeguard_removed: "Release safeguard removed",
  action_added: "Action added",
  action_removed: "Action removed",
  action_ref_changed: "Action reference changed",
  action_unpinned: "Action reference no longer pinned to a commit",
  action_pinned: "Action reference pinned to a commit",
  secrets_inherit_added: "Reusable workflow now inherits secrets",
  artifact_flow_changed: "Artifact path changed",
  artifact_set_changed: "Release artifact set changed",
  coverage_regressed: "Part of the authority graph became unreadable",
};

export function ReleaseAuthoritySection({
  authority,
}: {
  authority: PersistedReleaseAuthority | null | undefined;
}) {
  if (!authority) return null;
  const delta = authority.delta;

  return (
    <section class="flex flex-col gap-3 min-w-0">
      <SectionLabel as="h2" aside={<StatusBadge delta={delta} />}>
        Release authority
      </SectionLabel>

      <p class="m-0 text-[13px] leading-[1.6] text-ink-muted">{summaryLine(delta)}</p>

      {delta?.status === "changed" ? <ChangeList changes={delta.changes} /> : null}
      {delta ? <StandingNotes delta={delta} /> : null}

      <AuthorityEvidence authority={authority} />
    </section>
  );
}

function StatusBadge({ delta }: { delta: ReleaseAuthorityDelta | null }) {
  if (!delta) return <Badge tone="neutral">not assessed</Badge>;
  if (delta.status === "no_baseline") return <Badge tone="neutral">no baseline</Badge>;
  if (delta.status === "unchanged") return <Badge tone="ok">unchanged</Badge>;
  if (delta.status === "cosmetic") return <Badge tone="ok">cosmetic only</Badge>;
  return (
    <Badge
      tone={
        SIGNIFICANCE_TONE[delta.highestSignificance === "none" ? "low" : delta.highestSignificance]
      }
    >
      {delta.changeCount} {pluralize("change", delta.changeCount)}
    </Badge>
  );
}

function summaryLine(delta: ReleaseAuthorityDelta | null): string {
  if (!delta) {
    return "The publishing authority behind this release was not captured, so there is nothing to compare. Treat it as unreviewed rather than unchanged.";
  }
  switch (delta.status) {
    case "no_baseline":
      return "This is the first reviewed release on this repository, environment, and release path. Approving it records the authority that later releases are compared against.";
    case "unchanged":
      return "The workflows, permissions, environment, and publish path behind this release match the last release you approved.";
    case "cosmetic":
      return "The release workflow was edited, but nothing about its publishing authority changed — no triggers, permissions, environments, publish steps, or action references moved.";
    case "changed":
      // A changed status with no baseline is the new-release-path case: there
      // was nothing to diff, and the change itself names what was approved
      // before. Reusing the ordinary copy would promise a comparison the delta
      // did not make.
      return delta.baseline
        ? "The authority to publish this release differs from the last release you approved. Each change below is deterministic evidence, not an assessment of intent."
        : "This release published through a workflow that has no approved history on this repository and environment. There is no baseline to compare against; the change below names the release paths that were approved before this one.";
  }
}

function ChangeList({ changes }: { changes: AuthorityChange[] }) {
  if (changes.length === 0) return null;
  return (
    <ul class="list-none p-0 m-0 border border-border rounded-lg overflow-hidden divide-y divide-border">
      {changes.map((change) => (
        <li
          key={`${change.kind}:${change.scope}:${change.subject}`}
          class="flex flex-col gap-1.5 px-3 py-2.5 min-w-0"
        >
          <div class="flex flex-wrap items-center gap-2 min-w-0">
            <Badge tone={SIGNIFICANCE_TONE[change.significance]}>{change.significance}</Badge>
            <span class="text-[13px] text-ink">{CHANGE_LABEL[change.kind]}</span>
            {change.subject ? (
              <code class="font-mono text-[12px] text-ink-muted break-all min-w-0">
                {change.subject}
              </code>
            ) : null}
          </div>
          <MonoDetail
            parts={[
              change.scope,
              change.before !== null ? `was ${change.before}` : "not present before",
              change.after !== null ? `now ${change.after}` : "removed",
            ]}
          />
        </li>
      ))}
    </ul>
  );
}

/**
 * Standing properties are shown apart from the change list on purpose. A
 * reference that has always been mutable is not something this release did, and
 * folding it into the changes would make every release look like an incident —
 * while dropping it entirely would hide a real weakness.
 */
function StandingNotes({ delta }: { delta: ReleaseAuthorityDelta }) {
  const { standing } = delta;
  const hasNotes =
    !standing.coverageComplete ||
    standing.mutableRefs.length > 0 ||
    standing.artifactsWithoutDigest > 0;
  if (!hasNotes) return null;

  return (
    <div class="flex flex-col gap-2">
      {!standing.coverageComplete ? (
        <Alert tone="warn">
          Part of the authority graph could not be read, so this comparison is incomplete — an
          unreadable definition is exactly where a change would hide.
          {standing.unresolved.length > 0 ? (
            <>
              {" "}
              Unresolved:{" "}
              {standing.unresolved.map((item) => `${item.path} (${item.reason})`).join(", ")}.
            </>
          ) : null}
        </Alert>
      ) : null}

      {standing.artifactsWithoutDigest > 0 ? (
        <Alert tone="warn">
          {standing.artifactsWithoutDigest} {pluralize("artifact", standing.artifactsWithoutDigest)}{" "}
          in this release {standing.artifactsWithoutDigest === 1 ? "has" : "have"} no recomputed
          digest, so an approval cannot be bound to the exact bytes.
        </Alert>
      ) : null}

      {standing.mutableRefs.length > 0 ? (
        <div class="flex flex-col gap-1.5">
          <MonoLabel as="p">
            Standing: {standing.mutableRefs.length}{" "}
            {pluralize("reference", standing.mutableRefs.length)} a tag or branch can move
          </MonoLabel>
          <p class="m-0 font-mono text-[11px] text-ink-subtle break-all">
            {standing.mutableRefs.join(" · ")}
          </p>
        </div>
      ) : null}
    </div>
  );
}

function AuthorityEvidence({ authority }: { authority: PersistedReleaseAuthority }) {
  const run = authority.snapshot?.run ?? null;
  const workflows = authority.snapshot?.workflows ?? [];
  const baseline = authority.delta?.baseline ?? null;

  return (
    <div class="flex flex-col gap-2 border-t border-border pt-3">
      <MonoDetail
        parts={[
          run?.repositoryFullName,
          run?.environment ? `environment ${run.environment}` : null,
          `run ${authority.runId}`,
          run?.event ? `on ${run.event}` : null,
          run?.triggeringActor ? `by ${run.triggeringActor}` : null,
          authority.headSha ? `commit ${authority.headSha.slice(0, 12)}` : null,
          baseline?.approvedAt ? `baseline approved ${formatDateTime(baseline.approvedAt)}` : null,
        ]}
      />
      {authority.artifactBindingDigest ? (
        <div class="flex items-baseline gap-2 min-w-0">
          <MonoLabel class="flex-shrink-0">artifact binding</MonoLabel>
          <code class="font-mono text-[11px] text-ink-muted break-all min-w-0">
            {authority.artifactBindingDigest}
          </code>
        </div>
      ) : null}
      {workflows.length > 0 ? <WorkflowGraph workflows={workflows} /> : null}
    </div>
  );
}

function WorkflowGraph({ workflows }: { workflows: AuthorityWorkflowRef[] }) {
  return (
    <div class="flex flex-col gap-1">
      <MonoLabel as="p">
        Authority graph · {workflows.length} {pluralize("definition", workflows.length)}
      </MonoLabel>
      <ul class="list-none p-0 m-0 flex flex-col gap-1">
        {workflows.map((workflow) => (
          <li key={workflow.path} class="flex flex-wrap items-baseline gap-2 min-w-0">
            <Badge tone={workflow.role === "entry" ? "info" : "neutral"}>{workflow.role}</Badge>
            <code class="font-mono text-[11px] text-ink-muted break-all min-w-0">
              {workflow.path}
              {workflow.sha ? `@${workflow.sha.slice(0, 12)}` : ""}
            </code>
          </li>
        ))}
      </ul>
    </div>
  );
}
