# Multi-party release approval

An organization can require more than one member to approve a release before it
counts as approved. At the default of **1**, the first approval is the decision
and nothing about the product changes. Above 1, a release stays undecided — and
a gated GitHub Actions deployment stays held — until that many _distinct_
members have approved it.

The threat this addresses is a single compromised or coerced maintainer account.
Everything else in Drydock makes the diff legible; this makes shipping it a
decision more than one person has to make.

## The model

`scans.decision` is still the one final verdict every downstream consumer reads
(badges, the threat feed, gate aggregation, the decision filters, the report
export). What changed is that it is no longer written directly.

Each submission records the acting member's **vote** as a `scan_approvals` row,
and the decision column is then set to whatever those votes add up to:

| votes on the scan                                     | `scans.decision` |
| ----------------------------------------------------- | ---------------- |
| any `no_publish`                                      | `no_publish`     |
| `publish` from ≥ `required_release_approvals` members | `publish`        |
| anything less                                         | `null`           |

Two rules are load-bearing:

- **A block is unilateral and immediate.** One rejection decides the release no
  matter how many approvals sit next to it and no matter what the bar is. A
  quorum can never be used to out-vote the person who found the postinstall
  script.
- **Approvals are per distinct member**, enforced by the
  `scan_approvals_scan_user_unique_idx` unique index rather than by application
  code. One reviewer clicking twice cannot clear a two-person bar. Live tallies
  also prove that each voter is still an organization member; a departed
  member stays visible in a decided release's history but cannot help a release
  that is currently waiting for quorum.

The tally is recomputed from all votes on every submission rather than
incremented. Two members approving at the same instant land two rows with
distinct keys, each then reads a tally that includes the other, and the second
one through writes the verdict — no counter has to be right about which write
won. The verdict update also re-proves the tally from the live rows inside the
SQL predicate, so an approval computed just before a concurrent block cannot
overwrite that block with a stale publish verdict.

The vote insert itself selects from the live organization-membership row in the
same SQL statement. A decision request authorized just before an owner removes
that member therefore cannot land a stale vote after removal cleanup and have
it become eligible again if the account is later re-invited.

## Where the policy lives

`organizations.required_release_approvals`, an integer defaulting to 1, changed
through `PUT /api/v1/organizations/:id/release-approvals` (owner-only, rate
limited, audited as `organization.release_approvals_changed`).

Lowering the bar is security-weakening and can immediately release a held
deployment. The owner must have two-factor authentication enabled and confirm
the change with a fresh TOTP code. Raising the bar does not require a step-up.
The update compares against the policy the route authorized, so a concurrent
owner change cannot turn a stale raise into an unverified lowering.

The route caps the bar at the organization's current member count. A
three-approval policy in a two-person org is not a stricter policy, it is a
release process that can never complete, and the failure would otherwise surface
much later as a deployment that silently never releases. Members can still leave
_after_ the policy is set, so both the settings card and the decision dialog
render a warning when `required > eligibleApproverCount`.

Changing the bar reconciles every voted staged release and every package behind
a still-pending workflow gate in the same D1 batch as the policy row. Lowering a
bar from three to two therefore immediately approves a release that already has
two votes; if that resolves every package in a gate, the policy route finalizes
and redelivers the GitHub decision. An identical concurrent policy request also
runs that finalization idempotently, so an interruption after the policy batch
cannot strand a now-ready gate. Completed gates are immutable and snapshot the
policy and roster that actually released them; later organization changes never
rewrite the threshold returned for that historical gate.

The same transaction advances every pending gate's decision generation. A vote
authorized before the policy change therefore cannot land after reconciliation
has already evaluated the roster. The gate's final approval CAS also proves that
each package has no blocking vote and enough current-member approvals for the
live bar; a stale projection or pre-roster package decision cannot release a
deployment under a stricter policy. Re-submitting the already-live threshold is
recovery work rather than a policy change: it may finish a ready gate, but does
not advance gate generations or emit a policy-change audit event.

When reconciliation itself moves a scan to a verdict, `decided_at` is the
policy-change time rather than the older vote time. The route emits the same
per-scan `scan.decided` audit and analytics events as a vote-triggered verdict,
with `trigger: approval_policy` in the audit metadata. The event actor remains
the member whose stored vote became decisive; `reconciledByUserId` identifies
the owner request that applied the policy transition.

Gate finalization and delivery scheduling happen before the policy-change audit
event is written. Audit bookkeeping is contained so a transient event-write
failure cannot leave a fully approved gate in `pending`.

Removing a member deletes their approvals on releases that are **still unfinished**:
someone who has left must not keep counting toward the quorum. A package that
has met its own bar while a sibling keeps the overall workflow gate pending is
still live release state, so member removal also drops that vote and reopens the
package if the remaining current-member approvals no longer meet the bar. The
membership deletion, vote cleanup, and package reconciliation are one D1 batch;
an interrupted removal cannot leave a stale vote that becomes eligible after a
later re-invite. Final staged decisions and completed gates keep their full
roster — that approval was real when it was given, and the audit trail has to
keep saying so. If a later policy increase reopens one of those staged approval
decisions, the former member stays in the historical roster but is excluded
from the new live tally. If that member later accepts a new invitation, the
membership write re-tallies retained votes in the same D1 batch: a tally that
becomes sufficient is projected back to `scans.decision` immediately rather
than waiting for another reviewer to submit. If that projection makes a pending
workflow gate ready, invitation acceptance also finalizes and schedules its
current aggregate decision: approval when every package is approved, or the
fail-closed rejection when a sibling already carries a durable block. A recorded
block remains final after its voter leaves; changing the approval threshold
cannot erase it.

