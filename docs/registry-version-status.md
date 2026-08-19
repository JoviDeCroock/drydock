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
  read; unrecognized enum values are treated as unknown rather than passed
  through.
- An unresolved lookup persists `registry_version_status_at` (so the next sweep
  is throttled) and leaves `registry_version_status` null.
- The UI renders nothing for a null status — no badge, no notice, no
  reassurance. `RegistryStatusNotice` and `registryStatusVariant` own that rule.
- A `staged` status with no decision recorded also renders nothing: that is the
  normal resting state of a release under review.

## Where it runs

| Path                                      | Trigger                                                                              | What it does                                                                                                   |
| ----------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `lib/ecosystems/npm/release-outcome.ts`   | discovery sweep (cron `*/15`, and the on-demand "Check npm" button), via `waitUntil` | Resolves status for completed reviews and sends the forgotten-approval nudge. Never blocks or fails discovery. |
| `lib/scan/job.ts` → `refineStagedFailure` | a scan failing with `staged_tarball_unavailable`                                     | Asks npm what happened before deciding the message.                                                            |

Lookups are bounded per organization per invocation (25, concurrency 4), with
recheck floors by last known status: 5 minutes for never-asked and `validating`,
1 hour for `staged`, never for the three terminal states. Reviews older than 30
days stop being asked about at all. Only npm staged-publish scans are eligible;
workflow-gate scans are excluded because their package coordinates may describe
PyPI or VS Code releases. Due rows are ordered by their oldest lookup timestamp
so a backlog drains instead of repeatedly selecting the newest 25.

The dashboard refreshes immediately for newly queued scans, then performs a
bounded set of follow-up refreshes while the `waitUntil` status lookups finish.
This keeps the **Check npm** request responsive without requiring a second
manual refresh to see registry outcomes.

## Failure codes

`refineStagedFailure` only ever narrows `staged_tarball_unavailable`, and only
for non-gate scans (workflow-gate reviews span three ecosystems, where npm's
stage lifecycle means nothing):

| npm status                           | code                         | meaning                                                                                      |
| ------------------------------------ | ---------------------------- | -------------------------------------------------------------------------------------------- |
| `published`                          | `staged_release_published`   | Approved and published before the review could read it.                                      |
| `deleted`                            | `staged_release_withdrawn`   | Withdrawn before the review could read it.                                                   |
| `blocked`                            | `staged_release_blocked`     | npm's validation rejected it; the staged bytes are gone.                                     |
| `staged` / `validating` / unresolved | `staged_tarball_unavailable` | The release is still there and we still could not read it — genuinely a token-scope problem. |

Auto-discovered candidates in every one of these cases are discarded rather than
shown as failures, as before: nobody asked for the scan and there is nothing left
to review. The recorded `reason` now says which.

## Forgotten-approval reminder

Sent once per release, when all four hold: the organization decided `publish`,
npm still reports `staged` (not `validating` — that is npm working, not a human
forgetting), the decision is at least 6 hours old, and
`registry_publish_reminder_at` is unset. The sweep claims that column before
sending, so overlapping sweeps cannot double-send. The email carries release
identity, the stage id, the `npm stage approve` command, and a dashboard link —
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

Three columns on `scans` (migration `0027`):

- `registry_version_status` — last known npm status, or null.
- `registry_version_status_at` — when the lookup last ran, set even on failure;
  this is the throttle.
- `registry_publish_reminder_at` — send-once marker for the nudge.

Exported additively as `registryStatus: { status, observedAt } | null` on
`report.json`. No schema bump: the field is optional and additive, and
`drydock.report.v2`'s bump was for a removal.
