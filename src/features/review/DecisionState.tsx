import { formatDateTime } from "../../lib/format";

/**
 * A recorded publish decision as plain text — "approved Sep 20, 09:36" — for
 * placing beside the control that changes it. Not a Badge: a decision someone
 * already made is settled state, and a filled chip beside every Decide/Update
 * button out-shouted the verdict and risk it answers. Renders nothing while
 * undecided; the Decide button already says that.
 */
export function DecisionState({
  decision,
  decidedAt,
}: {
  decision: string | null | undefined;
  decidedAt?: string | number | Date | null;
}) {
  if (decision !== "publish" && decision !== "no_publish") return null;
  return (
    <p class="m-0 font-mono text-[11px] text-ink-subtle whitespace-nowrap">
      <span class="sr-only">Decision: </span>
      <span class={decision === "publish" ? "text-ok-text" : "text-danger-text"}>
        {decision === "publish" ? "approved" : "blocked"}
      </span>
      {decidedAt ? ` ${formatDateTime(decidedAt)}` : null}
    </p>
  );
}
