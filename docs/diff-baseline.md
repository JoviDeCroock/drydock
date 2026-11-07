# Diff baseline

The npm review pipeline selects a published comparison and separates release changes from existing package risk. **Authority:** advisory. **Owner:** `server/lib/ecosystems/npm/acquire.ts`.

## At a glance

| Thing | Owner file | Who may call / trigger | Pinned by (test) |
| --- | --- | --- | --- |
| Tag-aware selection | `server/lib/ecosystems/npm/registry.ts` | npm scan and workflow gate | `test/registry.test.mjs` |
| Baseline acquisition | `server/lib/ecosystems/npm/acquire.ts` | Shared scan pipeline | `test/npm-acquire.test.mjs` |
| Published byte stream | `server/lib/ecosystems/npm/published-tarball.ts` | Baseline and on-demand compare | `test/published-tarball.test.mjs` |
| Finding attribution | `server/lib/review/diff-annotation.ts` | Shared scan pipeline | `test/review-diff-annotation.test.mjs` |
| Workbench comparison | `src/models/scan-detail-model.ts` | Scan reader | `test/scan-detail-comparison-model.test.ts` |

PyPI and VS Code baseline behavior belongs to [PyPI workflow gate](./pypi-workflow-gate.md) and [workflow gates](./workflow-gates.md).

## Contract

### Selection

The pipeline fetches staged bytes and stage metadata in parallel, reads `package.json`, then fetches package metadata. `pickBaselineVersion(metadata, stagedVersion, stagedTag)` applies this precedence:

| Order | Condition | Comparison / `summary_json.baseline.reason` |
| --- | --- | --- |
| 1 | Staged tag points to an existing published version other than the staged version | Tag target / `dist-tag:<tag>` |
| 2 | A lower semver predecessor exists | Highest predecessor / `semver-predecessor` |
| 3 | No predecessor; another semver-like published version exists | Highest published / `highest-published-fallback` |
| 4 | No candidate | None / `none`, or `dist-tag-points-at-staged-version` |
| — | Manifest lacks name/version | None / `package-json-missing-name-or-version` |
| — | Package metadata unavailable | None / `metadata-unavailable` |
| — | Selected version has no tarball | None / selection reason + `:no-tarball` |

| Stage metadata | Contract |
| --- | --- |
| Registry endpoints | `GET /-/stage`; `GET /-/stage/{stage-id}` |
| Parsed fields | Package name, version, dist-tag, actor, access, timestamp, shasum when present |
| Tag semantics | Normal publish tag; defaults to `latest`; immutable for the staged package |
| Historical certainty | Tag selection infers from current registry metadata; stage metadata supplies neither an explicit previous version nor a stage-time tag-target snapshot |
| Concurrent publish | A normal publish may move the tag between stage creation and scanning |
| Discovery | Account-wide list is only a candidate list; probe each staged tarball with the organization token before persisting/queueing |
| Inaccessible stage | Per-stage 401/403/404 is filtered, not persisted as a failed review |

A beta or maintenance tag follows its own channel. A first release on a new channel falls back to a predecessor. The release view names the selected version and rule; see [UI](./ui.md).

### Published downloads and caches

1. Baseline transport: Published `.tgz` uses `downloadPublishedTarball`, outside `NpmStageGateway`; staged tarball uses the gateway (`server/lib/ecosystems/npm/published-tarball.ts`).
1. Credential origin: Validate configured registry origin before attaching npm token; package-controlled hosts never receive it (`server/lib/ecosystems/npm/published-tarball.ts`).
1. Parsing: Parent streams without buffering into credentials-free `downloadInSandboxStream`; hostile baseline decompression/parsing stays sandboxed (`server/lib/sandbox.ts`).
1. Stream caps: Compressed/decompressed `SANDBOX_MAX_STREAM_TAR_BYTES` maps overflow to 413 (`server/lib/sandbox.ts`).
1. Parent limits: Advertised content-length gate plus 2× mid-stream backstop; sandbox must trip first so its degradable 413 survives (`server/lib/ecosystems/npm/published-tarball.ts`).
1. Tarball byte cache: `caches.default`, keyed by tarball URL, shared across organizations (`server/lib/ecosystems/npm/published-tarball.ts`).
1. Cache writes: Background anonymous re-fetch via `ctx.waitUntil`; private tarballs fail anonymous fetch and are not stored (`server/lib/ecosystems/npm/published-tarball.ts`).
1. Cache reads with token: Only `registry.npmjs.org`, whose anonymous/authenticated bytes agree (`PUBLIC_NPM_HOSTS` in `server/lib/ecosystems/npm/published-tarball.ts`).
1. Custom registry cache: Unauthenticated fetches only; `allowInsecureLocalhost` bypasses cache (`server/lib/ecosystems/npm/published-tarball.ts`).
1. Cache warming: Separate download, never a tee that could buffer the serving stream (`server/lib/ecosystems/npm/published-tarball.ts`).
1. Parsed compare cache: `COMPARE_CACHE` KV; immutable payload key includes org scope + registry + tarball URL; reads use colo `cacheTtl` (`server/lib/compare-cache.ts`).

