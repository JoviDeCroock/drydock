# Release-process fingerprint rules

Deterministic findings about how a release _arrived_, not what its artifact contains. The dominant 2025–26 npm supply-chain shape is a compromised maintainer account burst-publishing malicious versions across many packages, usually outside the maintainer's normal CI release path. Drydock sits pre-publish and holds per-organization scan history in D1, so it can flag releases that deviate from how this organization or package normally releases.

Both rules live in the shared deterministic rule set (`server/lib/review/rules/rule-ids.ts`, versioned by `DETERMINISTIC_RULES_VERSION`, introduced in `1.22.0`). The pure logic is `server/lib/release-fingerprint.ts`; the org-scoped history queries are `server/db/release-fingerprint.ts`; the pipeline wires them in `server/lib/scan/pipeline.ts` (`collectReleaseFingerprintFindings`). They are not content rules, so the security corpus and detection eval (which replay synthetic package bytes) do not cover them — the unit matrix lives in `test/release-fingerprint.test.ts` and the D1-backed end-to-end checks in `test/workers/release-fingerprint.test.ts`.

## False-positive posture

Silence over noise. Both rules must _prove_ the deviation is abnormal from history before emitting anything; every ambiguous situation (short history, mixed history, an established burst pattern, a truncated history read, an unknown scan source) emits **nothing** rather than a hedged finding. A failed history lookup never fails the scan: the pipeline degrades to no release-process findings and emits a `scan.release_fingerprint.failed` operational event (secret-redacted, no package contents).

## Shared mechanics

- Findings carry the synthetic file label `<release-process>` (`RELEASE_PROCESS_FINDING_FILE`) because they describe the release, not a file. The diff annotator treats every `release.*` rule as release-scoped, so these findings always land with `releaseDelta: true` and feed **release risk** (and, as anchor-severity findings, overall artifact risk). The findings UI renders the label as plain text instead of an open-in-diff button.
- The current scan may not have a persisted row when the rules run, so it is counted explicitly from the staged manifest name rather than read back from D1.
- All history queries filter by `organizationId` (the workflow-gate join re-checks the gate's organization) and ride existing indexes (`scans_org_created_idx`, `scans_package_idx`).

## `release.burst-anomaly` (severity: high)

Fires when the organization suddenly stages many _distinct_ packages at once — the compromised-account burst-publish shape — and history proves that is unprecedented.

Trigger (all must hold):

- Counting org scans created in the last 30 minutes (`BURST_WINDOW_MS`), including the current scan, there are ≥ 5 distinct `packageName`s (`BURST_DISTINCT_PACKAGE_THRESHOLD`).
- The org has ≥ 30 days of scan history (`BURST_MIN_ORG_HISTORY_DAYS`) and ≥ 5 prior completed scans (`BURST_MIN_PRIOR_COMPLETED_SCANS`).
- No prior 30-minute window in the last 180 days (`BURST_LOOKBACK_DAYS`) reached 5 distinct packages — monorepo release trains that always publish many packages at once therefore never fire this rule.

Suppression: insufficient history age or completions, any prior burst window, or a truncated history read (the fetch is capped at `RELEASE_FINGERPRINT_ORG_HISTORY_CAP = 500` rows; hitting the cap means older windows were not seen, so the rule stays silent instead of claiming "first ever" on partial data — very high-volume orgs are exactly the ones whose trains would suppress it anyway).

Evidence: the distinct-package count, the window, and up to 8 package names (`BURST_EVIDENCE_PACKAGE_LIMIT`).

## `release.source-drift` (severity: high for gate→staged, medium otherwise)

Fires when a package with a consistent release path arrives through a different one.

Release path = `scans.source`, with `workflow_gate` scans further keyed by the gate's `repositoryFullName` + `environment` (joined via `scans.gateId` → `github_workflow_gates`). `manual` and `auto_discovery` deliberately collapse into one "staged" path: the discovery cron and the "Check npm" button review the same staged endpoint, so drift between them would be pure noise.

Trigger: the package (same org + `packageName`) has ≥ 3 prior completed scans (`SOURCE_DRIFT_MIN_PRIOR_SCANS`), **all** sharing one release path (checked over the most recent `RELEASE_FINGERPRINT_PACKAGE_HISTORY_CAP = 100`), and the current scan's path differs.

- **High**: a consistently workflow-gated package arriving as a staged/manual scan — the "publish around CI with a stolen token" shape.
- **Medium**: every other drift (gate repository or environment change, staged→gate).

Suppression: mixed prior history, fewer than 3 prior completed scans, unknown current source (no scan row), or no package name.
