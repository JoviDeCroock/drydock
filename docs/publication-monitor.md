# Public npm publication monitoring

The dashboard's **Publication monitor** watches automatically and manually enrolled public npm
packages independently of staged scans. It checks new public versions against
the active organization's prior release decisions and hashes the actual
published tarball. A direct publication can therefore appear even when Drydock
never discovered a stage or received a GitHub gate webhook.

This is advisory observation after publication. It does not hold npm releases,
establish package ownership, classify malware, or prevent the first install.
Private packages and custom registries are not supported in production.

## Enrollment and observations

Drydock automatically watches public npm packages from the organization's completed
staged reviews whose captured registry status confirms publication. It also enrolls
public packages as stages are discovered or manually submitted, before review runs.
Only stages from public npm qualify in production; private or unknown visibility,
custom registries, and published-pair reviews do not enroll packages. Completed npm
workflow gates supply suggestions that require **Watch package**, because a gate
alone does not establish public visibility.

Historical enrollment runs when the dashboard lists watches and in bounded cron
batches. It starts monitoring at enrollment time, never at the older review date;
older releases are not retrospectively reported as bypasses. The dashboard shows
where each watch came from and how many eligible packages await capacity at the
20-watch limit. Deferred packages enroll as slots become available.

You can also enter a public npm package name and choose **Watch package** without
an npm token or existing scan. Duplicate enrollment preserves the original start
time. Removing a watch deletes its observations and persists an organization-scoped
opt-out, so later discovery or history reconciliation cannot silently restore it.
Explicitly enrolling it again clears the opt-out and starts a new observation window.

The existing 15-minute cron checks watches independently of staged discovery.
**Check npm** runs a bounded check on demand. The dashboard displays the latest
100 observed versions for the selected watch (unacknowledged alerts first, then newest), along with the enrollment time,
last check and any coverage problem. Checks drain a backlog in batches, so one
check is not a promise that every pending version has been processed.

| Observation                      | Evidence                                                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Approved bytes published         | Actual tarball bytes match a completed review with a recorded approval strictly before npm's publication timestamp. |
| Published without prior approval | No qualifying prior approval was found in the organization's available review records.                              |
| Published despite rejection      | Actual bytes match a review rejected before publication.                                                            |
| Published different bytes        | Prior approval evidence exists, but the published bytes differ.                                                     |
| Evidence unknown                 | Publication time, bytes, or review evidence could not establish an outcome.                                         |

Unknown does not mean approved. Missing or future registry timestamps, unavailable
or oversized responses, invalid identities and incomplete legacy digests cannot
produce a matching approval. Reconfirming a staged decision after publication can
overwrite its prior decision timestamp; when current records cannot establish
that history, the monitor reports uncertainty instead of assuming no approval
ever existed. Observations describe the evidence available when checked, not a
complete immutable history of every decision, deleted review or registry event.

## Alerts and acknowledgment

New confirmed discrepancies (missing prior approval, publication despite rejection,
or different published bytes) create one durable alert per organization/package/version.
The monitor attempts email delivery to the organization's configured recipients (owner
fallback) and Slack delivery to its connected channel. Unknown evidence and matching
approvals do not generate discrepancy alerts. Existing observations from before alert
support are not retroactively announced.

Each watch row shows the unacknowledged alerts represented in its current observation
window. Stopping removes that visible history; retained deduplication records from older
windows do not create inaccessible alert counts on a new watch. Expand its releases to acknowledge
an alert; any organization member can acknowledge it. Acknowledgment is audited and
leaves the publication evidence unchanged. The alert ledger survives stopping a watch,
so explicitly re-enrolling cannot resend that release's notification or erase its
acknowledgment. Observation history still follows the watch's enrollment window.

Observation, alert and audit creation commit together. Delivery is attempted only by
the transaction that first creates the alert, matching the existing send-once notification
pattern; interruption or delivery failure can lose that attempt, and delivery is not
retried automatically. The durable dashboard alert remains available until the watch is stopped.

