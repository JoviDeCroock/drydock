# Publication monitor

Watches enrolled public npm packages for new published versions, hashes the published tarball, and compares it with the organization's own prior release decisions, so a direct publish shows up even when Drydock never saw a stage or a gate webhook. **Authority:** advisory (observation after publication). **Owner:** `server/lib/ecosystems/npm/publication-monitor.ts`.

It does not hold npm releases, establish package ownership, classify malware, or prevent the first install. Private packages and custom registries are not supported in production; public npm is the production registry boundary.

## At a glance

| Thing | Owner file | Pinned by |
| --- | --- | --- |
| Enrollment, reconciliation | `server/lib/ecosystems/npm/publication-auto-enrollment.ts` | `test/workers/publication-auto-enrollment.test.ts`, `test/workers/publication-enrollment-cron.test.ts` |
| Acquisition, sweep, limits | `server/lib/ecosystems/npm/publication-monitor.ts` | `test/workers/publication-monitor.test.ts`, `test/workers/publication-monitor-cron.test.ts` |
| Verdict | `server/lib/ecosystems/npm/publication-verdict.ts` | `test/publication-verdict.test.ts` |
| Alert and coverage-notice delivery | `server/lib/ecosystems/npm/publication-notices.ts` | `test/workers/publication-alerts.test.ts` |
| Post-release review, badge guard | `server/lib/ecosystems/npm/publication-review.ts` | `test/workers/publication-post-release-review.test.ts` |
| Authenticated API | `server/routes/npm-publication-watches.ts` | `test/workers/publication-watches-routes.test.ts` |
| Ecosystem capability | `server/lib/ecosystems/npm/publication.ts` | — |
| Persistence | `server/db/publication-watches.ts`, `server/db/publication-alerts.ts` | `test/publication-watches-model.test.ts`, `test/publication-alert-log-model.test.ts` |
| UI copy | `src/features/publication-monitor/copy.ts` | `test/publication-monitor-copy.test.ts` |

- Triggers: the `*/15` publication cron, **Check now**, stage submission, the discovery sweep, and **Watch package**.
- `server/scheduled.ts`, the staged-review route, and the decision route reach the monitor only through the `publicationMonitor` capability on the ecosystem registry.
- Tables: `publication_watches`, `publication_observations`, `publication_watch_candidates` (enrollment evidence, persistent opt-outs), `publication_alerts` (dedup, acknowledgment, post-release review and resolution; outlives a stopped watch).

## Contract

### Endpoints

All require a Better Auth session and active-organization membership. Responses are private and not cacheable.

| Method | Path under `/api/v1/publication-watches` | Role | Effect |
| --- | --- | --- | --- |
| GET | `/` | member | List watches in attention order; never enrolls |
| POST | `/` `{ "packageName": "@scope/package" }` | member | Enroll (201) |
| GET | `/alerts` | member | Log of unapproved publishes (latest 100); read-only |
| GET | `/:id` | member | Watch and latest observations |
| GET | `/packages/:name` | member | One package's watch or `null`; read-only, never reconciles |
| POST | `/:id/check` | member | Check one bounded batch; 10/min per organization |
| POST | `/:id/observations/:observationId/acknowledge` | member | Acknowledge; idempotent; audited |
| POST | `/:id/observations/:observationId/review` | as starting any review | Start or open the post-release review |
| DELETE | `/:id` | owner/admin | Stop, delete observations, persist opt-out |

