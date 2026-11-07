# Registry version status

Reads npm's per-version lifecycle status for completed staged reviews, so Drydock can show whether npm is validating, blocked, or published a release and whether an approval here took effect. **Authority:** advisory (never feeds risk, findings, or a gate decision). **Owner:** `server/lib/ecosystems/npm/release-outcome.ts`.

The separate [publication monitor](./publication-monitor.md) watches enrolled public packages for published versions even when no stage scan exists.

## At a glance

| Thing | Owner file | Trigger | Pinned by |
| --- | --- | --- | --- |
| Status lookup (never throws) | `server/lib/ecosystems/npm/version-status.ts` | sweep, failure refinement | `test/npm-version-status.test.mjs` |
| Sweep, notice, reminder | `server/lib/ecosystems/npm/release-outcome.ts` | discovery cron `*/15`, **Check npm** | `test/workers/registry-version-status.test.ts` |
| Failure refinement | `server/lib/scan/job.ts` (`refineStagedFailure`) | scan fails with `staged_tarball_unavailable` | `test/scan-job.test.mjs` |
| Badge, notice, phrase | `src/features/registry-status.ts`, `src/pages/Dashboard/ScanDetail/RegistryStatusNotice.tsx` | render | `test/registry-status-notice.test.ts` |
| Release timeline | `src/pages/Dashboard/ScanDetail/release-timeline.ts` | render | `test/release-timeline.test.ts` |
| Published-no-decision filter | `publishedWithoutDecisionConditions` in `server/db/scan-query.ts` | list, package view | — |
| Overview strip | `server/db/scan-overview.ts` | dashboard | — |
| Export | `server/lib/scan/report-export.ts` | `report.json` | — |

## Contract

### npm endpoint

```
GET /-/package/{package-name}/version/{version}/status
Authorization: Bearer <npm token>
→ { packageName, version, status }
```

- `status` is one of `published`, `validating`, `staged`, `blocked`, `deleted`.
- npm reports progress "without exposing validation-system details": `blocked` says the version failed npm's validation, never which check or why.
- npm answers `404` both for a missing version and for one the token may not ask about; it documents `429`. Every failure collapses to "unknown".
- The spec says the caller "must have publish access to the package". Drydock keeps its read-only granular token ([security-model.md](./security-model.md)); if that token cannot ask, the feature degrades to "no status" everywhere. Do not widen the requested token scope to make it work.

### Status → action and UI

`registryStatusBadge` names npm in every label and reads a published version against the decision recorded here. Tone is set only when the state asks something of the reader.

| npm status | Drydock decision | Badge label | Tone | Notice row | Leaves **Undecided** | Reader action |
| --- | --- | --- | --- | --- | --- | --- |
| null / undocumented | any | none | — | none | no | — |
| `validating` | any | npm validating | none | yes | no | wait for npm's scan |
| `staged` | none / `no_publish` | none | — | none | no | normal resting state |
| `staged` | `publish` | npm awaiting approval | medium | yes | — | run `npm stage approve` |
| `blocked` | any | npm blocked | critical | yes | yes | nothing to approve; bytes are gone |
| `published` | `publish` | npm published | none | none | — | — |
| `published` | none | npm published, no decision | medium | none | yes | record a decision for the audit trail |
| `published` | `no_publish` | npm published, rejected here | critical | none | — | investigate |
| `deleted` | none | npm removed, no decision | medium | none | yes | — |
| `deleted` | `no_publish` | npm removed, published, rejected here | critical | none | — | investigate |
| `deleted` | `publish` | npm removed | none | none | — | — |

