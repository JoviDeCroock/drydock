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
public packages after verified staged admission claims them for the organization, before review runs.
Automatic enrollment also requires a package claim belonging to this organization and confirmed management when it is a personal workspace. Historical packages awaiting audit do not auto-enroll. Only stages from public npm qualify in production; private or unknown visibility,
custom registries, and published-pair reviews do not enroll packages. Completed npm
workflow gates supply suggestions that require **Watch package**, because a gate
alone does not establish public visibility.

Historical enrollment runs when the dashboard lists watches and in bounded cron
batches. It starts monitoring at enrollment time, never at the older review date;
older releases are not retrospectively reported as bypasses. The dashboard shows
where each watch came from and how many eligible packages await capacity at the
20-watch limit. Deferred packages enroll as slots become available.

You can also enter a public npm package name and choose **Watch package** without
an npm token or existing scan, provided the package is not claimed by another organization. A subscription never establishes ownership. Personal enrollment requires an explicit workspace choice; a provisional personal claim must be confirmed or moved before polling starts. If another organization subsequently claims the package, the existing watch becomes inactive and retains its observations; enrollment and manual checks return a conflict, and cron skips it. Duplicate enrollment preserves the original start
time. Removing a watch deletes its observations and persists an organization-scoped
opt-out, so later discovery or history reconciliation cannot silently restore it.
Because stopping hides unacknowledged alerts and opts the package out, only owners
and admins (the integration-management role) can stop a watch; any member can enroll
one. Stopping asks for confirmation first, saying what it removes and that alerts
already raised stay listed on the package's page. Explicitly enrolling it again
clears the opt-out and starts a new observation window. Both are recorded in the
audit log. A watch enrolled from a staged review (discovered, or submitted by hand)
is labelled "from a staged review".

The existing 15-minute cron checks watches independently of staged discovery.
**Check releases** runs a bounded check of one watch on demand (distinct from the
Recent reviews **Check npm**, which runs stage discovery). The dashboard displays the latest
100 observed versions for the selected watch (unacknowledged alerts first, then newest), along with the enrollment time,
last check and any coverage problem; each package links to its package page,
which shows the same watch, observations and controls for that package and says
why an unwatched package is not watched. Each observed release links to its public
diff against the published version it follows (recorded when observed), and to its
Drydock review when one exists. An empty list claims "no releases since enrollment"
only after a successful check; before one, or after a failed registry read, it says
releases are unknown. Checks drain a backlog in batches, so one
check is not a promise that every pending version has been processed.

A record of the version is a staged review or workflow gate of exactly that package
and version in this organization. A record identifies bytes by digest: the bytes
Drydock hashed while reviewing (the verified staged tarball, or the gate's tarball
by SHA-256 and, for gate reviews recorded since it was added, SHA-1), or npm's own
SHA-1 for the stage (its shasum, stored when the review is queued), which identifies
the staged bytes while the review is in flight, failed or unverified but never stands
in for an approval.

| Observation                                        | Evidence                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Approved bytes published                           | The published bytes match a review whose bytes Drydock hashed, approved strictly before npm's publication timestamp.                                                                                                                                                                                                                                                                  |
| Published despite a rejection in this organization | The published bytes match a record rejected before publication, or every decision on those bytes is a rejection, including one recorded only after publication (reason `rejected_after_publication`, worded "rejected after it was published").                                                                                                                                       |
| Published bytes differ from what this org reviewed | The published bytes match no record of the version, and some record of it was approved or rejected (at any time), or a stage of it was superseded by a restage.                                                                                                                                                                                                                       |
| Published with no approval in this organization    | No record of the version exists at all (decided without bytes); the published bytes match no record and none was decided or superseded; or they match only records nobody decided (in review, failed, or reviewed without a decision: reason `review_pending`, `review_failed` or `reviewed_without_decision`, and the alert links that review and asks for its decision).            |
| Evidence unknown                                   | A decision in this organization on the same bytes exists but cannot settle it: an approval recorded after publication (`decision_history_unavailable`), an approval matched only by npm's stage shasum (`review_digest_unavailable`) or by npm's `dist.shasum` when the tarball could not be hashed. Also a missing publication time, and bytes that could not be hashed or compared. |

