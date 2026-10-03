# Release-process fingerprint rules

Deterministic findings about how a release _arrived_, not what its artifact contains. The dominant 2025–26 npm supply-chain shape is a compromised maintainer account publishing malicious versions outside the maintainer's normal CI release path. Drydock sits pre-publish and holds per-organization scan history in D1, so it can flag a package that suddenly arrives through a different release path than every prior release.

The rule lives in the shared deterministic rule set (`server/lib/review/rules/rule-ids.ts`, versioned by `DETERMINISTIC_RULES_VERSION`). The pure logic is `server/lib/release-fingerprint.ts`; the org-scoped history query is `server/db/release-fingerprint.ts`; the pipeline wires it in `server/lib/scan/pipeline.ts` (`collectReleaseFingerprintFindings`). It is not a content rule, so the security corpus and detection eval (which replay synthetic package bytes) do not cover it — the unit matrix lives in `test/release-fingerprint.test.ts` and the D1-backed end-to-end checks in `test/workers/release-fingerprint.test.ts`.

## False-positive posture

Silence over noise. The rule must _prove_ the deviation is abnormal from history before emitting anything; every ambiguous situation (short history, mixed history, an unknown scan source) emits **nothing** rather than a hedged finding. A failed history lookup never fails the scan: the pipeline degrades to no release-process findings and emits a `scan.release_fingerprint.failed` operational event (secret-redacted, no package contents).

Release-process findings are release-scoped, so they feed **release risk** — which is what drives the workflow gate's approve/reject recommendation. A `release.*` rule that can fire on a routine release is therefore not merely noisy, it blocks a deployment. That is the bar any new rule in this file has to clear.

## Shared mechanics

- Findings carry the synthetic file label `<release-process>` (`RELEASE_PROCESS_FINDING_FILE`) because they describe the release, not a file. The diff annotator treats every `release.*` rule as release-scoped, so these findings always land with `releaseDelta: true` and feed release risk (and, as anchor-severity findings, overall artifact risk). The findings UI renders the label as plain text instead of an open-in-diff button.
- The current scan may not have a persisted row when the rule runs, so its package name is taken from the staged manifest rather than read back from D1. Its ecosystem is the pipeline adapter's id (`npm`, `pypi`, `vscode`), never a manifest field, so package bytes cannot choose which history they are compared against.
- The history query filters by `organizationId` (the workflow-gate join re-checks the gate's organization) and by ecosystem, and rides the existing `scans_package_idx` index. A stored row's ecosystem is `scanEcosystemSql` (`server/db/scan-query.ts`), the same derivation the package release view uses: `npm` for `manual`/`auto_discovery`, otherwise the gate provenance or published-pair ecosystem the summary recorded. Each adapter's id equals what its own persisted rows read back as (`test/ecosystem-registry.test.ts` pins this). The ecosystem predicate is evaluated on the rows the package-name index already narrowed; no new index is needed.
- Package names match exactly as recorded. PyPI names are not PEP 503-normalized here, so `Acme_SDK` and `acme-sdk` are separate histories.

## `release.source-drift` (severity: high for gate→staged, medium otherwise)

Fires when a package with a consistent release path arrives through a different one.

Release path = `scans.source`, with `workflow_gate` scans further keyed by the gate's `repositoryFullName` + `environment` (joined via `scans.gateId` → `github_workflow_gates`). `manual` and `auto_discovery` deliberately collapse into one "staged" path: the discovery cron and the "Check npm" button review the same staged endpoint, so drift between them would be pure noise.

Trigger: the package (same org + ecosystem + `packageName`) has ≥ 3 prior completed scans (`SOURCE_DRIFT_MIN_PRIOR_SCANS`), **all** sharing one release path (checked over the most recent `RELEASE_FINGERPRINT_PACKAGE_HISTORY_CAP = 100`), and the current scan's path differs.

- **High**: a consistently workflow-gated package arriving as a staged/manual scan — the "publish around CI with a stolen token" shape. This lands on a staged scan, which has no gate to reject; it shows as high release risk in the workbench.
- **Medium**: every other drift (gate repository or environment change, staged→gate). Note that staged→gate is the expected shape while an organization migrates onto workflow gates, which is why it is medium and non-blocking.

Suppression: mixed prior history, fewer than 3 prior completed scans, unknown current source (no scan row), or no package name.

Not history: scans of the same name in another ecosystem (an npm package and a PyPI project both called `acme-sdk` are different packages with independent release paths; before `1.47.0` they shared one history, so a gated PyPI project made its npm namesake's staged release drift high, and interleaved releases read as mixed), and completed rows whose ecosystem is unknown. The second group is workflow-gate scans whose summary predates the provenance snapshot. They cannot be attributed to a registry, so they count toward none: guessing would reintroduce the cross-registry comparison for exactly those rows. Dropping them usually just shortens history below the 3-scan minimum. When it instead leaves a consistent run of attributable scans, the rule judges that run, the same result as the legacy row aging out of the 100-scan window. Pending and running scans have no ecosystem yet either, but the `status = 'complete'` filter already excludes them.

## Removed: `release.burst-anomaly`

A companion rule shipped alongside `release.source-drift` in `1.23.0` and was removed in `1.24.0`. It flagged an organization staging ≥ 5 distinct packages inside a 30-minute window for the first time in 180 days.

That is a monorepo release train. The suppression it relied on — "some earlier window in the last 180 days also burst" — only holds once a train is already in scan history, so an organization's first coordinated release, and every release train spaced more than 180 days apart (a semiannual or annual major), raised a high release finding. Because a gate job creates one scan per package, a 5-package gated train tripped the rule on every one of its scans and the gate recommendation flipped to `rejected`.

The true-positive side never justified that cost: an attacker holding a stolen npm token publishes directly to the registry, not through the victim's staged-publish flow or CI workflow gate, so the only bursts Drydock can observe are the legitimate ones. If the burst signal returns it must be non-blocking (package context rather than release delta), or conditioned on the burst's packages also drifting off their usual release path.

Any `release.burst-anomaly` rows already persisted by a `1.23.0` scan stay readable: findings store the rule id as a plain string, nothing resolves it back through `DETERMINISTIC_RULE_IDS`, and the release-scoping check matches on the `release.` prefix rather than a known-id list. Those scans keep their recorded risk; only new scans stop producing the finding.
