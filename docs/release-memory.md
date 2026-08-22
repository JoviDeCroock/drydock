# Release memory (prior-release consistency)

Release memory tells a reviewer when the scan they are looking at has the same
deterministic finding profile as a release the organization already reviewed
and approved. It exists to cut alert fatigue: benign packages such as test
runners trigger the same high-severity capability findings on every release
(spawning processes is their declared purpose), and without context each new scan
presents those findings as if they were novel.

## What it does

During a scan, after deterministic findings are computed and before they are
scored, the pipeline looks up the most recent scan in the **same organization**, for the
**same `packageName`**, with `status = 'complete'` and `decision = 'publish'`
(the in-flight scan id is excluded). Both scans are reduced to a **finding
profile**: the multiset of `(ruleId, severity, file)` over rule findings.
`line` and `evidence` are ignored — a finding that moved lines is the same
profile entry — and findings without a `ruleId` participate as `"unknown"`.

The profiles are compared as multisets:

| Status     | Meaning                                                                                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `match`    | Identical multisets — the approved release had exactly this finding profile.                                                                                  |
| `subset`   | Strict multiset subset — every current finding (duplicates included) was in the approved profile, plus more.                                                  |
| `diverged` | Something is present now that the approved profile lacked; `newFindings` lists the difference (capped at 25 entries; `newFindingCount` keeps the true count). |
| `none`     | No prior approved scan for this package in this organization (or the lookup was skipped/failed).                                                              |

The result is persisted as `summary.releaseConsistency` on the scan (no schema
migration; it lives in `summaryJson`), returned on `ScanResult`, included in
the digested report payload, and exported by `report.json` as an additive
optional field (`null` for scans that predate it).

Completion email and Slack notifications surface the same context. They lead
with release-delta risk (rather than whole-package artifact risk) and say when
the profile matches, is a subset of, or has diverged from the prior approved
release. This keeps recurring package-context findings from arriving as an
unexplained high-risk alert while preserving the recorded risk and findings.

## What it changes, and what it must not

Release memory has exactly one scoring effect: **package-context findings that
were already in an approved release stop anchoring `contextRisk` and
`artifactRisk`.** It never edits, hides, or re-severities a finding — every one
is still emitted, persisted, and listed in the UI. Only its contribution to the
headline score is dropped, and `priorApprovedContextFindingCount` on the risk
breakdown records how many were dropped so the banner can say so. A headline
that silently falls from high to low is worse than one that never moved.

The boundaries are what make this safe:

- **Release-delta findings are never demoted.** A finding on a file this
  release changed says something about new bytes, so matching a prior profile
  entry proves nothing about it. `releaseRisk` is therefore untouched, and
  because `workflow-gate-job.ts` reads `releaseRisk` for its accept/reject
  recommendation, a prior approval can never release a held GitHub job.
- **It cannot escalate.** The adjustment only ever removes findings from a
  score; it has no path to raise one.
- **It fails closed.** No prior approved scan, or a `diverged` profile whose
  `newFindings` list hit the 25-entry cap (so the approved set can't be
  reconstructed exactly), drops nothing at all.
- **A skipped baseline disables it entirely.** When the published baseline
  exceeded the download budget (`BaselineInfo.comparisonSkipped`), every finding
  is annotated `unknown` package context, so the whole scan would otherwise land
  in the adjustment's bucket. Release memory's premise is "this evidence was
  reviewed before _and nothing changed_"; with nothing compared, the second half
  cannot be established, and a profile match on
  `(ruleId, severity, file)` does not imply identical bytes. Discounting there
  would grade an uncompared release as clean — the failure the skipped-baseline
  handling exists to prevent.
- **AI output can't reach it, in either direction.** The profile is
  deterministic-only, so the advisory reviewer cannot influence what counts as
  previously approved — and, symmetrically, an AI finding is never dropped by
  the adjustment, because a `match` on the deterministic profile says nothing
  about what the reviewer found. AI findings are projected without a `ruleId`,
  which is what makes them ineligible.

The motivating evidence is production: across scans whose release delta was
clean but whose package context read high, **every single one was published
anyway.** Re-anchoring a headline on evidence a maintainer already accepted is
how a real signal ends up buried.

The UI renders it as a positive banner (`match`/`subset`) or a quiet "N findings
are new since the last approved release" line (`diverged`) next to the
recommendation; `none` renders nothing.

A `match`/`subset` with **zero current findings** is a vacuous comparison
(empty profile vs. empty-or-any prior profile), so the banner switches to
dedicated "No deterministic findings" wording that says only deterministic
checks are compared. The banner is not suppressed — the prior-approval context
is still useful — but it must not read as reassurance about the diff or the AI
review, which remain specific to the new release.

## Failure and compatibility behavior

- The lookup is wrapped: a database or artifact-read error degrades to `none`
  and emits a structured `scan.release_memory.lookup_failed` operational event
  instead of failing the scan.
- Old scans lack the field entirely; every reader goes through
  `normalizeReleaseConsistency`, which tolerates absence and malformed blobs.
- The query is organization-scoped; one organization's review history is never
  visible to another. It is served by
  `scans_org_package_decision_created_idx` — `(organization_id, package_name,
status, decision, created_at, id)`. The older
  `scans_org_decision_created_idx` lacks `package_name`, so this lookup used to
  scan every decided scan in the organization, once per scan, for every
  package.

## Where the prior profile is read from

The lookup needs three fields per finding, and it used to get them by
downloading and digest-verifying the prior release's **entire** artifact bundle
(`report.json` + `files.json` + `diff.json`) on every scan. So the profile is
persisted at completion instead:

- `scans.finding_profile_json` holds `{ version, findings: [{ ruleId, severity,
file }] }` in canonical profile order — the multiset itself, duplicates
  included. It is built from the same redacted **rule** findings the scan
  persists, so the advisory reviewer's output can never enter it. Profiles above
  `FINDING_PROFILE_MAX_ENTRIES` or `FINDING_PROFILE_MAX_BYTES` are not stored at
  all rather than stored truncated: a truncated profile is indistinguishable
  from a smaller one, so it would report findings the prior release actually had
  as new — a fabricated `diverged`. The byte budget also leaves headroom inside
  D1's 2 MB row limit for the compacted diff, risk summary, and other scan
  metadata; multibyte package paths therefore fall back instead of breaking scan
  persistence.
- Rows written before the column (and oversized profiles) fall back to
  projecting the profile out of the prior scan's artifacts: the digest-verified
  R2 `report.json` for artifact-backed scans (their findings are no longer
  duplicated into `scan_findings`), and the D1 `scan_findings` rows for
  legacy/degraded scans. Both paths filter `source: "ai"` rows out, mirroring
  what the persisted profile excludes by construction.
- A stored blob that will not parse logs
  `scan.release_memory.profile_unreadable` and falls through to the artifact
  path. It is never read as an empty profile — an empty profile would mark every
  current finding new.
- The pre-existing fail-closed rule still governs the fallback: an
  artifact-backed prior whose report cannot be read returns nothing (the caller
  degrades to `none`) rather than a corrupt-empty profile.

Code: `server/lib/scan/release-memory.ts` (profile building + comparison +
persisted-profile serialization), `server/db/release-memory.ts`
(prior-approved-scan lookup),
`resolveReleaseConsistency` in `server/lib/scan/pipeline-phases.ts` (pipeline
phase), `src/pages/Dashboard/ScanDetail/ReleaseConsistencyNotice.tsx` (UI).