The organization `out-of-band-watch` flag disables acquisition and new alerts when
false, including manual checks. It defaults on without a FLAGS binding. Enrollment
and existing evidence remain accessible while disabled.

This consolidates the out-of-band watcher proposed in PR #651 into one monitor.
A matching scan alone does not suppress an alert: it needs qualifying approval and
matching bytes. No separate metadata-only poller, package-watch tables, or dashboard
banner is needed. Public npm is the production registry boundary.

Gate registry verification in PR #658 remains a distinct lifecycle: it verifies known
approved gate artifacts across ecosystems and can establish registry-verified identity.
This monitor also discovers releases that have no gate and makes no public badge claim.
Both use the existing npm published-tarball URL policy; their credential/authority and
acquisition contracts differ, so the monitor does not call the gate's sandbox parser.

## Byte and decision binding

The collector sends no credentials. Metadata comes from the fixed public npm
origin; tarball requests must remain on that origin and redirects are rejected.
Both response size and request duration are bounded. It streams tarball bytes
into SHA-256 and SHA-1 hashes without extracting, installing or executing them.

Review lookup is organization-scoped and requires the exact package and version.
For staged reviews, registry coordinates must also match public npm and the
persisted artifact-integrity evidence must be verified. These older reviews
carry SHA-1, so their comparison establishes continuity at that digest strength.
For npm workflow gates, the server-derived manifest and artifact digest supply
SHA-256 evidence. An approval of identical gate bytes does not prove which
registry the workflow intended to publish to, successful callback delivery, or
ownership of the npm package.

Published-pair reviews are not prior release authorization. Late decisions never
turn a publication into an approval-before-publication match. Confirmed
observations are retained; unresolved observations are retried. The monitor does
not rewrite scan findings, risk, decisions, signed public reports, public badge
identity, or Release Receipt v1.

## API and operation

All endpoints require a Better Auth session and active-organization membership:

- `GET /api/v1/publication-watches` reconciles eligible packages and lists watches,
  with per-watch `unresolvedAlertCount`, plus `autoEnrollment.deferred` and opt-in `autoEnrollment.suggestions`.
- `POST /api/v1/publication-watches { "packageName": "@scope/package" }` enrolls.
- `GET /api/v1/publication-watches/:id` returns the watch and latest observations.
- `POST /api/v1/publication-watches/:id/check` checks a bounded batch and returns
  current observations. Repeated checks are rate-limited.
- `POST /api/v1/publication-watches/:id/observations/:observationId/acknowledge`
  acknowledges a discrepancy and returns current watch/observations; repeats are idempotent.
- `DELETE /api/v1/publication-watches/:id` stops monitoring, removes history,
  and remembers the opt-out.

Responses are private and not cacheable. The organization has a 20-watch limit.
A cron sweep selects up to eight watches by oldest check; an individual check
handles up to three pending versions. A short database claim prevents overlapping
manual and scheduled checks from multiplying work on the same watch.
Metadata is capped at 4 MiB and tarballs at 16 MiB, with a five-second deadline
per response. A package exceeding 10,000 versions or stored observations reports
a history-limit coverage problem rather than silently treating a partial history
as complete.

Persistence lives in `publication_watches`, `publication_observations`, and
`publication_watch_candidates` (enrollment evidence and persistent opt-outs), and
`publication_alerts` (durable notification deduplication and acknowledgment).
`server/lib/ecosystems/npm/publication-auto-enrollment.ts` owns enrollment;
`server/lib/ecosystems/npm/publication-monitor.ts` owns acquisition and comparison;
`server/routes/npm-publication-watches.ts` owns the authenticated API. Operational
failures use safe codes through `emitOperationalEvent`, never raw registry errors.

The local fake-registry harness may use the existing explicitly enabled loopback
registry override. Production enrollment cannot select a registry URL. Tests cover
organization isolation, direct releases with no scan, prior decisions, actual
digest mismatch, missing evidence, bounded acquisition and the dashboard flow.
