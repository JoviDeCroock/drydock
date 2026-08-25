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
and redelivers the GitHub decision. Completed gates are immutable and keep the
policy and roster that actually released them.

When reconciliation itself moves a scan to a verdict, `decided_at` is the
policy-change time rather than the older vote time. The route emits the same
per-scan `scan.decided` audit and analytics events as a vote-triggered verdict,
with `trigger: approval_policy` in the audit metadata.

Gate finalization and delivery scheduling happen before the policy-change audit
event is written. Audit bookkeeping is contained so a transient event-write
failure cannot leave a fully approved gate in `pending`.

Removing a member deletes their votes on releases that are **still undecided**
(`dropPendingApprovalsForMember`): someone who has left must not keep counting
toward the quorum. Decided releases keep their full roster — that approval was
real when it was given, and the audit trail has to keep saying so. If a later
policy increase reopens one of those staged decisions, the former member stays
in the historical roster but is excluded from the new live tally.

Account deletion follows the same pending/decided split. Votes on undecided
releases are deleted before the membership disappears; votes on decided
releases are scrubbed by setting `scan_approvals.user_id` to null, keeping the
historical count while dropping the identity. This is the same treatment
`scans.decided_by_user_id` gets.

## Both decision paths

- **Staged publish** (`POST /api/v1/scans/:id/decision`) — an audit record that
  publishes nothing, so a reviewer may freely revise their own vote. The
  response carries the full `approvals` state alongside the scan detail. This
  route accepts only manual/auto-discovered staged scans; workflow-gate package
  votes cannot bypass the gate route's per-vote step-up. The UI offers the npm
  publish/cancel follow-up only after the returned verdict has actually met the
  bar, never after a partial approval.
- **Workflow gate** (`POST /api/v1/github-app/workflow-gates/:gateId/decision`)
  — approving helps release a held deployment, so a vote is not freely
  revisable: the only permitted change is approve → block, the fail-closed
  direction. A second approval from the same member is a `409`. Under a
  multi-party policy this fail-closed path remains open when one package has
  reached its bar but sibling packages still keep the overall gate pending; a
  late blocker can still stop the deployment before it releases.

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
  roster (member, decision, reason, timestamp), `viewerDecision`, and
  `eligibleApproverCount`.
  It is attached in the route rather than inside `getScan`, because the same
  reader backs the public report export, which must never carry reviewer
  identities.
- `GET /api/v1/scans` returns `requiredApprovals`, a per-row `approvalCount`,
  and `legacyDecision`, so a partially-approved release renders as "1 of 2" in
  the queue instead of "undecided" while a historical decision remains distinct.
  A partial approval stays in the undecided filter, which is exactly where the
  second approver needs to find it.
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
- The `scan.decided` Analytics Engine event carries `approvalCount` and
  `requiredApprovals` as `double2`/`double3`. Without both, a rising
  time-to-decision reads as reviewer apathy when it is really a second approver
  being waited on. See [`product-analytics.md`](./product-analytics.md).