Member removal and account deletion can reopen a package that was already
projected as approved while its workflow gate remains pending. Both paths
return those changed scan projections to their request boundary so the
colo-local badge and threat-feed entries are purged just like a direct decision
or policy reconciliation; other colos and shields.io remain bounded by the
documented short cache TTL.

Account deletion follows the same unfinished/final split. Approvals on
undecided releases, including packages behind a still-pending gate, are deleted
in the same D1 batch that revokes the account's memberships and repairs package
projections; durable blocks are retained. An in-flight approval therefore cannot
land between approval cleanup and membership revocation. Votes on final releases
are scrubbed by setting `scan_approvals.user_id` to null, keeping the historical
count while dropping the identity. This is the same treatment
`scans.decided_by_user_id` gets.

## Both decision paths

- **Staged publish** (`POST /api/v1/scans/:id/decision`) — an audit record that
  publishes nothing, so a reviewer may freely revise their own vote. The
  response carries the full `approvals` state alongside the scan detail. This
  route accepts only manual/auto-discovered staged scans; workflow-gate package
  votes cannot bypass the gate route's per-vote step-up. The UI offers the npm
  publish/cancel follow-up only after the returned verdict has actually met the
  bar, never after a partial approval. Under the default one-approval policy, a
  same-verdict resubmission advances the canonical decision revision so a
  replacement reason is recorded in the audit trail rather than silently
  diverging from it.
- **Workflow gate** (`POST /api/v1/github-app/workflow-gates/:gateId/decision`)
  — approving helps release a held deployment, so a vote is not freely
  revisable: the only permitted change is approve → block, the fail-closed
  direction. A second approval from the same member is a `409`. Under a
  multi-party policy this fail-closed path remains open when one package has
  reached its bar but sibling packages still keep the overall gate pending; a
  late blocker can still stop the deployment before it releases. Submissions
  are also recovery-safe across the package-verdict/gate-aggregate boundary: a
  retry re-tallies an already-durable vote, and a matching retry finalizes a
  still-pending gate whose package verdict committed before the request was
  interrupted. A durable rejection may be delivered by a later request, but
  the gate comment and audit actor come from the persisted blocking vote rather
  than from that recovery trigger. A reject retry can never release an
  already-approved aggregate.

A failed workflow-gate review batch can be retried only before any package has
received a human vote. Retrying replaces the batch's package scans, so once an
approval exists the original review state is kept and the retry endpoint fails
closed rather than erasing that approval and its audit trail.

Gate aggregation is unchanged and did not need to be: it releases only when
every package's `decision` is `publish`, and a package one approval short reads
there exactly like an undecided one, so the deployment stays held. Under a
multi-approval policy the bar applies **per package**, so a monorepo gate needs
`required × packages` approvals in total.

Two-factor step-up composes on top and applies per vote — each approver proves
their own second factor. See [`two-factor-auth.md`](./two-factor-auth.md).

## Surfaces

- `GET /api/v1/scans/:id` returns an `approvals` object: `required`,
  `approvedCount`, `blockedCount`, `verdict`, `legacyDecision`, the `approvals`
  roster (member, current decision, reason, latest submission timestamp), `viewerDecision`, and
  `eligibleApproverCount`.
  It is attached in the route rather than inside `getScan`, because the same
  reader backs the public report export, which must never carry reviewer
  identities.
- `GET /api/v1/scans` returns `requiredApprovals`, a per-row `approvalCount`,
  `viewerDecision`, and `legacyDecision`, so a partially-approved release renders
  as "1 of 2" in the queue instead of "undecided" while a historical decision
  remains distinct. The viewer vote keeps the quick-decision dialog from
  promising that resubmitting the same approval will meet quorum. A partial
  approval stays in the undecided filter, which is exactly where the second
  approver needs to find it.
- The gate payload carries `requiredApprovals` and a per-package
  `approvalCount`.
- Scans decided before this existed have a decision and no votes. The readers
  synthesize a single roster entry from `decided_by_user_id` so a legacy
  decision never renders as "0 of 1 approved". `legacyDecision` keeps the UI
  from comparing that historical verdict to today's approval threshold. The
  same fallback covers a gate package auto-blocked by the artifact verifier,
  which has no human voter.

UI lives in `src/pages/Dashboard/ScanDetail/ApprovalRoster.tsx` (shared by both
decision dialogs) and `src/pages/Dashboard/Settings/ReleaseApprovalsSection.tsx`.
Under a one-approval policy none of it renders.

## Audit and analytics

- `scan.decided` still records the release's **verdict** and fires once, when
  the bar is actually met — never per click, and never while the release still
  waits on a co-approver.
- `scan.approval_recorded` records each individual vote, and is written only
  when `required > 1`, where "who else signed off" is the point of the policy.
- Gate retries identify approval and verdict events by the durable vote and
  decision transition timestamps. If a request commits a vote and then loses
  its audit write, retrying repairs that exact transition rather than mistaking
  an older opposite decision for the missing event.
- The `scan.decided` Analytics Engine event carries `approvalCount` and
  `requiredApprovals` as `double2`/`double3`. Without both, a rising
  time-to-decision reads as reviewer apathy when it is really a second approver
  being waited on. See [`product-analytics.md`](./product-analytics.md).