`unknown` is earned only by a decision someone in this organization made about the
same bytes. An attacker who can stage can create records, including a record of the
very bytes they then publish directly, and npm reports a version as published the
same way whether it was promoted from a stage (which needs the maintainer's 2FA) or
published directly: its version status endpoint (`published`) and the packument carry
no stage reference, and stage records carry no outcome. So an undecided, pending or
failed review of the published bytes cannot tell the owner's release from a bypass,
and the release alerts as published with no approval. The alert says Drydock has an
undecided review of these exact bytes: decide it, or investigate if nobody here
published it. Likewise a record of other bytes (a benign seed stage, or a restage that
superseded the owner's approved stage) never turns an alert into `unknown`, and a
superseded approval with no approved replacement stays a mismatch. Decision timing
matters only when the bytes match: an approval of other bytes is a mismatch whether it
was recorded before or after publication. Beside an approval of the same bytes, a
decision recorded after publication leaves the verdict unknown, since reconfirming a
decision overwrites its timestamp and the overwritten one may have been newer.

A version's release records are staged reviews and workflow gates (published-pair
reviews are excluded in the query). Every decided record is read, up to 500, since
only people make decisions; undecided records, which anyone who can stage or run a
gate can create, are read newest first up to 100. With more, a byte match still
decides; without one the release alerts, with reason `review_history_limit` so the
message says only the latest 100 were compared. A flood of records, such as a gate
re-run many times for one version, can neither settle a release nor push a decision
out of view.

A gate review that carries SHA-256 is matched by SHA-256 alone when the bytes are
hashed; its SHA-1 is used only when they cannot be, so a SHA-1 collision cannot stand
in for bytes whose SHA-256 differs.

Tarballs are hashed as they stream, so memory stays flat: the cap is 256 MiB, and all
of a check's downloads share one 30-second deadline. When a tarball still cannot be
hashed (over the cap, timed out, unavailable) and every record that carries a digest
carries a SHA-1, npm's own `dist.shasum` from the packument identifies the published
bytes one-sidedly: the same rules as above apply, except that an approval then stays
`unknown` with the reason recorded, because the bytes were not independently hashed.
Gate reviews recorded before the gate hashed SHA-1 carry only SHA-256 and cannot be
compared this way, so such a release stays `unknown`. Either way an unhashed release
becomes a coverage gap (below). A version with no record is published without approval without any bytes, so
padding cannot suppress it. Unknown does not mean approved; observations describe the
evidence available when checked, not a complete immutable history of every decision,
deleted review or registry event.

Each observation also records which dist-tags pointed at the version at the latest
check (`dist_tags`, sorted; malformed tag names are dropped). Every check refreshes
them, settled observations included, and stamps the watch's `dist_tags_checked_at`, so
a consumer can tell which release line a version is on and how current that is. Up to
1,000 tags are read; when npm lists more, every observation's `dist_tags` is null
(unknown) rather than a partial list that would read as "not `latest`".

## Coverage gaps

A watch that cannot establish a verdict for a reason another check will not fix says
so rather than settling silently. Package-wide: npm's document is larger than Drydock
reads (`registry_metadata_too_large`), the package has more versions than it compares
(`publication_history_limit`), npm lists a version since enrollment that is not a
readable version string (`invalid_version_metadata`), or the document cannot be read
at all (`registry_evidence_unavailable`, recorded only when no other gap is, so an
outage never displaces or restarts one). The watch records the gap and since when,
and a check that reads the package again clears it. Per release: an `unknown`
observation whose tarball is too large, keeps timing out, cannot be downloaded, or is
not a valid npm tarball, so its bytes were never hashed here (at best npm's declared
shasum was compared). One hostile release cannot blind the watch to the others: the
package document parser skips fields it does not read without a depth limit, and an
overlong field it does read degrades only that field or version.
Once a gap has lasted an hour, the organization is told once per gap (per watch for a
package-wide reason, per release otherwise) through the same email and Slack delivery
as alerts, worded as a coverage notice: "Drydock could not verify <release> against
<organization>'s reviews: <reason>", never as a discrepancy. The dashboard card and
the package page show the gap, and each unverifiable release is marked "not verified".
A notice claim makes overlapping checks send it once; a failed delivery gives the
claim back for a later check. An outage shorter than an hour is shown as the watch's
last problem only.

## Alerts and acknowledgment

New confirmed discrepancies (no approval in this organization, publication despite a
rejection here, or bytes that differ from what this organization reviewed) create one
durable alert per organization/package/version. The message follows the observation's
reason: an undecided review of the published bytes asks for the decision first, and a
rejection recorded after publication says so. Every verdict and message is about
the alerting organization's own records only: another organization may have reviewed
or approved the same release, and Drydock neither says so (that would disclose one
organization's activity to another) nor words the alert as "unreviewed" or as an
accusation against whoever published it.
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
acknowledgment. Observation history still follows the watch's enrollment window; the
package page lists the latest 50 alerts from the ledger, with their acknowledgment,
split into those from earlier watch windows and older ones from the current watch that
its release list does not show, and says when older alerts exist beyond those 50. A
stop or re-enrollment never erases what was alerted.

Observation, alert and audit creation commit together, and delivery follows. The check
that creates an alert holds its delivery claim; any other check claims a pending alert
atomically before sending it, so a long check and an overlapping manual one cannot both
send it. A failed delivery releases the claim for the next check, and a claim older
than five minutes (a delivery that died) may be taken over. Recording the delivery in
the audit log never decides it: a notification a recipient accepted stays delivered
when that write fails. An alert
is marked notified only when a recipient or the Slack channel accepted it, or when the
organization has nowhere to deliver it (no resolvable recipient or email transport and
no connected Slack channel, or a Slack connection that fails permanently until it is
reconnected: revoked token, archived or missing channel), which is logged because
retrying cannot help. A delivery
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

Review lookup is organization-scoped, requires the exact package and version, and
reads every decided release record and the newest 100 undecided ones.
For staged reviews, registry coordinates must also match public npm, and an approval
counts only for bytes the review hashed itself (npm's stage shasum alone identifies the
bytes but cannot approve them). Staged reviews carry SHA-1, so their comparison
establishes continuity at that digest strength.
For npm workflow gates, the server-derived manifest and artifact digest supply
SHA-256 evidence, plus SHA-1 of the same bytes for gate reviews recorded since the
gate hashed it (`summary.stagedPublish.sha1`). An approval of identical gate bytes does not prove which
registry the workflow intended to publish to, successful callback delivery, or
ownership of the npm package.

Published-pair reviews are not prior release authorization and are not records of
the release path. Late decisions never turn a publication into an
approval-before-publication match. Confirmed observations are retained. Unresolved
observations with a transient cause (a failed download) are retried on each check;
those no further check can resolve by itself (late decision, missing review digest, a
tarball over the hashing cap) are re-evaluated once a day. A published version's bytes are immutable, so a re-evaluation reuses the
stored digests and never downloads the tarball again. Bytes are downloaded only for a
release the organization has a Drydock record of. The monitor does not rewrite scan
findings, risk, decisions, signed public reports, public badge identity, or Release
Receipt v1.

The public README badge reads these observations, and the alert ledger, for the
answering organization: a discrepancy for the version it quotes, or any
observation other than an approved match for another release the badge's
dist-tag now points at (by the recorded `dist_tags`), or for a newer release
on the quoted line (inferred from version shape), turns it grey as `<version>
not reviewed` instead of green. `unknown` about the quoted
version itself does not, unless its published bytes differ from the reviewed
ones. See
[`public-reports.md`](./public-reports.md#releasing-again-badge_package_key).

## API and operation

All endpoints require a Better Auth session and active-organization membership:

- `GET /api/v1/publication-watches` reconciles eligible packages and lists watches,
  with per-watch `unresolvedAlertCount`, `unverifiedReleaseCount`, `coverageGap` and
  `coverageGapSince`, plus `autoEnrollment.deferred` and opt-in `autoEnrollment.suggestions`.
- `POST /api/v1/publication-watches { "packageName": "@scope/package" }` enrolls.
- `GET /api/v1/publication-watches/:id` returns the watch and latest observations.
- `GET /api/v1/publication-watches/packages/:name` returns one package's watch (or
  `null`), its observations, the latest 50 ledger alerts (each with `inCurrentWatch`)
  and `moreAlerts`, why it is not watched when it is not, and whether the caller may
  stop it. It is read-only and never reconciles enrollment; the package
  page renders it.
- `POST /api/v1/publication-watches/:id/check` checks a bounded batch and returns
  current observations. Repeated checks are rate-limited. A check that fails after
  claiming the watch records `check_failed` on it, as a scheduled one does, and the
  response carries that state.
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
npm's full package document is read because only it carries per-version publish
times (the abbreviated install document omits them); it streams into just the fields
the verdict reads (`packument-stream.ts`), so memory stays flat, under a 64 MiB cap and
a 15-second deadline. Tarballs are capped at 256 MiB, and a check's downloads share
one 30-second deadline, so its reads end well inside its one-minute claim (alert
deliveries are claimed separately). Once a sweep (or a manual check) has read 1 GiB,
no new check or download starts, and the rest drain on later ticks. An oversized document is `registry_metadata_too_large`, distinct from a transient
`registry_evidence_unavailable`; an oversized or timed-out tarball is recorded on the
watch and logged. A package exceeding 10,000 versions or stored observations reports
`publication_history_limit` rather than silently treating a partial history as
complete. Both package-wide limits become coverage gaps.

Persistence lives in `publication_watches`, `publication_observations`, and
`publication_watch_candidates` (enrollment evidence and persistent opt-outs), and
`publication_alerts` (durable notification deduplication and acknowledgment).
`server/lib/ecosystems/npm/publication-auto-enrollment.ts` owns enrollment;
`server/lib/ecosystems/npm/publication-monitor.ts` owns acquisition and the sweep;
`server/lib/ecosystems/npm/publication-notices.ts` owns alert and coverage-notice
delivery; `server/lib/ecosystems/npm/publication-verdict.ts` owns comparison;
`server/routes/npm-publication-watches.ts` owns the authenticated API. The scheduled
handler (`server/scheduled.ts`) and the staged-review route reach the monitor only
through the `publicationMonitor` capability on the ecosystem registry. Operational
failures use safe codes through `emitOperationalEvent`, never raw registry errors.

The local fake-registry harness may use the existing explicitly enabled loopback
registry override. Production enrollment cannot select a registry URL. Tests cover
organization isolation, direct releases with no scan, prior decisions, actual
digest mismatch, missing evidence, bounded acquisition and the dashboard flow, and
the evasions this design closes: staging then publishing the same bytes, a rejection
after publication, a padded tarball beside a gate review, a flood of records, and an
oversized package document.
