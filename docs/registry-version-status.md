# Registry version status

npm knows two things about a staged release that Drydock cannot derive from the
staged tarball: whether its own automated validation has cleared the version,
and what eventually happened to the stage. Both are read from a single endpoint:

```
GET /-/package/{package-name}/version/{version}/status
Authorization: Bearer <npm token>
→ { packageName, version, status }
```

`status` is one of `published`, `validating`, `staged`, `blocked`, `deleted`.
npm reports progress "without exposing validation-system details", so `blocked`
says the version failed npm's validation, never which check or why.

## Why it exists

- **npm's validation verdict is invisible otherwise.** A reviewer reading a
  clean Drydock report has no way to see that npm has `blocked` the same
  version, or is still `validating` it. It is an independent signal, not an
  input to ours: it never feeds risk, findings, or a gate decision.
- **Approving in Drydock does not publish anything.** The organization's
  `decision` records what it decided; nothing recorded whether that took effect.
  The common failure is mundane — someone approves here, never runs
  `npm stage approve <stage-id>`, and the release silently never ships.
- **A staged tarball we cannot read is usually not a token problem.** A stage
  approved seconds after discovery queued its scan returns 404 on the tarball,
  which used to surface as "the npm token may have expired, or its scope may not
  cover this package". Telling a maintainer to rotate a working token because
  their publish succeeded is the failure mode this removes.

## Absence is not a verdict

npm answers `404` for a version that does not exist **and** for one the token
may not ask about, and the endpoint documents `429`. Every failure mode
therefore collapses to "we do not know":

- `fetchNpmVersionStatus` never throws and never returns a status it did not
  read for the requested package and version; mismatched coordinates and
  unrecognized enum values are treated as unknown rather than passed through.
- An unresolved first lookup persists only
  `registry_version_status_attempted_at` (so the next sweep is throttled) and
  leaves `registry_version_status` null. An unresolved recheck preserves the
  last status npm actually returned and its observation timestamp.
- The UI renders nothing for a null status — no badge, no notice, no
  reassurance. `RegistryStatusNotice` and `registryStatusVariant` own that rule.
- A `staged` status with no decision recorded also renders nothing: that is the
  normal resting state of a release under review.

## Where it runs