- `GET /` fields per watch: `releaseCount`, `unresolvedAlertCount`, `unverifiedReleaseCount`, `coverageGap`, `coverageGapSince`; plus `autoEnrollment.pending` (fits; a later cron reconciliation enrolls it), `autoEnrollment.deferred` (over the limit), opt-in `autoEnrollment.suggestions`.
- `POST /` returns 409: `package_management_required` in a personal workspace without `confirmPersonalOrganization: true` or with a provisional claim; another organization holds the claim; watch limit reached.
- `GET /alerts` entries: `packageName`, `version`, `status`, `createdAt`, `acknowledgedAt`, `reviewScanId`, `resolution`, `resolvedAt`, `resolutionBadge`, `reviewedBytes`, `watched`; plus `moreAlerts`.
- `GET /packages/:name` also returns observations, the latest 50 ledger alerts (each with `inCurrentWatch`), `moreAlerts`, why it is not watched, and whether the caller may stop it. The package page renders it.
- `POST /:id/check` returns 409 while management is pending or the claim is elsewhere. A check that fails after claiming the watch records `check_failed`; the response carries it.
- `POST .../review` returns `{ scanId, started: true }` (202) or the linked one as `{ scanId, started: false }` (200). It uses the per-organization scan budget.
- `DELETE` requires `roleCanManageIntegrations`, because stopping hides unacknowledged alerts and opts the package out.
- Observations carry `reviewScanId`, `reviewStatus`, `reviewDecision`, `resolution`, `resolvedAt`, `resolutionBadge`, `reviewedBytes`. A linked scan's detail and decision responses carry `postRelease`. Deciding goes through `POST /api/v1/scans/:id/decision`.

### Enrollment

| Source | Result | UI label |
| --- | --- | --- |
| Completed staged review whose captured registry status confirms publication | Auto-enrolled | "added from a staged review" |
| Verified staged admission that claims the package (before review runs) | Auto-enrolled | "added from a staged review" |
| Published review history | Auto-enrolled | "added from your past reviews" |
| Completed npm workflow gate | Suggestion; needs **Watch package** | — |
| **Watch package** (any public npm name; no token or scan needed) | Manual watch | — |
| Private/unknown visibility, custom registry, published-pair review | Never enrolls | — |

- Automatic enrollment requires a package claim belonging to this organization, and confirmed management in a personal workspace. Historical packages awaiting the claims audit do not auto-enroll.
- A gate alone does not establish public visibility, which is why gates only suggest.
- Reconciliation runs in bounded per-organization batches when a stage is submitted, when the discovery cron sweeps the organization's npm connection (including sweeps that find no stages), and when the publication cron finds work waiting.
- The publication cron reconciles up to `RECONCILE_ORGANIZATIONS_PER_TICK` (20) organizations per tick, in random order, before it checks watches: those with eligible review history or unrecorded gate reviews, and those with an enrollable candidate and a free slot. This reaches organizations without an npm connection and fills slots freed by a stop.
- Finding those organizations walks every scan for review history each tick (nothing marks history as considered); a full organization's watches are counted once, not per deferred package; gate reviews are read through partial index `scans_workflow_gate_enrollment_idx`.
- Each reconciliation records up to `HISTORY_BATCH` (50) historical packages and enrolls up to `ENROLLMENT_BATCH` (50) watches (`publication-auto-enrollment.ts`).
- The organization limit is `PUBLICATION_WATCH_LIMIT` (250) in `server/db/publication-watch-limit.ts`. Deferred packages enroll at the next reconciliation after a slot frees.
- Discovery and staged admission enroll without computing the deferred-count/suggestion summary; dashboard reads compute it. Scheduled checks skip the decorated summary; manual checks load it once.

### Observation states

A **record** is a staged review or workflow gate of exactly that package and version in this organization. Published-pair reviews are never records. A record identifies bytes by digest:

- bytes Drydock hashed while reviewing: the verified staged tarball, or the gate tarball by SHA-256 (plus SHA-1 in `summary.stagedPublish.sha1` for gate reviews recorded since it was added);
- or npm's stage shasum, stored when the review is queued: it identifies staged bytes while a review is in flight, failed, or unverified, but never stands in for an approval.

| Status | UI label | Trigger | Alert? | Softened by |
| --- | --- | --- | --- | --- |
| `approved_match` | Approved bytes published | T1 | No | — |
| `published_despite_rejection` | Published despite a rejection in this organization | T2 | Yes | Post-release approval, `match` |
| `artifact_mismatch` | Published bytes differ from what this org reviewed | T3 | Yes | Post-release approval, `match` |
| `published_without_approval` | Published with no approval in this organization | T4 | Yes | Post-release approval, `match` |
| `undecided_low_risk` | Reviewed, no decision in this organization | T5 | Never | Any decision → `unknown` |
| `unknown` | Evidence unknown | T6 | No | — |