- A superseded review renders no status.
- Once npm reports `published`, `blocked`, or `deleted`, the stage is no longer actionable: a later Drydock decision is still accepted for the audit trail but offers no npm follow-up.
- **Published with no decision in this organization** (filter and package-view counts) includes `published` and subsequently `deleted` releases with no decision, including a manual scan that failed because npm published before the review read the tarball. `blocked` is excluded: it never went live.
- The overview strip counts null only as "not settled" alongside `staged` and `validating`; never as its own tile.
- Public share links, threat-feed listings, and the badge serve a staged review only once npm reports `published` (or `deleted` after publishing); an unresolved lookup keeps them dark ([public-reports.md](./public-reports.md#share-flow)).

- **Dashboard list:** Toned chip on the row's lead line; otherwise plain text at the end of the mono meta line; the published-no-decision filter.
- **Scan workbench header:** Plain-text metadata line with observation time; `RegistryStatusNotice` adds a row only for validating, blocked, or awaiting approval after an approval here.
- **Package release view (`/dashboard/packages/:name`):** State and observation time per release; highlights published-no-decision and published over `no_publish`.
- **Release timeline (scan detail):** Dated events oldest first with the gap to the previous row (below).

### Sweep

| Setting | Value | Constant (`release-outcome.ts` unless noted) |
| --- | --- | --- |
| On-demand lookups per organization per invocation | 16, concurrency 4, via `waitUntil` | `LOOKUPS_PER_SWEEP`, `LOOKUP_CONCURRENCY` |
| Cron lookups per organization | 8, concurrency 1, awaited | `lookupLimit`/`lookupConcurrency` in `staged-publishes-discovery.ts` |
| Organizations swept in parallel by cron | 5 | `DISCOVERY_CRON_CONCURRENCY` in `server/scheduled.ts` |
| Lookup timeout | 5 seconds | `LOOKUP_TIMEOUT_MS` in `version-status.ts` |
| Recheck: never asked, `validating` | 5 minutes | `PENDING_RECHECK_MS` |
| Recheck: `staged` | 1 hour | `STAGED_RECHECK_MS` |
| Recheck: `published` (may become `deleted`) | 24 hours | `PUBLISHED_RECHECK_MS` |
| Recheck: `blocked`, `deleted` | never (terminal) | — |
| Age cutoff after the first attempt | 30 days | `MAX_RELEASE_AGE_MS` |
| Forgotten-approval delay | 6 hours | `FORGOTTEN_APPROVAL_DELAY_MS` |

- Four worst-case five-second on-demand waves leave headroom inside Workers' 30-second `waitUntil` lifetime for persistence and delivery. Cron awaits a smaller serial slice so the sweep's organization concurrency also bounds status traffic.
- Every never-attempted review gets one lookup regardless of age. Recent work drains before that legacy backlog. Within each age tier, due rows share one oldest-work timeline (creation time until the first lookup, then last-attempt time), so new arrivals cannot starve rechecks.
- Only npm staged-publish scans are eligible. Workflow-gate scans are excluded (their coordinates may be PyPI or VS Code); published-pair scans are never selected.
- Status failures never fail discovery.
- After queueing, the dashboard refreshes immediately, then a bounded set of follow-up refreshes while `waitUntil` lookups finish.

### Failure codes

`refineStagedFailure` only narrows `staged_tarball_unavailable`, and only for non-gate scans:

| npm status | Code | Meaning |
| --- | --- | --- |
| `published` | `staged_release_published` | Approved and published before the review could read it |
| `deleted` | `staged_release_deleted` | Published, then removed before the review could read it |
| `blocked` | `staged_release_blocked` | npm's validation rejected it; the staged bytes are gone |
| `staged` / `validating` / unresolved | `staged_tarball_unavailable` | Still there and unreadable: a genuine token-scope problem |

- Auto-discovered candidates in every case are discarded rather than shown as failures; the recorded `reason` says which.
- Failed scans are not swept. They persist only terminal `blocked`/`deleted` statuses; a `published` lookup stays in the refined message. The list derives a settled outcome from the safe failure code for filtering without showing it as a fresh status badge.
- Refinement rechecks ownership after its registry request, so a concurrent restage cannot attribute the replacement stage's outcome to the older scan.

### Notifications

- **Approvable-now** ("ready to approve", email + Slack): fires when a lookup observes `staged` after a persisted `validating` or no persisted status (so a review that completed after npm settled is told on its first lookup). Marker `registry_approvable_notified_at`. Carries package, version, release-risk grade, finding count, Drydock decision if any, dashboard link, registry-pinned `npm stage approve`.
- **Forgotten-approval reminder** (email): once per registry release when the decision is `publish`, npm still reports `staged` (not `validating`: that is npm working, not a human forgetting), the decision is at least 6 hours old, and the marker is unset. Marker `registry_publish_reminder_at`. Carries release identity, stage id, `npm stage approve --registry <captured-registry>`, dashboard link.

- Neither carries a token, header, or package bytes.
- Each marker is claimed before sending, only if the observation (and, for the reminder, the approval) it acted on is still current; overlapping sweeps and duplicate reviews of the same stage id send once.
- A `staged` recheck of a row already persisted as `staged` is not a transition: rows predating the notice are never announced.
- If both would fire in one sweep, the notice (which carries the approve command) is sent and the reminder keeps its marker for a later sweep.
- Never for `published`, `blocked`, `deleted`, superseded, workflow-gate, or published-pair scans.
- The workbench shows the awaiting-approval state immediately; the 6-hour delay gates only the email.
- Approval commands are pinned to the registry URL captured with the scan, including custom registries. The npmjs.com staged-packages shortcut appears only for scans captured from public npm.

### Release timeline

Scan detail lists every dated event oldest first, with the gap to the previous row:

| Row | Source |
| --- | --- |
| Staged on npm | `staged_created_at` (`0031`); fallback `summary.stagedPublish.createdAt` |
| Review queued / started / completed | scan row |
| npm status last observed | `registry_version_status_at`, phrased by `registryStatusPhrase`: validating, awaiting approval, published, blocked, removed |
| Published on npm | `registry_published_at` (`0044_eager_tombstone`): npm's own publication time, when the [publication monitor](./publication-monitor.md) observed the release |
| Drydock decision | scan row |
| Supersession | `registry_status_superseded_at` (replaces the stale status row and any publication row: a superseded review did not review the published stage) |

- `staged_created_at` is captured from the stage record when the review row is created (and carried by the status poll), so queued and failed reviews show it too.
- Report views are analytics ([report views](./product-analytics.md#report-views)) and are not listed.
- A null or undocumented status renders no row. Stamps carry year and seconds: rows are often seconds apart and a stage can straddle a year.

### Storage

| Column on `scans` | Migration | Meaning |
| --- | --- | --- |
| `registry_url` | `0027` | Registry captured at scan creation; legacy null fails closed, not polled |
| `registry_package_name`, `registry_version` | `0027` | Immutable control-plane coordinates; legacy null fails closed, not polled |
| `registry_version_status` | `0027` | Last known npm status, or null |
| `registry_version_status_at` | `0027` | When npm last returned it |
| `registry_version_status_attempted_at` | `0027` | Last lookup, set even on failure; throttle and overlap fence |
| `registry_status_superseded_at` | `0027` | A newer scan owns this registry/package/version lifecycle |
| `registry_publish_reminder_at` | `0027` | Reminder send-once marker |
| `registry_approvable_notified_at` | `0030` | Approvable-now send-once marker |
| `staged_created_at` | `0031` | Stage creation time for the timeline |
| `registry_published_at` | `0044_eager_tombstone` | npm's publication time for the version (packument `time[version]`), stamped on this organization's live staged reviews matched by the immutable registry coordinates and the stage's SHA-1 against the published bytes, when its [publication monitor](./publication-monitor.md) observes the release. Null when no watch saw the release; the status columns then only bound publication from above |

`report.json` carries `registryStatus: { status, observedAt } | null`, additive and optional, with no schema bump (`drydock.report.v2`'s bump was for a removal).

## Invariants

1. `fetchNpmVersionStatus` never throws and never returns a status it did not read for the requested package and version; mismatched coordinates and unrecognized values are unknown (`version-status.ts`).
2. An unresolved first lookup persists only `registry_version_status_attempted_at` and leaves status null; an unresolved recheck keeps the last status npm returned and its timestamp.
3. Null renders nothing: no badge, no notice, no reassurance (`registryStatusVariant`, `RegistryStatusNotice`).
4. Status writes are fenced by the attempt timestamp, so an older overlapping sweep cannot replace a newer answer.
5. Lookups use the registry URL and registry-supplied coordinates captured on the scan, never the tarball manifest or the current connection, so hostile bytes or a connection edit cannot retarget the credentialed lookup.
6. Queued scans carry the captured registry into the credential broker; if the organization's connection changes before or during the scan, every staged, detail, and baseline request fails closed.
7. If the pre-queue detail read failed and the worker later recovers the stage record, it fills missing coordinates and reconciles ownership before persisting; recovered coordinates that disagree with the captured identity fail the scan.
8. Within one registry only the newest scan of a package/version owns status: duplicates get one owner and one reminder; a restage under a new stage id supersedes the old one.
9. Supersession clears displayable status and retires any public report capability, badge, or threat-feed listing for the obsolete stage. Superseded reviews cannot accept decisions; they stay under **All** but leave **Undecided**. Deleting a failed newer scan cannot revive historical stage ids. The reminder marker stays on superseded rows as send-once history.
10. Completed reviews with no decision leave **Undecided** once npm reports `published`, `blocked`, or `deleted` (or a terminal failure proves it), stay under **All**, and still accept a decision. Failed reviews are read-only history.
11. Discovery creates the new scan row before scheduling status resolution and passes current stage ids as a fail-closed race guard.

## Failure modes

| Symptom | Cause | What happens | Fix |
| --- | --- | --- | --- |
| No status anywhere | token cannot ask (404), or 429 | status stays null; UI silent | measure against a real read-only token; never widen scope |
| "Token may have expired" on a working token | stage approved before the scan read the tarball | refined to `staged_release_published` | none; the release shipped |
| Approved here, never shipped | nobody ran `npm stage approve` | badge "npm awaiting approval"; reminder after 6 hours | run the pinned command |
| Old review shows no status | superseded by a restage | status cleared; supersession row | open the newer review |
| Legacy review not polled | null registry coordinates | fails closed | none |

## Change checklist

- New status or label → `src/features/registry-status.ts`, the status table here, `test/registry-status-notice.test.ts`.
- Sweep limits → constants table; check the `waitUntil` budget arithmetic.
- New column → migration via `pnpm db:generate`, the storage table, `report-export.ts` if exported.
- Public-visibility rule → [public-reports.md](./public-reports.md#share-flow).

## Why

- npm's validation verdict is otherwise invisible: a clean Drydock report says nothing about npm having `blocked` or still `validating` the version.
- Approving in Drydock publishes nothing; the common failure is approving here and never running `npm stage approve`.
- An unreadable staged tarball is usually a shipped release, not a bad token; telling a maintainer to rotate a working token is the failure this removes.
- Unverified: npm's enforcement of "publish access" may be looser than the spec, since read-only tokens already work against `/-/stage`; measure before relying on the signal.
