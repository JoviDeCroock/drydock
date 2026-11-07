# Release-process fingerprint rules

Deterministic findings about how a release arrived, compared against the organization's D1 scan history, not what its artifact contains. **Authority:** enforced (release-scoped findings feed release risk, which drives the workflow gate's approve/reject recommendation). **Owner:** `server/lib/release-fingerprint.ts`.

Target shape: a compromised maintainer account publishing outside the maintainer's normal CI release path.

## At a glance

| Thing | Owner | Trigger | Pinned by |
| --- | --- | --- | --- |
| Rule logic (pure) | `server/lib/release-fingerprint.ts` | every scan | `test/release-fingerprint.test.ts` |
| Org-scoped history query | `server/db/release-fingerprint.ts` | every scan | `test/workers/release-fingerprint.test.ts` |
| Pipeline wiring | `collectReleaseFingerprintFindings` in `server/lib/scan/pipeline.ts` | every scan | `test/workers/release-fingerprint.test.ts` |
| Rule id + version | `server/lib/review/rules/rule-ids.ts`, `DETERMINISTIC_RULES_VERSION` | — | `test/detection-rule-coverage.test.mjs` (corpus exception) |

Not a content rule: the security corpus and detection eval replay package bytes and do not cover it.

## Contract

### `release.source-drift`

| Item | Value |
| --- | --- |
| Release path | `scans.source`; `workflow_gate` scans keyed further by the gate's `repositoryFullName` + `environment` (`scans.gateId` → `github_workflow_gates`). `manual` and `auto_discovery` collapse into one "staged" path (both review the same staged endpoint). |
| History | Same `organizationId` + ecosystem + `packageName`, `status = 'complete'`, current scan excluded, most recent `RELEASE_FINGERPRINT_PACKAGE_HISTORY_CAP` (100) rows (`server/db/release-fingerprint.ts`). |
| Trigger | ≥ `SOURCE_DRIFT_MIN_PRIOR_SCANS` (3) prior completed scans, all on one release path, and the current path differs. |
| Severity high | Prior path is a workflow gate and the current path is not (staged/manual): the "publish around CI with a stolen token" shape. It lands on a staged scan, which has no gate to reject, so it shows as high release risk in the workbench. |
| Severity medium | Every other drift: gate repository or environment change, staged → gate (expected while an org migrates onto gates, so non-blocking). |
| Finding file | `RELEASE_PROCESS_FINDING_FILE` = `<release-process>`; the UI renders it as plain text, not an open-in-diff button. |
| Scope | Always `releaseDelta: true` (the annotator treats every `release.*` rule as release-scoped); as an anchor it also feeds artifact risk. |

### Suppression (emits nothing)

| Condition | Reason |
| --- | --- |
| Mixed prior history | No single normal path to deviate from. |
| < 3 prior completed scans | History too short to prove abnormal. |
| Unknown current source (no scan row) or no package name | Cannot place the current release. |
| Prior rows in another ecosystem | An npm package and a PyPI project both named `acme-sdk` are different packages. |
| Completed rows with unknown ecosystem | Workflow-gate scans whose summary predates the provenance snapshot cannot be attributed to a registry and count toward none. |

### Identity

| Field | Source |
| --- | --- |
| Current package name | Staged manifest (the current scan may not have a persisted row yet). |
| Current ecosystem | Pipeline adapter id (`npm`, `pypi`, `vscode`), never a manifest field. |
| Stored row ecosystem | `scanEcosystemSql` (`server/db/scan-query.ts`): `npm` for `manual`/`auto_discovery`, else the gate provenance or published-pair ecosystem the summary recorded. |
| Name matching | Exact as recorded; PyPI names are not PEP 503-normalized (`Acme_SDK` ≠ `acme-sdk`). |

## Invariants

1. Silence over noise: every ambiguous situation (short, mixed, or unattributable history; unknown source) emits nothing rather than a hedged finding (`server/lib/release-fingerprint.ts`).
2. Package bytes cannot choose which history a scan is compared against: the ecosystem comes from the adapter (`test/ecosystem-registry.test.ts` pins that each adapter id equals what its persisted rows read back as).
3. The history query is organization-scoped, and the workflow-gate join re-checks the gate's organization.
4. The ecosystem predicate runs on rows `scans_package_idx` already narrowed; no extra index.
5. Dropping unattributable rows usually shortens history below 3; when it leaves a consistent attributable run, the rule judges that run (same as the legacy row aging out of the 100-row window).
6. Pending and running scans have no ecosystem, but `status = 'complete'` already excludes them.
7. A `release.*` rule that can fire on a routine release blocks a deployment, not just adds noise; any new rule here must prove deviation from history first.
8. A burst signal (many packages staged at once) must never be release-blocking: if revived it must be package context rather than release delta, or conditioned on the burst's packages also drifting off their usual release path. A stolen-token attacker publishes directly to the registry, so the only bursts Drydock observes are legitimate release trains.
9. Persisted `release.burst-anomaly` rows from rules 1.23.0 stay readable: findings store the rule id as a plain string, nothing resolves it through `DETERMINISTIC_RULE_IDS`, and release-scoping matches the `release.` prefix.

## Failure modes

| Condition | Cause | What happens | Fix |
| --- | --- | --- | --- |
| History lookup throws | D1 error | No release-process findings; scan continues; `scan.release_fingerprint.failed` operational event (redacted, no package contents) | Check D1 health; the next scan retries |
| Gated monorepo train flipped to `rejected` | Former `release.burst-anomaly` (removed in rules 1.24.0) | No longer possible | Do not reintroduce a blocking burst rule (invariant 8) |
| Drift not raised for a cross-registry namesake | Ecosystem scoping | Expected | — |

## Change checklist

- New `release.*` rule → add to `server/lib/review/rules/rule-ids.ts`, a `CORPUS_COVERAGE_EXCEPTIONS` entry in `test/detection-rule-coverage.test.mjs`, the inventory in [`security-detection-corpus.md`](./security-detection-corpus.md#rule-inventory), a row in [`detection-rule-history.md`](./detection-rule-history.md), and cases in both fingerprint tests.
- Change history scoping → update `server/db/release-fingerprint.ts` and the cross-ecosystem cases in `test/workers/release-fingerprint.test.ts`.