- **T1:** published bytes match a record whose bytes Drydock hashed, approved strictly before npm's publication timestamp.
- **T2:** bytes match a record rejected before publication, or every decision on those bytes is a rejection, including one recorded after publication (reason `rejected_after_publication`, "rejected after it was published").
- **T3:** bytes match no record, and some record of the version was approved or rejected (at any time), or a stage of it was superseded by a restage. A superseded approval with no approved replacement stays a mismatch.
- **T4:** no record of the version exists (decided without bytes); or bytes match no record and none was decided or superseded; or bytes match only undecided records that are in review (`review_pending`), failed (`review_failed`), or completed but not quiet (a tier reason below). The alert links that review and asks for its decision.
- **T5:** bytes match only completed undecided records, all graded low risk and able to vouch (see tiers). Recorded and shown, never an alert.
- **T6:** a decision in this organization on the same bytes exists but cannot settle it: approval recorded after publication (`decision_history_unavailable`); approval matched only by npm's stage shasum (`review_digest_unavailable`) or by `dist.shasum` when the tarball could not be hashed. Also `publication_time_unavailable`, and bytes that could not be hashed or compared (`artifact_unavailable`, `artifact_timeout`, `artifact_too_large`, `artifact_identity_invalid`).
- Any alerting status may carry `review_history_limit` when only the newest undecided records were compared.

### Undecided reviews are tiered by risk

Applies when the published bytes match only records nobody decided and the owning record (the one a restage did not supersede) has completed; pending and failed owners alert as `review_pending` / `review_failed`. `undecidedReviewTier` in `server/lib/ecosystems/npm/publication-verdict.ts` grades each matching record; the first matching row wins:

| Tier | When | Result |
| --- | --- | --- |
| AI flagged | AI `releaseAssessment` is `suspicious` or `blocked` | `ai_flagged_without_decision`, listed first |
| Not bound to the gate | `gateContinuity.status` not `none`/`matched` (e.g. `ungated`) | `reviewed_ungated_without_decision` |
| Release risk not low | `risk_summary_json.releaseRisk` is `medium`+ | `reviewed_risk_without_decision` |
| AI asked for a look | `review_recommended` / `requiresManualReview` | `reviewed_ai_concern_without_decision` |
| AI unfinished | AI review attempted, did not finish | `reviewed_ai_unfinished_without_decision` |
| New findings | `releaseConsistency.status` is `diverged` | `reviewed_diverged_without_decision` |
| Risk not graded | release risk unreadable, or `baseline.comparisonSkipped` | `reviewed_ungraded_without_decision` |
| Low risk | `low`; AI `nothing_unusual` and no manual review, or no AI ran | `undecided_low_risk` if vouched, else `reviewed_without_decision` |