### Persistence and workbench

1. `summary_json.stagedPublish`: Parsed stage identity, tag, actor/access/timestamp, optional npm shasum; tarball verdict `verified` / `mismatch` / `unverified` and compared digests.
1. `summary_json.baseline`: Selected version, staged tag, selection source, current dist-tag target, reason.
1. `scans.previous_version`: Actual parsed version of downloaded comparison tarball.
1. Mid-run baseline: Record after resolution, before deterministic/AI review; retry overwrites; final persist writes again; terminal rows untouched; write failure never fails scan.
1. Failed scan: Clear previous version because no report exists.
1. Published-pair exception: Registry-confirmed requested baseline exists at creation; mid-run recording leaves it alone; failure retains it for `Review again`; completion writes parsed manifest version.
1. Default comparison: Persisted `scans.previous_version`; absent means persisted all-added diff, not the versions endpoint's `defaultPreviousVersion`.
1. Versions endpoint: Before resolution, tag-blind semver predecessor may be an rc; it cannot define the report's default comparison.
1. Alternate comparison: Rebuild tree from selected version's compare payload; show loading/failure until ready; verdict still describes persisted report.
1. Concurrent picks: Payload/failure cache is per version; late responses never replace the displayed comparison.
1. Picker settling: Fetch only after `COMPARE_PICK_SETTLE_MS` in `src/models/scan-detail-model.ts`.
1. Retry: `Try again` in alternate tree or beside picker for recorded baseline.
1. URL state: Only explicit user picks enter `?version=`.
1. Running scan: Prefetch recorded baseline so previous side is ready; payload lacks finding annotations and uses `no-store`.
1. Completion with different/no baseline: Drop mid-run payload for old baseline; later selection refetches with annotations.

## Invariants

1. Baseline failure does not always degrade: only recognized sandbox 413 archive safety limits do; malformed/other download errors still fail the scan (`server/lib/ecosystems/npm/acquire.ts`).
2. AI cannot downgrade deterministic findings; deterministic review runs first (`server/lib/scan/pipeline.ts`).
3. AI review is on by default; Flagship `ai-review` is the organization killswitch (`server/lib/scan/pipeline.ts`).
4. AI evidence is diff-first: ecosystem, normalized manifest diff, delta deterministic findings, changed-file diff and bounded samples (`server/lib/scan/pipeline.ts`).
5. Unchanged AI evidence is limited to deterministic-finding files, recognized manifest script/entrypoint references and package manifests; rank high-signal changes before caps (`server/lib/ai-review/evidence.ts`).
6. Truncating baseline evidence can only lose context matches and classify more findings as release delta (`test/review-diff-annotation.test.mjs`).

### Attribution

Deterministic review covers the entire staged artifact, including unchanged install hooks, native artifacts, credential access and secrets. Classification describes release changes without hiding artifact risk.

1. New/modified risky evidence: Release-delta signal (`server/lib/review/diff-annotation.ts`).
1. Removed risky evidence: Context retained for review (`server/lib/review/diff-annotation.ts`).
1. Unchanged risky evidence: Existing package context unless policy blocks any presence (`server/lib/review/diff-annotation.ts`).
1. Modified file: Release delta when finding line changed or rule pattern touches changed region (`server/lib/review/diff-annotation.ts`).
1. Long replaced line: Trim common prefix/suffix, then bounded character diff; exceeding size/edit bound uses whole middle span and can only retain delta classification (`server/lib/review/changed-regions.ts`).
1. Folded text: Both raw and constant-folded changed text count; newly joined string fragments can introduce a delta match (`server/lib/review/diff-annotation.ts`).
1. No usable line/text evidence: Re-run rules on baseline versions of modified files, with manifests; same rule + file becomes context; unchanged files are not re-scanned (`server/lib/review/diff-annotation.ts`).
1. No baseline counterpart: Fails open to release delta: missing evidence makes report louder, never quieter (`server/lib/review/diff-annotation.ts`).
1. Baseline text: Cap each body at `BASELINE_TEXT_SAMPLE_LIMIT`; manifests exempt; clipped body has `baseline-truncated`; reviewed side never capped (`server/lib/sample-retention.ts`).
1. Previous-version UI text: Baseline samples are never persisted; separate `/compare` downloads/caches published tarball (`server/lib/compare-cache.ts`).

