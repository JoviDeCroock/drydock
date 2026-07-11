# Diff Baseline Strategy

This note records the baseline-selection decision for Drydock's npm staged-publish review path.

## Implemented behavior

The scan pipeline downloads the staged tarball and fetches staged metadata in parallel. It reads `package.json`, fetches registry package metadata, then diffs the staged artifact against `pickBaselineVersion(metadata, stagedVersion, stagedTag)`.

The baseline selector is intentionally tag-aware:

1. If the staged metadata has a tag and current package metadata has `dist-tags[tag]` pointing at a published version other than the staged version, the scan diffs against that version.
2. Otherwise, it falls back to the highest semver predecessor lower than the staged version.
3. If there is no lower predecessor, it falls back to the highest published semver-like version.
4. If no baseline can be selected or downloaded, the scan proceeds as an all-added diff and records the baseline reason in `summary_json.baseline`.

This avoids forcing `2.0.0-beta.3 --tag beta` against `latest` and keeps maintenance or custom-channel releases from being compared with an unrelated highest-semver channel. A wrong baseline inflates changed-file count, which makes human review noisier and increases AI input size when AI review is enabled.

### Fetching the baseline tarball

The selected baseline is a _published_ `.tgz`, and it is **not** downloaded through `NpmStageGateway`. The trusted parent Worker fetches it via `downloadPublishedTarball` (in `server/lib/published-tarball.ts`): it validates that the tarball URL shares the configured registry origin before attaching the npm token (so the credential can never reach a package-controlled host), then pipes the response body — never buffered in the parent — into a credentials-free sandbox (`downloadInSandboxStream`) for gunzip/untar and parsing. The previous version is attacker-influenced evidence, so the decompression-bomb-prone parse stays sandboxed even though the fetch does not. Size enforcement lives in the sandbox — its compressed and decompressed stream caps (`SANDBOX_MAX_STREAM_TAR_BYTES`) map to a 413 — so baselines up to the cap diff normally and only beyond it does `acquireBaselineNpm` degrade to a no-baseline scan; the parent keeps just the advertised content-length gate and a looser 2× mid-stream backstop, which must not fire first because its error cannot carry the degradable 413 into the sandbox. The same helper backs the on-demand compare endpoint (`server/lib/compare-cache.ts`). Only the staged-tarball endpoint still flows through the credentialed gateway.

### Tarball and compare caching

Published tarball fetches read through a colo-level byte cache (`caches.default`, keyed by tarball URL). The cache is shared across organizations, which is safe because of how it is written: entries are only ever populated by a background **anonymous** re-fetch of the same URL (`ctx.waitUntil`), so the cache can only hold bytes any unauthenticated client could download — private tarballs 404 the anonymous warm fetch and are never stored. Token-bearing requests may read the cache only for `registry.npmjs.org`, where anonymous and authenticated bytes for a given tarball URL are identical; custom registries only participate for unauthenticated fetches, and the fake-registry e2e path (`allowInsecureLocalhost`) bypasses the cache entirely. The warm fetch is deliberately a second download rather than a tee of the serving stream, preserving the never-buffered-in-the-parent invariant above.

The parsed compare payloads in the `COMPARE_CACHE` KV namespace are immutable once written (keys are content-addressed by org scope + registry + tarball URL), so reads pass `cacheTtl` to serve repeat diff browsing — one read of the same key per file view — from KV's colo cache instead of its central stores.

## npm staged metadata

As of the npm stage API/CLI docs published with npm CLI 11.15, staged publish metadata exposes the staged package's package name, version, dist-tag, actor, access, and shasum through both the staged list endpoint and the staged detail endpoint:

- `GET /-/stage`
- `GET /-/stage/{stage-id}`

The CLI docs also state that the staged tag follows normal publish tag behavior, defaults to `latest` when omitted, and is immutable for the staged package.

The API gives us the staged tag. It does not document an explicit "previous version", nor a snapshot of the tag target at stage creation time. Because npm allows normal publishes while staged packages are pending, the tag target can theoretically move between stage creation and our scan. Therefore, tag-following baseline selection should be treated as an inference from current registry metadata, not as a registry-provided historical fact.

Discovery treats `GET /-/stage` as an account-wide candidate list, not as proof that the organization token is authorized for each publish. Before creating a review, Drydock probes the staged tarball endpoint with that organization token and only persists/queues scans for stage IDs that the token can actually access. Per-stage 401/403/404 responses are filtered out instead of becoming failed reviews.

## Baseline data stored on reports

Completed scans persist:

- `summary_json.stagedPublish` with the parsed staged metadata (`id`, package name, version, tag, actor/access/timestamp, and npm shasum when present);
- `summary_json.baseline` with selected version, staged tag, selection source, current dist-tag target, and reason;
- the existing `scans.previous_version` column as the actual parsed version of the downloaded comparison tarball.

The pipeline cross-checks staged detail package name/version against the staged tarball's `package.json`. A mismatch produces a critical deterministic finding (`stage.metadata-mismatch`) and suppresses tag-based baseline selection for that scan. The staged API also exposes a shasum, but the current sandbox does not hash the compressed tarball bytes, so shasum verification is recorded as future hardening rather than implemented.

## AI evidence budget impact

AI review is Flagship-gated and off by default, but when enabled for an organization it should remain diff-first:

- deterministic findings stay authoritative and are computed before AI;
- AI sees the ecosystem id, normalized manifest diff, release-delta deterministic findings, changed-file diff, and bounded samples for changed files only;
- unchanged files should not be sent as AI review evidence unless a deterministic rule needs context or a recognized manifest field newly references that file;
- changed files should be ranked so high-signal files are kept when caps are hit.

Tag-aware baseline selection is the largest low-risk token reducer because it prevents channel releases from appearing as a broad diff against the wrong published artifact. It improves the evidence for both humans and models without reducing deterministic coverage of the staged artifact itself.

## Deterministic findings and diff status

Do not make deterministic safety depend only on the diff. The staged artifact is still the package under review, so risky install hooks, native artifacts, credential access, and secrets must be detected even if they existed before.

However, report payloads, report presentation, and AI payload construction should distinguish:

- new or modified risky evidence, which is release-blocking signal;
- removed risky evidence, which may be positive but still deserves context;
- unchanged risky evidence, which is pre-existing package risk and should not dominate "what changed" unless policy says the product blocks any release containing that behavior.

New scan reports persist this split as a risk breakdown in `summary_json.risk`:

- `releaseRisk` is computed from findings annotated as part of the package-to-package delta, plus any complete AI review result when AI review is enabled, and is the focused release-delta verdict;
- `artifactRisk` is computed from the full staged artifact findings, plus any complete AI review result when AI review is enabled, and is the primary scan risk stored in `scans.risk` so deterministic evidence cannot be hidden by context classification;
- `contextRisk` covers findings that were not part of the release delta.

When a modified-file finding cannot be resolved against line-level diff evidence (no recorded line, or no usable text samples to diff), the annotator falls back to finding-set baselining: it re-runs the deterministic rules over the baseline files and classifies the finding as package context when the same rule already fired on the same file in the baseline version. Without a baseline counterpart the classification still fails open to release delta, so missing baseline data can only make the report louder, never quieter.

The `scans.risk` column stores `artifactRisk` for new reports. Older reports without `summary_json.risk` are interpreted the same way, and release/context risk is derived from persisted finding annotations.

This keeps the staged-publish review centered on the actual release delta without allowing contextual high-risk deterministic evidence to downgrade the primary scan verdict.