- An AI-flagged matching record wins and is the review the alert links ("AI reviewer flagged a release published with no approval in <organization>"). Otherwise the alert names the owning record's first cause, or another matching record's when the owner reads low.
- Release risk decides, not artifact or context risk: those describe the whole package, which the owner has shipped before. `releaseRisk` already carries any AI escalation.
- **Vouched** means: every matching record completed; the match was on bytes Drydock hashed on both sides (the published tarball here and the reviewed tarball in the sandbox, never npm's shasum alone); no record of the version fell outside the history read; and no record of the version, of any bytes, was decided or superseded by a restage.
- AI review is advisory and only escalates: a deterministic medium alerts whatever the AI said. The organization `ai-review` flag (killswitch) is read at check time; without a FLAGS binding AI review counts as off, and a failed read counts as on. With it off the stored AI result is not read, so nothing is `ai_flagged_without_decision`.
- `undecided_low_risk` links its review. It is never emailed, posted to Slack, written to the ledger or audit log, or counted as unacknowledged, and has no **Acknowledge** or **Scan**: decide its review instead.
- Deciding any review of that version (singly, in a batch, or as a gate package) sets it to `unknown` (`decided_after_observation`); a check that read reviews before the decision landed writes that too. The next check re-reads stored digests: a rejection becomes `rejected_after_publication`, an approval `decision_history_unavailable`.

### Byte and decision binding

- **Collector:** sends no credentials. Metadata comes from the fixed public npm origin; tarball requests must stay on that origin; redirects are rejected. Bytes stream into SHA-256 and SHA-1 without extraction, install, or execution. It uses the published-tarball URL policy and never calls the gate's sandbox parser.
- **Packument:** the full document (only it carries per-version publish times; the abbreviated install document omits them), streamed into just the fields the verdict reads by `server/lib/ecosystems/npm/packument-stream.ts`. Unread fields are skipped without a depth limit; an overlong read field degrades only that field or version.
- **History read:** organization-scoped, exact package and version. Every decided record up to `DECIDED_HISTORY_LIMIT` (500); undecided records newest first up to `UNDECIDED_HISTORY_LIMIT` (100). Beyond that a byte match still decides; without one the release alerts with `review_history_limit` ("only the latest 100 were compared").
- **Staged reviews:** registry coordinates must match public npm. An approval counts only for bytes the review hashed itself. They carry SHA-1, so continuity holds at that digest strength.
- **Gate reviews:** the server-derived manifest and artifact digest supply SHA-256 (plus SHA-1 since `summary.stagedPublish.sha1`). A record with SHA-256 is matched by SHA-256 alone when bytes are hashed, so a SHA-1 collision cannot stand in. An approval of identical gate bytes does not prove the intended registry, callback delivery, or package ownership.
- **Unhashable tarball:** when every record carrying a digest carries SHA-1, npm's `dist.shasum` identifies the bytes one-sidedly; it can raise an alert, but an approval stays `unknown`. Gate reviews with only SHA-256 cannot be compared this way, so the release stays `unknown`. Either way it is a coverage gap.
- **No record:** `published_without_approval` without downloading, so padding or an oversized tarball cannot suppress it. Bytes are downloaded only for releases with a Drydock record or a started post-release review.
- **Dist-tags:** each observation stores `dist_tags` (sorted; malformed names dropped), refreshed every check including settled ones; the watch stamps `dist_tags_checked_at`. Over 1,000 tags, every `dist_tags` is null (unknown), never a partial list that would read as "not `latest`".
- **Re-evaluation:** transient unknowns (a failed download) retry every check. `decision_history_unavailable`, `review_digest_unavailable`, and `artifact_too_large` re-evaluate once a day (`SETTLED_RECHECK_MS`) from stored digests, never a new download. Confirmed observations are retained.

### Coverage gaps

| Scope | Reason | Meaning |
| --- | --- | --- |
| Package | `registry_metadata_too_large` | packument over `METADATA_LIMIT` |
| Package | `publication_history_limit` | over 10,000 versions or stored observations (`MAX_VERSIONS`) |
| Package | `invalid_version_metadata` | a version since enrollment is not a readable version string |
| Package | `registry_evidence_unavailable` | packument unreadable; only when no other gap is recorded |
| Release | `unknown` artifact reason | tarball too large, timing out, unavailable, or invalid |

- The watch records the gap and since when; a check that reads the package again clears a package-wide gap. An outage never displaces or restarts another gap.
- The dashboard card and package page show the gap; each unverifiable release reads "not verified".
- After `COVERAGE_GAP_AFTER_MS` (1 hour, `server/db/publication-watches.ts`) the organization is told once per gap (per watch for package-wide, per release otherwise) via alert email and Slack: "Drydock could not verify <release> against <organization>'s reviews: <reason>". It is never worded as a discrepancy. A notice claim makes overlapping checks send it once; a failed delivery gives the claim back.
- An outage shorter than an hour shows only as the watch's last problem.

### Alerts and acknowledgment

- Discrepancies (`published_without_approval`, `published_despite_rejection`, `artifact_mismatch`) create one durable alert per organization/package/version. Observations that predate alert support are never announced; those recorded before tiering keep `reviewed_without_decision` and are not rewritten.
- Wording follows the reason: an undecided review asks for the decision first; an AI-flagged one asks to investigate first; a rejection after publication says so. The release list and ledger mark AI-flagged releases ("flagged by the AI reviewer") and sort them ahead of other open alerts.
- Every verdict concerns the alerting organization's own records only. It never says another organization reviewed or approved the release (that would disclose one organization's activity to another), and never words the alert as "unreviewed" or as an accusation against the publisher.
- Delivery goes to configured email recipients (owner fallback) and the connected Slack channel. Observation, alert, and audit rows commit together; delivery follows.
- The creating check holds the delivery claim; other checks claim a pending alert atomically. A failed delivery releases the claim; a claim older than `ALERT_DELIVERY_LEASE_MS` (5 minutes, `publication-notices.ts`) may be taken over.
- An alert is marked notified only when a recipient or Slack accepted it, or the organization has nowhere to deliver (no resolvable recipient or email transport and no Slack, or a Slack connection failing permanently until reconnected: revoked token, archived or missing channel), which is logged. A failed audit write never un-delivers an accepted notification.
- A failed delivery stays pending and retries once per check of the same watch, only within the watch's current observation window: an older window's alert is never re-sent.
- Any member can acknowledge (audited `publication.acknowledged`); evidence is unchanged. Watch rows count only unacknowledged alerts in the current window.
- The ledger survives a stop: re-enrolling cannot resend a notification or erase an acknowledgment. It reads the reason from the current watch's observation; an earlier window's alert reads by status alone.
- The creating check emits `npm.publication_monitor.unapproved_publish` (warn; organization and watch ids, package, version, verdict, reason) through `emitOperationalEvent`, alongside the `publication.discrepancy` product event.

