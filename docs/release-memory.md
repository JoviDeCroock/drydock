# Release memory (prior-release consistency)

Release memory tells a reviewer when the scan they are looking at has the same
deterministic finding profile as a release the organization already reviewed
and approved. It exists to cut alert fatigue: benign packages like `tape`
trigger the same high-severity capability findings on every release (test
runners legitimately spawn processes), and without context each new scan
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
- The prior scan's rule findings are read from the digest-verified R2
  `report.json` for artifact-backed scans (they are no longer duplicated into
  `scan_findings`); legacy/degraded scans fall back to the D1 rows. Both paths
  keep the profile deterministic-only: AI finding rows (`source: "ai"`) are
  filtered out so the advisory reviewer's non-deterministic output can never
  make a routine release read as `diverged`.
- Old scans lack the field entirely; every reader goes through
  `normalizeReleaseConsistency`, which tolerates absence and malformed blobs.
- The query is organization-scoped (`scans_org_decision_created_idx` covers
  it); one organization's review history is never visible to another.

Code: `server/lib/scan/release-memory.ts` (profile building + comparison),
`server/db/release-memory.ts` (prior-approved-scan lookup),
`resolveReleaseConsistency` in `server/lib/scan/pipeline-phases.ts` (pipeline
phase), `src/pages/Dashboard/ScanDetail/ReleaseConsistencyNotice.tsx` (UI).
