# Public npm publication monitoring

The dashboard's **Publication monitor** watches explicitly enrolled public npm
packages independently of staged scans. It checks new public versions against
the active organization's prior release decisions and hashes the actual
published tarball. A direct publication can therefore appear even when Drydock
never discovered a stage or received a GitHub gate webhook.

This is advisory observation after publication. It does not hold npm releases,
establish package ownership, classify malware, or prevent the first install.
Private packages and custom registries are not supported in production.

## Enrollment and observations

Enter a public npm package name on the dashboard and choose **Watch package**.
No npm token or existing scan is required. Enrollment starts a new observation
window; versions with registry publication times before enrollment are excluded.
Duplicate enrollment preserves the original start time. Removing a watch deletes
its observations; enrolling it again starts a new window.

The existing 15-minute cron checks watches independently of staged discovery.
**Check npm** runs a bounded check on demand. The dashboard displays the latest
100 observed versions for the selected watch, along with the enrollment time,
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

- `GET /api/v1/publication-watches` lists watches.
- `POST /api/v1/publication-watches { "packageName": "@scope/package" }` enrolls.
- `GET /api/v1/publication-watches/:id` returns the watch and latest observations.
- `POST /api/v1/publication-watches/:id/check` checks a bounded batch and returns
  current observations. Repeated checks are rate-limited.
- `DELETE /api/v1/publication-watches/:id` stops monitoring and removes history.

Responses are private and not cacheable. The organization has a 20-watch limit.
A cron sweep selects up to eight watches by oldest check; an individual check
handles up to three pending versions. A short database claim prevents overlapping
manual and scheduled checks from multiplying work on the same watch.
Metadata is capped at 4 MiB and tarballs at 16 MiB, with a five-second deadline
per response. A package exceeding 10,000 versions or stored observations reports
a history-limit coverage problem rather than silently treating a partial history
as complete.

Persistence lives in `publication_watches` and `publication_observations`.
`server/lib/ecosystems/npm/publication-monitor.ts` owns acquisition and comparison;
`server/routes/publication-watches.ts` owns the authenticated API. Operational
failures use safe codes through `emitOperationalEvent`, never raw registry errors.

The local fake-registry harness may use the existing explicitly enabled loopback
registry override. Production enrollment cannot select a registry URL. Tests cover
organization isolation, direct releases with no scan, prior decisions, actual
digest mismatch, missing evidence, bounded acquisition and the dashboard flow.