### The log of unapproved publishes

- The dashboard card ends with **Unapproved publishes**: every ledger alert across watched and formerly watched packages, newest first, latest 100, with a note when older exist.
- Each entry: `<package>@<version>` linking to the package page, verdict, post-release decision, when raised, when decided, whether an open alert was acknowledged, whether still watched.
- It reloads after a check, acknowledgment, enrollment, stop, or reviews-list change (a post-release decision is one), not on row expand.
- `unknown` evidence is never an entry. Acknowledge or **Scan** from the release list.

### Reviewing an alert after release

1. **Scan** (beside **Acknowledge** on the card and package page) starts the same published-pair review `POST /api/v1/scans` starts: the observed version against the predecessor the monitor recorded. The scan id is stored on the alert; a second Scan opens it. A failed review can be deleted on its page, which unlinks it. Audited `publication.review_started`.
2. A release with no Drydock record was decided from metadata alone. Starting the review hashes its bytes now with the same credential-free bounded collector and killswitch, filling only digests the observation never recorded; the decision retries once if that has not landed. The observation's status and reason are never touched.
3. The review page's Decide dialog (diff first) reads "Decision after release". The outcome is recorded on the alert (audited `publication.review_resolved`); re-deciding updates it. Every decision records `reviewed_bytes`: `match`, `differ`, or `unavailable`.

| Decision | `reviewed_bytes` | Alert |
| --- | --- | --- |
| Approve after release | `match` | Resolved: not unacknowledged, sorted with settled, not re-sent |
| Approve after release | `differ`, `unavailable` | Recorded; stays open, counted, emailed; page says why |
| Decline after release | any | Stays open, labelled declined after release |

- Decline next steps shown: deprecate or unpublish the version on npm, rotate tokens that can publish it, check its trusted publishers and who holds publish rights.
- The observation keeps its historical verdict; the post-release outcome sits beside it on the alert.

The badge counts the decision only when all checks pass; the alert records the result as `resolution_badge`:

| `resolution_badge` | Meaning |
| --- | --- |
| `applied` | all checks passed |
| `not_a_verified_publisher` | organization is not a registry-verified publisher of that exact name |
| `not_public_npm` | monitor or review did not read the release from public npm |
| `digests_unavailable` | digests could not be compared, including when the two sides share no algorithm |
| `digests_differ` | an algorithm both sides carry disagrees |

- Registry-verified publisher: holds the [package claim](./package-claims.md) and has a completed staged review of a public-npm stage its own token could read, under npm's name (the badge off-switch rule).
- Otherwise the decision speaks for the organization alone.

### Badge inputs

Badge rendering is owned by [`public-badge.md`](./public-badge.md). What the monitor feeds it, for the answering organization:

