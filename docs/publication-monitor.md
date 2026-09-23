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
Because stopping hides unacknowledged alerts and opts the package out, only owners
and admins (the integration-management role) can stop a watch; any member can enroll
one. Explicitly enrolling it again clears the opt-out and starts a new observation
window. Both are recorded in the audit log.

The existing 15-minute cron checks watches independently of staged discovery.
**Check npm** runs a bounded check on demand. The dashboard displays the latest
100 observed versions for the selected watch (unacknowledged alerts first, then newest), along with the enrollment time,
last check and any coverage problem. Checks drain a backlog in batches, so one
check is not a promise that every pending version has been processed.

| Observation                      | Evidence                                                                                                                            |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Approved bytes published         | Actual tarball bytes match a completed review with a recorded approval strictly before npm's publication timestamp.                 |
| Published without prior approval | The organization has no Drydock record of this release at all (no staged review or gate for that version), or only rejected others. |
| Published despite rejection      | Actual bytes match a review rejected before publication.                                                                            |
| Published different bytes        | The current approved review examined different bytes, and no review examined the published ones.                                    |
| Evidence unknown                 | Publication time, bytes, or review evidence could not establish an outcome; the observation records which.                          |

Unknown does not mean approved. Missing or future registry timestamps, unavailable
or oversized responses, invalid identities and incomplete legacy digests cannot
produce a matching approval. Reconfirming a staged decision after publication can
overwrite its prior decision timestamp; when current records cannot establish
that history, the monitor reports uncertainty instead of assuming no approval
ever existed. Observations describe the evidence available when checked, not a
complete immutable history of every decision, deleted review or registry event.

A Drydock record of the version that has not examined the published bytes is the
owner's own release path in flight, not a bypass, so it is `unknown` with a specific
reason rather than an alert: a review still pending or running (`review_pending`),
one that failed (`review_failed`), one completed without a decision whether it saw
these bytes (`reviewed_without_decision`) or others (`reviewed_other_artifact`).
Only a version with no Drydock record at all is published without approval, and that
verdict needs no bytes, so a tarball too large or too slow to hash cannot suppress it.
When the same version was staged again, whichever review examined the published bytes
decides; a review superseded by a newer stage never produces a mismatch on its own
(`review_superseded` when nothing else remains).

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

Observation, alert and audit creation commit together, and delivery follows. An alert
is marked notified only when a recipient or the Slack channel accepted it, or when the
organization has nowhere to deliver it (no resolvable recipient or email transport and
no connected Slack channel), which is logged because retrying cannot help. A delivery
that failed stays pending and is attempted again, once per check, on each later check
of the same watch until one lands. Only alerts in the watch's current observation
window are re-sent: after a stop and re-enrollment, an older window's alert is never
emailed, because the dashboard can no longer show or acknowledge it. The durable
dashboard alert remains available until the watch is stopped.

The organization `out-of-band-watch` flag disables acquisition and new alerts when
false, including manual checks. It defaults on without a FLAGS binding. Enrollment
and existing evidence remain accessible while disabled; each affected watch shows that
monitoring is switched off, and the sweep moves those watches to the back of its order
without spending any of its check budget.

This consolidates the out-of-band watcher proposed in PR #651 into one monitor.
No separate metadata-only poller, package-watch tables, or dashboard banner is needed.
Public npm is the production registry boundary. The monitor discovers releases that have
no gate and makes no public badge claim. It uses the npm published-tarball URL policy
but hashes bytes itself and never calls the gate's sandbox parser.

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

Published-pair reviews are not prior release authorization and are not records of
the release path. Late decisions never turn a publication into an
approval-before-publication match. Confirmed observations are retained. Unresolved
observations with a transient cause (a review in flight, a failed download) are
retried on each check; those no further check can resolve by itself (no decision,
late decision, missing review digest, a tarball over the hashing cap) are re-evaluated
once a day. A published version's bytes are immutable, so a re-evaluation reuses the
stored digests and never downloads the tarball again. Bytes are downloaded only for a
release the organization has a Drydock record of. The monitor does not rewrite scan
findings, risk, decisions, signed public reports, public badge identity, or Release
Receipt v1.

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
- `DELETE /api/v1/publication-watches/:id` (owner/admin only) stops monitoring, removes history,
  and remembers the opt-out.

Responses are private and not cacheable. The organization has a 20-watch limit.
Each 15-minute tick checks up to 24 due watches (last checked more than five minutes
ago), taken round-robin across organizations: every organization's oldest due watch
before any organization's second, so no organization gets more than its share and a
large one cannot slow the others. No new check starts after the first minute of the
sweep. A watch whose check throws is recorded (`check_failed`) and moved to the back of
the order rather than holding its place, and the sweep continues. One check examines up
to six pending versions, at most three of which may download a tarball; the rest
report a backlog and drain on later checks. A short database claim prevents
overlapping manual and scheduled checks from multiplying work on the same watch.
Metadata is capped at 4 MiB and tarballs at 16 MiB, with a five-second deadline
per response; an oversized or timed-out tarball is recorded on the watch and logged.
A package exceeding 10,000 versions or stored observations reports a history-limit
coverage problem rather than silently treating a partial history as complete.

Persistence lives in `publication_watches`, `publication_observations`, and
`publication_watch_candidates` (enrollment evidence and persistent opt-outs), and
`publication_alerts` (durable notification deduplication and acknowledgment).
`server/lib/ecosystems/npm/publication-auto-enrollment.ts` owns enrollment;
`server/lib/ecosystems/npm/publication-monitor.ts` owns acquisition, the sweep and
alert delivery; `server/lib/ecosystems/npm/publication-verdict.ts` owns comparison;
`server/routes/npm-publication-watches.ts` owns the authenticated API. The scheduled
handler (`server/scheduled.ts`) and the staged-review route reach the monitor only
through the `publicationMonitor` capability on the ecosystem registry. Operational
failures use safe codes through `emitOperationalEvent`, never raw registry errors.

The local fake-registry harness may use the existing explicitly enabled loopback
registry override. Production enrollment cannot select a registry URL. Tests cover
organization isolation, direct releases with no scan, prior decisions, actual
digest mismatch, missing evidence, bounded acquisition and the dashboard flow.