| Limit / bound | Contract | Owner |
| --- | --- | --- |
| Long-line threshold | Over 1 KiB: `LONG_LINE_CHARS` | `server/lib/review/changed-regions.ts` |
| Match margin | Within 256 characters: `CHANGED_SPAN_MARGIN` | `server/lib/review/changed-regions.ts` |

1. Same capability in modified predecessor: Persist/show `releaseDeltaKind: "expanded"`; release score one step lower; artifact score unaffected.
1. Capability co-occurrence: Still counts, across files and expanded capabilities; two delta capabilities retain high floor.
1. New rule in file, obfuscated match, newly folded capability match: Full scoring.
1. New URL host, quoted hostname, IP absent from baseline package: Full scoring.
1. Credential access, dynamic evaluation, standing-danger rules: Never expanded.
1. Unreadable changes: Never expanded.

1. Candidates: Added JS/TS with removed predecessor in same directory and extension; one-to-one; content only, never trust filename hash.
1. Persisted tree/finding status: Added entry records `renamedFrom`; `diffStatus: "added"` remains.
1. Rules and attribution: Modified-file severity and predecessor text; no `diff.large-new-file`; changed spans, baseline findings, install reachability and expanded logic all use predecessor bytes.
1. No pair / budget exceeded / predecessor unavailable: Full added-file treatment.
1. Split/merged chunks below similarity bar: Full added-file treatment.
1. Injection check: Spliced renamed payload must raise release risk like an in-place edit; `renamed` shapes in [detection eval](./detection-eval.md).

| Limit / bound | Contract | Owner |
| --- | --- | --- |
| Similarity | Statement shingles collapse short identifiers/numbers; Jaccard at least 0.8 (`MIN_SIMILARITY`); best pairs first | `server/lib/review/renamed-files.ts` |
| Work bound | Leading `BASELINE_TEXT_SAMPLE_LIMIT` (`SHINGLE_WINDOW`) on both sides; per-diff character budget | `server/lib/review/renamed-files.ts` |

1. `releaseRisk`: Delta findings; complete AI risk contributes only when an AI finding is delta; all-unchanged AI findings remain context, with manual-review floor medium below gate blocking threshold; no-finding AI review is scored wholesale.
1. `artifactRisk`: Full reviewed-artifact evidence plus complete AI result when enabled; primary `scans.risk`; only [prior-approved context](./release-memory.md) may be discounted, never release-delta findings.
1. `contextRisk`: Findings outside release delta.
1. Missing breakdown on older report: Interpret `scans.risk` as artifact risk; derive release/context risk from persisted annotations.

## Failure modes

| Condition | Cause | What happens | Fix |
| --- | --- | --- | --- |
| No candidate/tarball/metadata | Unavailable comparison | All-added review; reason persisted | Inspect selection reason and registry metadata |
| Baseline 413 size/expansion cap | Recognized safety limit | All-added review; reason suffix `:baseline-too-large` | Compare a bounded published artifact |
| Baseline 413 entry cap | Too many files | All-added review; reason suffix `:baseline-too-many-files` | Inspect archive layout |
| Malformed baseline / other fetch failure | Not a degradable safety limit | Scan fails | Repair artifact/registry access; retry |
| Stage identity disagrees with `package.json` | Metadata/bytes mismatch | Critical `stage.metadata-mismatch`; suppress tag selection | Check fresh stage identity |
| SHA-1 wire digest disagrees with stage shasum | Metadata/bytes mismatch | Critical `stage.tarball-digest-mismatch` only after fresh stage confirmation | Restage matching bytes |
| Initial mismatch | Separate metadata/bytes requests | Refresh stage; replacement snapshot drives merge, baseline and persistence | Inspect confirmed snapshot |
| Missing/invalid digest, incomplete bytes, digest cap, confirmation unavailable | Insufficient binding evidence | `unverified`, never guessed mismatch; workbench/export show verdict even if detail fetch failed | Obtain complete stage evidence |

## Change checklist

| If you change | Also update | Run |
| --- | --- | --- |
| Selector / acquisition | Reason tables and [npm staged publishing](./npm-staged-publishing.md) | `pnpm exec vitest run --project node test/registry.test.mjs test/npm-acquire.test.mjs` |
| Attribution / risk / rename pairing | [Detection eval](./detection-eval.md) and persisted annotations | `pnpm exec vitest run --project node test/review-diff-annotation.test.mjs test/review-risk.test.mjs test/review-renamed-files.test.mjs test/review-changed-regions.test.mjs` |
| Compare UI / persistence | Workbench state contract | `pnpm exec vitest run --project node test/scan-detail-comparison-model.test.ts` |
