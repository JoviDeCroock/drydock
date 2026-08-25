import { formatDateTime } from "../../../lib/format";
import type { ScanApprovalRecord, ScanApprovalState } from "../../../models/scan";
import { Alert } from "../../../components/Alert";
import { Badge } from "../../../components/Badge";
import { Muted } from "../../../components/Typography";

/**
 * Shared rendering for multi-party release approval.
 *
 * Under the default one-approval policy none of this appears: an approval is
 * the decision, and a roster of one would be noise. Above it, the reviewer's
 * central question changes from "is this safe" to "is this safe, and does my
 * click ship it" — so everything here exists to answer the second half.
 */

/** True when the org requires more than one approval and the roster is worth showing. */
export function isMultiApproval(approvals: ScanApprovalState | null | undefined): boolean {
  return Boolean(approvals && approvals.required > 1);
}

function approverLabel(entry: ScanApprovalRecord, viewerUserId?: string | null): string {
  const name =
    entry.name ?? entry.email ?? (entry.legacy ? "recorded decision" : "removed account");
  return entry.userId && entry.userId === viewerUserId ? `${name} (you)` : name;
}

/**
 * "1 of 2 approvals" — the release's position against its bar.
 *
 * Blocked releases never render progress: a block is unilateral and final, so
 * a count next to it would suggest the release is still in play.
 */
function ApprovalProgress({
  approvals,
  class: className,
}: {
  approvals: ScanApprovalState;
  class?: string;
}) {
  if (approvals.verdict === "no_publish") return null;
  if (approvals.legacyDecision) {
    return (
      <Badge tone="neutral" class={className}>
        recorded decision
      </Badge>
    );
  }
  const met = approvals.verdict === "publish";
  return (
    <Badge tone={met ? "ok" : "medium"} class={className}>
      {approvals.approvedCount} of {approvals.required} approvals
    </Badge>
  );
}

/**
 * A release whose bar can no longer be met by the people who could meet it.
 *
 * Reachable two ways — the owner raised the bar, or members left — and in both
 * the release simply never approves. Failing loudly here beats a deployment
 * that stays held with no visible reason.
 */
export function QuorumUnreachableNotice({ approvals }: { approvals: ScanApprovalState }) {
  const members = approvals.eligibleApproverCount;
  if (members === null || approvals.required <= members) return null;
  return (
    <Alert tone="warn">
      This organization requires {approvals.required} approvals but has {members}{" "}
      {members === 1 ? "member" : "members"}. No release can be approved until an owner invites more
      members or lowers the bar in{" "}
      <a class="underline text-accent" href="/dashboard/settings">
        Settings
      </a>
      .
    </Alert>
  );
}

/**
 * Who has signed off so far, and what is still missing.
 *
 * The empty rows are as load-bearing as the filled ones: "needs 1 more
 * approval" is the state a reviewer has to be able to see before deciding
 * whether to go find a colleague.
 */
export function ApprovalRoster({
  approvals,
  viewerUserId,
}: {
  approvals: ScanApprovalState;
  viewerUserId?: string | null;
}) {
  const outstanding = Math.max(0, approvals.required - approvals.approvedCount);
  const blocked = approvals.verdict === "no_publish";
  return (
    <div class="flex flex-col gap-2 border border-border rounded-md p-3">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <span class="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-subtle">
          Approvals
        </span>
        <ApprovalProgress approvals={approvals} />
      </div>
      {approvals.approvals.length ? (
        <ul class="m-0 p-0 list-none flex flex-col">
          {approvals.approvals.map((entry, index) => (
            <li
              key={`${entry.userId ?? "removed"}:${index}`}
              class="border-t border-border first:border-t-0 py-2 flex flex-wrap items-center justify-between gap-2"
            >
              <div class="flex flex-col gap-0.5 min-w-0">
                <span class="text-[13px] truncate">{approverLabel(entry, viewerUserId)}</span>
                {entry.reason ? (
                  <span class="text-[12px] leading-[1.5] text-ink-muted">{entry.reason}</span>
                ) : null}
              </div>
              <div class="flex items-center gap-2 shrink-0">
                <Badge tone={entry.decision === "publish" ? "ok" : "critical"}>
                  {entry.decision === "publish" ? "approved" : "blocked"}
                </Badge>
                <span class="font-mono text-[11px] text-ink-subtle">
                  {formatDateTime(entry.createdAt)}
                </span>
              </div>
            </li>
          ))}
        </ul>
      ) : approvals.approvedCount > 0 ? (
        // Counts without a roster: the dashboard's quick-decide dialog works
        // off a list row, which carries the tally but not who cast it.
        <Muted class="m-0 text-[13px]">
          Approved by {approvals.approvedCount} of {approvals.required} members. Open the review to
          see who.
        </Muted>
      ) : (
        <Muted class="m-0 text-[13px]">Nobody has reviewed this release yet.</Muted>
      )}
      {approvals.legacyDecision ? (
        <Muted class="m-0 text-[12px]">
          This decision was recorded without an approval roster, so it is not compared with today's
          approval threshold.
        </Muted>
      ) : blocked ? (
        <Muted class="m-0 text-[12px]">
          A block is final — it does not need a second reviewer to agree.
        </Muted>
      ) : outstanding > 0 ? (
        <Muted class="m-0 text-[12px]">
          Needs {outstanding} more {outstanding === 1 ? "approval" : "approvals"} from a different
          member of your organization.
        </Muted>
      ) : null}
    </div>
  );
}