- A registry-verified publisher's badge reads `<version> published without approval` (orange) or `<version> rejected` (red; rejected before or after publication) until the release is decided after it shipped.
- A discrepancy for the quoted version, or any non-`approved_match` observation for another release the badge's dist-tag now points at (by `dist_tags`) or a newer release on the quoted line (by version shape), turns it grey `<version> not reviewed`.
- `unknown` about the quoted version does not, unless its bytes differ from the reviewed ones. `undecided_low_risk` never turns it orange.
- A guarded post-release approval clears that version's discrepancy or supersession; a decline reads `<version> rejected`.

### Dashboard behavior

- Watches list 25 at a time (`WATCH_PAGE_SIZE` in `src/models/publication-watches.ts`): unacknowledged alerts first, then unverified releases or a coverage gap, then the rest, newest first within each.
- The selected watch shows its latest 100 observed versions (unacknowledged alerts first, then newest), enrollment time, last check, release count, and coverage problem. Each release links its public diff against the predecessor recorded when observed, and its Drydock review when one exists.
- "No new releases" appears only after a check that finished with no problem; before any check, "has not run"; after a problem, "no releases are recorded yet" plus what is unknown. One check drains a batch, not every pending version.
- **Check now** checks one watch; Recent reviews **Check npm** runs stage discovery.
- Stopping asks for confirmation, saying what it removes and that raised alerts stay listed on the package page. The package page lists the latest 50 ledger alerts, split into earlier-window alerts and older current-window ones the release list does not show.
- The package page reports automatic enrollment as pending only for packages the organization manages; others show as not enrolled, with why.

### Sweep limits

Constants live in `publication-monitor.ts`.

| Limit | Constant |
| --- | --- |
| 24 due watches per tick, round-robin across organizations | `SWEEP_WATCH_BUDGET` |
| Due when last checked over 5 minutes ago | `WATCH_DUE_AFTER_MS` |
| No new check after the sweep's first minute | `SWEEP_DEADLINE_MS` |
| 6 pending versions per check, at most 3 downloads | `RELEASES_PER_CHECK`, `TARBALLS_PER_CHECK` |
| 1-minute check claim (`check_in_progress`) | `CLAIM_LEASE_MS` |
| Packument 64 MiB, 15 seconds | `METADATA_LIMIT`, `METADATA_DEADLINE_MS` |
| Tarball 256 MiB; one shared 30-second download deadline per check | `TARBALL_LIMIT`, `DOWNLOAD_BUDGET_MS` |
| 1 GiB read per sweep or manual check | `SWEEP_BYTE_BUDGET` |
| 10,000 versions or stored observations | `MAX_VERSIONS` |

- Round-robin: every organization's oldest due watch before any organization's second, so a large organization cannot slow others; 250 watches take about eleven ticks.
- Remaining versions report a backlog and drain on later checks. After the byte budget, no new check or download starts.
- A watch whose check throws records `check_failed`, moves to the back of the order, and the sweep continues.

## Invariants

