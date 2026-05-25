# Diff Baseline Strategy

This note records the baseline-selection decision for staged publish review.

## Implemented behavior

The scan pipeline downloads the staged tarball and fetches staged metadata in parallel. It reads `package.json`, fetches registry package metadata, then diffs the staged artifact against `pickBaselineVersion(metadata, stagedVersion, stagedTag)`.

The baseline selector is intentionally tag-aware:

1. If the staged metadata has a tag and current package metadata has `dist-tags[tag]` pointing at a published version other than the staged version, the scan diffs against that version.
2. Otherwise, it falls back to the highest semver predecessor lower than the staged version.
3. If there is no lower predecessor, it falls back to the highest published semver-like version.
4. If no baseline can be selected or downloaded, the scan proceeds as an all-added diff and records the baseline reason in `summary_json.baseline`.

This avoids forcing `2.0.0-beta.3 --tag beta` against `latest` and keeps maintenance or custom-channel releases from being compared with an unrelated highest-semver channel. A wrong baseline inflates changed-file count, which makes human review noisier and will increase AI input size when AI review returns.

## npm staged metadata

As of the npm stage API/CLI docs published with npm CLI 11.15, staged publish metadata exposes the staged package's package name, version, dist-tag, actor, access, and shasum through both the staged list endpoint and the staged detail endpoint:

- `GET /-/stage`
- `GET /-/stage/{stage-id}`

The CLI docs also state that the staged tag follows normal publish tag behavior, defaults to `latest` when omitted, and is immutable for the staged package.

The API gives us the staged tag. It does not document an explicit "previous version", nor a snapshot of the tag target at stage creation time. Because npm allows normal publishes while staged packages are pending, the tag target can theoretically move between stage creation and our scan. Therefore, tag-following baseline selection should be treated as an inference from current registry metadata, not as a registry-provided historical fact.

## Baseline data stored on reports

Completed scans persist:

- `summary_json.stagedPublish` with the parsed staged metadata (`id`, package name, version, tag, actor/access/timestamp, and npm shasum when present);
- `summary_json.baseline` with selected version, staged tag, selection source, current dist-tag target, and reason;
- the existing `scans.previous_version` column as the actual parsed version of the downloaded comparison tarball.

The pipeline cross-checks staged detail package name/version against the staged tarball's `package.json`. A mismatch produces a critical deterministic finding (`stage.metadata-mismatch`) and suppresses tag-based baseline selection for that scan. The staged API also exposes a shasum, but the current sandbox does not hash the compressed tarball bytes, so shasum verification is recorded as future hardening rather than implemented.

## AI token impact

AI review is disabled in the current pipeline, but when it returns it should remain diff-first:

- deterministic findings stay authoritative and are computed before AI;
- AI sees package-json diff, deterministic findings, changed-file diff, and bounded samples for changed files only;
- unchanged files should not be sent as AI review evidence unless a deterministic rule needs context;
- changed files should be ranked so high-signal files are kept when caps are hit.

Tag-aware baseline selection is the largest low-risk token reducer because it prevents channel releases from appearing as a broad diff against the wrong published artifact. It improves the evidence for both humans and models without reducing deterministic coverage of the staged artifact itself.

## Deterministic findings and diff status

Do not make deterministic safety depend only on the diff. The staged artifact is still the package under review, so risky install hooks, native artifacts, credential access, and secrets must be detected even if they existed before.

However, report payloads, report presentation, and AI payload construction should distinguish:

- new or modified risky evidence, which is release-blocking signal;
- removed risky evidence, which may be positive but still deserves context;
- unchanged risky evidence, which is pre-existing package risk and should not dominate "what changed" unless policy says the product blocks any release containing that behavior.

This avoids hiding persistent risk while keeping the staged-publish review centered on the actual release delta.