| Path                                      | Trigger                                                             | What it does                                                                                                                                                                                                                                        |
| ----------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/ecosystems/npm/release-outcome.ts`   | discovery sweep (cron `*/15`, and the on-demand "Check npm" button) | Resolves status for completed reviews and sends the forgotten-approval nudge. On-demand checks use `waitUntil`; cron awaits a smaller, serial-per-org slice so its five-organization cap also bounds status traffic. Failures never fail discovery. |
| `lib/scan/job.ts` → `refineStagedFailure` | a scan failing with `staged_tarball_unavailable`                    | Asks npm what happened before deciding the message.                                                                                                                                                                                                 |

On-demand lookups are bounded per organization per invocation (16, concurrency
4), so four worst-case five-second waves leave headroom inside Workers'
30-second `waitUntil` lifetime for persistence and notification delivery. Cron
uses eight lookups at concurrency 1 per organization and awaits them, so its
five-organization sweep cap bounds status traffic across the invocation. They use
recheck floors by last known status: 5 minutes for never-asked and `validating`,
1 hour for `staged`, and 24 hours for `published`, which can later become
`deleted`. The terminal `blocked` and `deleted` states are never rechecked.
Reviews older than 30 days stop being asked about at all. Only npm staged-publish scans are eligible;
workflow-gate scans are excluded because their package coordinates may describe
PyPI or VS Code releases. Due rows share one oldest-work timeline: creation time
until the first lookup, then the last-attempt time. This drains new work without
letting continuous arrivals starve validating, staged, or published rechecks.
Status writes are fenced by that attempt timestamp, so an older overlapping
sweep cannot replace a newer answer.

The scan captures the registry URL and immutable registry-supplied package
coordinates separately from the inspected tarball manifest. A connection edit
therefore cannot make an old review ask a different registry about a
coincidentally identical name and version, and hostile package bytes cannot
retarget the credentialed lookup. Queued scans carry that captured registry into
the credential broker too: if the organization's connection changes before or
during the scan, every staged, detail, and baseline request fails closed instead
of reviewing the same stage ID from another registry. If the best-effort
pre-queue detail read was unavailable but the worker later recovers the stage
record, it fills the missing control-plane coordinates and reconciles release
ownership before persisting the completed report. If recovered coordinates
disagree with the identity captured before queueing, the scan fails instead of
combining a report for one release with lifecycle status for another. Within one registry, only
the newest scan for a package/version is eligible: duplicate manual reviews get
one status owner and one reminder, and a rejected version staged again under a
new stage ID supersedes the previous incarnation. Supersession is stamped on
the older rows and clears their displayable registry status, so historical
reviews cannot keep presenting a live-looking verdict or command for an obsolete
stage ID. Any public report capability, badge, or threat-feed listing attached
to the obsolete stage is retired at the same time. Superseded reviews cannot
accept or update decisions, and failure
refinement rechecks ownership after its registry request so a concurrent restage
cannot attribute the replacement stage's outcome to the older scan. The reminder
marker remains as send-once history. Deleting a failed newer scan therefore
cannot revive historical stage IDs. Discovery creates the new scan row before
scheduling status resolution and also passes the current stage IDs as a
fail-closed race guard.

The dashboard refreshes immediately for newly queued scans, then performs a
bounded set of follow-up refreshes while the `waitUntil` status lookups finish.
This keeps the **Check npm** request responsive without requiring a second
manual refresh to see registry outcomes. Approval commands are pinned to the
registry URL captured with the scan, including for custom registries. The
npmjs.com staged-packages shortcut is only offered for scans captured from the
public npm registry; custom registries keep the registry-pinned CLI command.

## Failure codes

`refineStagedFailure` only ever narrows `staged_tarball_unavailable`, and only
for non-gate scans (workflow-gate reviews span three ecosystems, where npm's
stage lifecycle means nothing):

| npm status                           | code                         | meaning                                                                                      |
| ------------------------------------ | ---------------------------- | -------------------------------------------------------------------------------------------- |
| `published`                          | `staged_release_published`   | Approved and published before the review could read it.                                      |
| `deleted`                            | `staged_release_deleted`     | Published, then removed before the review could read it.                                     |
| `blocked`                            | `staged_release_blocked`     | npm's validation rejected it; the staged bytes are gone.                                     |
| `staged` / `validating` / unresolved | `staged_tarball_unavailable` | The release is still there and we still could not read it — genuinely a token-scope problem. |

Auto-discovered candidates in every one of these cases are discarded rather than
shown as failures, as before: nobody asked for the scan and there is nothing left
to review. The recorded `reason` now says which.

Failed scans are not eligible for the background sweep. They therefore persist
only terminal `blocked` and `deleted` registry statuses; a `published` lookup is
kept in the refined failure message instead of storing a snapshot that could
later become stale.

## Forgotten-approval reminder

Sent once per registry release, when all four hold: the organization decided `publish`,
npm still reports `staged` (not `validating` — that is npm working, not a human
forgetting), the decision is at least 6 hours old, and
`registry_publish_reminder_at` is unset. The sweep claims that column before
sending only if the approval and `staged` observation it acted on are still
current, so overlapping sweeps cannot double-send and an in-flight decision or
registry-status change cannot produce a stale reminder. The email carries release
identity, the stage id, an `npm stage approve --registry <captured-registry>` command, and a dashboard link —
no token, header, or package bytes.

The workbench shows the same state immediately, without the 6-hour delay: the
delay only gates the email.

## Token scope

The endpoint's specification says the caller "must have publish access to the
package" and returns authorization failures as `404`. Drydock asks organizations
for a read-only granular token (`docs/security-model.md`), and that stance does
not change for this: if a read-only token cannot ask, the feature degrades to
"no status" everywhere and nothing else breaks. **This is worth measuring
against a real read-only token before relying on the signal** — npm's
enforcement may be looser than the wording, since read-only tokens already work
against `/-/stage`. Do not widen the requested token scope to make it work.

## Storage

Eight columns on `scans` (migration `0027`):

- `registry_url` — registry base URL captured when the scan is created; legacy
  null rows fail closed and are not polled.
- `registry_package_name` / `registry_version` — immutable registry-control-plane
  coordinates; legacy null rows fail closed and are not polled.

- `registry_version_status` — last known npm status, or null.
- `registry_version_status_at` — when npm last returned that status.
- `registry_version_status_attempted_at` — when the lookup last ran, set even on
  failure; this is the throttle and overlapping-sweep fence.
- `registry_status_superseded_at` — durable marker that a newer scan owns this
  registry/package/version lifecycle.
- `registry_publish_reminder_at` — send-once marker for the nudge.

Exported additively as `registryStatus: { status, observedAt } | null` on
`report.json`. No schema bump: the field is optional and additive, and
`drydock.report.v2`'s bump was for a removal.