1. Only a decision someone in this organization made about the same bytes earns `unknown` or `approved_match`; an undecided, pending, or failed record never does (`publication-verdict.ts`, `test/publication-verdict.test.ts`).
2. A record of other bytes (a benign seed stage, a superseding restage) never turns an alert into `unknown`; decision timing matters only when the bytes match.
3. Beside an approval of the same bytes, a decision recorded after publication leaves the verdict `unknown`, because reconfirming overwrites the timestamp.
4. Late decisions never become an approval-before-publication match. Published-pair reviews, including one started from an alert, are never release records, so a post-release decision cannot settle or suppress a later observation. Only the linked review resolves an alert.
5. A subscription never establishes ownership, and another organization's claim never stops it. A claim deactivates only the watch of an organization holding its own staged reviews while another organization (or an ownerless reservation) holds the claim; that watch keeps its observations, returns 409 on enroll/check, is skipped by cron, and stops counting toward the limit.
6. Monitoring starts at enrollment time; older releases are never reported as bypasses. Duplicate enrollment preserves the original start time.
7. Stopping deletes observations and persists an organization-scoped opt-out that discovery and history reconciliation honor; explicit re-enrollment clears it and starts a new window. Both are audited (`publication_watch.started`, `publication_watch.stopped`).
8. Personal-workspace enrollment requires an explicit workspace choice; **Watch package** there is that choice. A provisional personal claim must still be kept or moved before polling; the package page offers that choice instead of **Watch package** and hides it while another organization holds the claim ([package-claims.md](./package-claims.md)).
9. A running check, or one killed before recording an outcome, never reads as clean (`check_in_progress`).
10. `unknown` never means approved. Observations describe evidence available when checked, not an immutable history of decisions, deleted reviews, or registry events.
11. The monitor never rewrites scan findings, risk, decisions, signed public reports, public badge identity, or Release Receipt v1.
12. Operational failures use safe codes through `emitOperationalEvent`, never raw registry errors.
13. Production enrollment cannot select a registry URL; only the local fake-registry harness may use the explicitly enabled loopback override (`server/lib/ecosystems/npm/publication-registry.ts`).
14. The organization `out-of-band-watch` flag, when false, disables acquisition and new alerts, including manual checks; it defaults on without a FLAGS binding. Enrollment and evidence stay accessible; affected watches say monitoring is off; the sweep moves them to the back without spending check budget.

## Failure modes

| Symptom | Cause | What happens | Fix |
| --- | --- | --- | --- |
| Releases marked "not verified" | tarball too large, slow, unavailable, invalid | `unknown`, logged; notice after 1 hour | transient causes retry each check |
| Package-wide coverage gap | oversized packument, version cap, bad version, outage | gap with `since`; notice after 1 hour | clears on next successful read |
| 409 on check, watch inactive | another organization manages the package | observations kept; cron skips | resolve the claim |
| 409 `package_management_required` | personal workspace, no management choice | not enrolled or polled | keep or move on the package page |
| 409 on enroll | 250-watch limit | not enrolled | stop a watch |
| Alert retried every check | transient delivery failure | stays pending | fix recipients or Slack |
| Notified, nobody received it | nowhere to deliver | logged; no retry | add recipients or reconnect Slack |
| `review_history_limit` alert | over 100 undecided records, no byte match | alert names the limit | decide the relevant review |
| `check_failed` | check threw | back of sweep order | **Check now** |

## Change checklist

- Verdict or tier rule → state and tier tables here, `src/features/publication-monitor/copy.ts`; run `pnpm exec vitest run --project node test/publication-verdict.test.ts test/publication-monitor-copy.test.ts`.
- New observation reason or status → copy, alert wording in `server/lib/notify/publication-alerts.ts`, badge evidence in `server/db/badge-publication-evidence.ts`, and [`public-badge.md`](./public-badge.md).
- Endpoint or role change → endpoint table, `test/workers/publication-watches-routes.test.ts`, and [`security-model.md`](./security-model.md) if authority changes.
- New limit → add its constant to the limits table; never inline a number without it.
- Tests must keep covering organization isolation, direct releases with no scan, prior decisions, digest mismatch, missing evidence, bounded acquisition, the dashboard flow, and the closed evasions: stage then publish the same bytes, rejection after publication, a padded tarball beside a gate review, a flood of records, an oversized package document.

## Why

- Stage records carry no outcome, and npm reports a promoted stage (needs the maintainer's 2FA) and a direct publish identically (`published`; the packument has no stage reference). An attacker who can stage can create a record of the very bytes they then publish, so an undecided review cannot tell the owner's release from a bypass.
- Most maintainers approve on npm and never decide in Drydock, so alerting on every low-risk undecided review was unacknowledged noise. Accepted cost: a bypass publish of bytes Drydock graded low risk with a clean AI review raises nothing; an attacker can stage variants under fresh versions until one grades low (restaging one version supersedes, which alerts). Every non-low or AI-flagged release still alerts.
- Letting the first claimant silence other organizations' monitoring would let a stolen stage-read token mute the monitor right before a malicious publish.
- Bounded history (500 decided, 100 undecided) means a flood of records, such as a gate re-run many times, can neither settle a release nor push a decision out of view.
