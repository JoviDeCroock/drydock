# Release memory (prior-release consistency)

Compares a scan's deterministic finding profile with the organization's last approved release of the same package, and stops already-approved package-context findings from anchoring the headline risk. **Authority:** advisory context (it never changes findings or `releaseRisk`). **Owner:** `server/lib/scan/release-memory.ts`.

Purpose: benign packages such as test runners raise the same high capability findings every release; without context each scan presents them as novel.

## At a glance

| Thing | Owner | Trigger | Pinned by |
| --- | --- | --- | --- |
| Profile build + comparison | `server/lib/scan/release-memory.ts` | every scan, after deterministic findings, before scoring | `test/release-memory.test.ts` |
| Prior-approved lookup | `getPriorApprovedScanFindings` in `server/db/release-memory.ts` | same | `test/workers/release-memory.test.ts` |
| Pipeline phase | `resolveReleaseConsistency` in `server/lib/scan/pipeline-phases.ts` | same | `test/scan-pipeline-phases.test.mjs` |
| Risk adjustment | `server/lib/review/risk.ts` (`priorApprovedContextFindingCount`) | scoring | `test/risk.test.mjs` |
| UI | `src/pages/Dashboard/ScanDetail/ReleaseConsistencyNotice.tsx` | scan detail | `test/release-consistency-notice.test.ts` |
| Notifications | `server/lib/notify/format.ts` | completion email, Slack | `test/notify.test.mjs` |

## Contract

### Prior scan selection

| Criterion | Value |
| --- | --- |
| Organization | Same `organizationId` (mandatory) |
| Package | Same `packageName`, exact as recorded (PyPI names not PEP 503-normalized) |
| Ecosystem | Same; current = pipeline adapter id (`npm`, `pypi`, `vscode`), never a manifest field; stored = `scanEcosystemSql` (`server/db/scan-query.ts`): `npm` for `manual`/`auto_discovery`, else the gate provenance or published-pair ecosystem in the summary |
| Status / decision | `status = 'complete'` and `decision = 'publish'` |
| Exclusion | The in-flight scan id |
| Order | Most recent |
| Findings source | The prior scan's digest-verified R2 `report.json`; AI rows (`source: "ai"`) filtered out |

### Finding profile

Multiset of `(ruleId, severity, file)` over rule findings. `line` and `evidence` are ignored (a moved finding is the same entry). Findings without a `ruleId` participate as `"unknown"`.

### Status

| Status | Meaning |
| --- | --- |
| `match` | Identical multisets. |
| `subset` | Strict multiset subset: every current finding (duplicates included) was in the approved profile, plus more. |
| `diverged` | Something is present now that the approved profile lacked; `newFindings` lists it, capped at `RELEASE_CONSISTENCY_NEW_FINDINGS_CAP` (25); `newFindingCount` keeps the true count. |
| `none` | No prior approved scan in this organization and ecosystem, or the lookup was skipped/failed. |

### Where it surfaces

| Surface | Behavior |
| --- | --- |
| Scan summary | `summary.releaseConsistency` in `summaryJson` (no migration); returned on `ScanResult`; included in the digested report payload |
| `report.json` export | Optional additive field, `null` for scans that predate it; `drydock.report.v2` omits `priorScanId` and `decidedAt` (`server/lib/scan/report-export.ts`) |
| Email / Slack | Lead with release-delta risk, not artifact risk, and say whether the profile matches, is a subset of, or diverged from the prior approved release |
| UI `diverged` | Warn `Alert` ("N findings are new since the last approved release"); the only emphasized variant and the only one that opens review notes on its own |
| UI `match` / `subset` | Quiet muted line; with zero current findings it switches to "No deterministic findings" wording that says only deterministic checks are compared |
| UI `none` | Nothing rendered |

## Invariants

1. One scoring effect only: package-context findings already in an approved release stop anchoring `contextRisk` and `artifactRisk`. Every finding is still emitted, persisted, and listed; `priorApprovedContextFindingCount` records how many were dropped so the banner can say so (a headline that silently falls is worse than one that never moved).
2. Release-delta findings are never demoted, so `releaseRisk` is untouched; `server/lib/workflow-gate-job.ts` reads `releaseRisk`, so a prior approval can never release a held GitHub job.
3. It cannot escalate: the adjustment only removes findings from a score.
4. Fails closed: no prior approved scan, or a `diverged` profile whose `newFindings` hit the cap (approved set not reconstructible), drops nothing.
5. A skipped baseline (`BaselineInfo.comparisonSkipped`) disables the adjustment: with nothing compared, "nothing changed" cannot be established, and a `(ruleId, severity, file)` match does not imply identical bytes.
6. AI cannot reach it in either direction: the profile is deterministic-only, and AI findings (projected without a `ruleId`) are never dropped by the adjustment.
7. Standing-danger rules (see [`security-detection-corpus.md`](./security-detection-corpus.md#rule-inventory)) are never discounted as previously-approved context.
8. Organization-scoped: one organization's review history is never visible to another; `scans_org_decision_created_idx` covers the query and the ecosystem predicate runs on rows it narrowed.
9. A completed workflow-gate scan whose summary predates the provenance snapshot has no ecosystem and is never a prior for any ecosystem (same fail-closed `none` as no approval).
10. A `match`/`subset` with zero current findings must not read as reassurance about the diff or the AI review.

## Failure modes

| Condition | Cause | What happens | Fix |
| --- | --- | --- | --- |
| Lookup throws | D1 or artifact-read error | Status `none`; scan continues; `scan.release_memory.lookup_failed` operational event | Check D1/R2 health |
| Prior `report.json` unreadable | Missing or digest mismatch | No profile at all (not an empty one, which would read as `diverged`) → `none` | — |
| Old or malformed `releaseConsistency` | Scan predates the field | Every reader goes through `normalizeReleaseConsistency`, which tolerates absence and malformed blobs | — |
| Everything annotated `unknown` package context | Baseline over the download budget | Adjustment disabled (invariant 5) | — |

## Change checklist

- Change profile or comparison → `server/lib/scan/release-memory.ts`, `test/release-memory.test.ts`.
- Change scoring effect → `server/lib/review/risk.ts`, `test/risk.test.mjs`; keep invariants 2-6.
- Change the export shape → bump `REPORT_EXPORT_SCHEMA` in `server/lib/scan/report-export.ts`.

## Why

Production evidence: across scans whose release delta was clean but whose package context read high, every one was published anyway. Re-anchoring the headline on evidence a maintainer already accepted is how a real signal gets buried.
