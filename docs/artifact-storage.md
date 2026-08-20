# Scan Artifact Storage

Drydock keeps D1 as the authoritative metadata/index store and uses R2 for large redacted derived artifacts. Raw tarballs are still not retained by default.

## Provisioning

Wrangler binds the artifact bucket as `ARTIFACTS`:

```sh
wrangler r2 bucket create staged-publish-review-artifacts
```

Local Worker tests bind `staged-publish-review-test-artifacts` through `test/config/wrangler.jsonc`. Production deploys should confirm the bucket exists before applying the migration that adds the artifact metadata columns.

## D1 Metadata

Completed scans can be artifact-backed when these `scans` columns are set:

- `artifact_storage_version`
- `artifact_manifest_key`
- `artifact_manifest_digest`
- `artifact_manifest_size`
- `report_artifact_key`
- `file_samples_artifact_key`
- `diff_artifact_key`

D1 still keeps scan status/lifecycle fields, ownership, package/version metadata, decisions, compact list summaries (including `risk_summary_json` and the summary-embedded diff), and report digest/version. The per-row detail — `scan_files` and `scan_findings` — is **no longer duplicated into D1 for artifact-backed scans**: once the R2 write succeeds, `persistScan` skips those inserts entirely and the detail (file metadata, redacted samples, diff, deterministic findings) is read back from `files.json` / `diff.json` / `report.json`. The detail rows are written only on the degraded path (no `ARTIFACTS` binding, so the R2 write was skipped and the scan falls back to D1). Legacy rows written before this change keep their historical `scan_files` / `scan_findings` content; the read path prefers R2 for any scan that carries artifact metadata.

## Object Layout

Version 1 artifact keys are:

```text
orgs/{organizationId}/scans/{scanId}/v1/manifest.json
orgs/{organizationId}/scans/{scanId}/v1/report.json
orgs/{organizationId}/scans/{scanId}/v1/files.json
orgs/{organizationId}/scans/{scanId}/v1/diff.json
orgs/{organizationId}/scans/{scanId}/v1/ai-input.{digest16}.json (transient; deferred AI review only)
orgs/{organizationId}/scans/{scanId}/v1/report.{digest16}.json  (republished report; see below)
orgs/{organizationId}/scans/{scanId}/v1/manifest.{digest16}.json
```

Path segments are URL-encoded with `%` replaced by `~` so object keys stay path-safe.

The manifest records each object key, SHA-256 digest, byte size, content type, and count where applicable. `report.json` is the canonical report JSON whose digest must equal `scans.report_digest`. `files.json` stores redacted staged file samples plus file metadata. `diff.json` stores the generated file diff.

`report.json` and `files.json`/`diff.json` are written concurrently (each still read back and digest-verified before the manifest is written). A failed attempt therefore re-puts all three rather than resuming, which is wasted work but never corruption: keys are content paths and every object is verified on read-back.

User-initiated report downloads serve the same canonical `report.json` bytes with a package-scoped filename: `drydock-{package-name}-{version}.json`. The export's `findings[]` stays deterministic-only (every entry keeps its `ruleId`/`ruleVersion`); the advisory AI review, when one exists, is carried separately in the export's `aiReview` block, so AI findings are never double-listed. That block can read `status: "pending"` — a completed scan whose deferred review has not landed is exportable, and its risk grades can still rise afterwards. The export is a snapshot; re-exporting once the review lands carries the finished review and the final grades. Package names are normalized to a path-safe filename segment for the `Content-Disposition` header. Dashboard download links include the active organization as a validated query parameter because native browser downloads cannot attach the dashboard's `x-organization-id` fetch header.

## Write And Read Flow

New completed scans try to write `report.json`, `files.json`, `diff.json`, and `manifest.json` to R2 before `persistScan` marks the D1 row artifact-backed. Each object is read back and verified against its expected size and SHA-256 digest before D1 metadata is saved. Transient write or verification failures are retried; exhausted failures log `scan.artifacts.write_failed` and fail closed so the scan can retry instead of persisting detail into D1. When the R2 write succeeds, D1 stores the scan metadata row only — no `scan_files` or `scan_findings` rows are written, so the redacted samples, file metadata, diff, and findings live exclusively in R2.

`GET /api/v1/scans/:id` returns scan metadata, findings, events, and file metadata without staged file bodies. Findings cover both deterministic rules (`source: "rule"`) and a completed AI review's findings (`source: "ai"`): the degraded path persists AI rows into `scan_findings` after the rule rows, and the artifact read path derives them from `scans.ai_json` (falling back to the verified report's own `aiFindings` envelope), appended after `ruleFindings` in the same combined order the report's `findingAnnotations` index over. Both sources count into `finding_count` and the risk summary; AI rows stay advisory and never alter rule rows. For artifact-backed scans the findings, diff, and file metadata come from R2 (`report.json` / `diff.json` / `files.json`); legacy and degraded scans read them from the D1 `scan_findings` / `scan_files` rows. The dashboard fetches a selected staged body on demand through:

```http
GET /api/v1/scans/:id/file?path=package.json
```

Both the detail read and the file-body read shadow-read R2 when all artifact metadata exists. The artifact read path verifies:

- manifest key, size, and digest;
- manifest scan/org identity and object-key references;
- on the detail read, the `report.json` digest against `scans.report_digest` (the findings are parsed from that verified report);
- each object's size + digest against the manifest descriptor, and the file/diff payload shape.

Any mismatch, missing object, invalid payload, or R2 read failure logs `scan.artifacts.fallback_read` and returns the D1-backed detail instead. For scans created before D1 detail compaction (or written on the degraded path), that fallback still returns the D1 `scan_files` / `scan_findings` rows. For compacted artifact-backed scans the detail rows do not exist in D1, so a fallback read returns the scan metadata, risk summary, and the summary-embedded diff but no file samples or findings — the read degrades gracefully rather than failing. This is the single-source-of-truth tradeoff the compaction accepts; `SCAN_ARTIFACT_READS_DISABLED` is not a recovery path for these rows because the data is no longer in D1.

## Deferred AI Review

Staged-publish scans persist before the advisory AI review runs (see [`architecture.md`](./architecture.md#advisory-ai-review-is-off-the-critical-path)), which adds two things to this layer.

**`ai-input.{digest16}.json` — the reviewer's evidence snapshot.** Written before the scan row is persisted, so a scan never advertises a pending review whose evidence is missing. It carries redacted staged and baseline file metadata plus a bounded text-sample subset, the diff, the manifest diff, the release-delta rule findings, and what the patch needs to re-score without re-parsing anything: the deterministic findings with their diff annotations, the release-consistency result, the code-pattern set, and the baseline-comparison flag. Finding paths and package manifests are retained first, then changed paths and unchanged context; both sides of a path are kept or omitted together, each retained sample is clipped to the display-sample bound, and the combined deferred text budget is 2 Mi characters. Omitted records keep their path, size, digest, and flags and gain `sample-omitted`. This bounds the stable-JSON/hash/R2 verification copies inside the Worker without narrowing deterministic inspection. Its key, digest, and size are recorded in `summary_json.aiReviewInput`, and the follow-up message carries identifiers only, so the object is digest-verified on read like every other artifact. Content-addressing also keeps overlapping attempts from overwriting one another. A losing attempt re-reads the winning scan row before deleting its exact object; it preserves the object when the winner references the same evidence and removes only an unreferenced digest.

Security posture: this is post-sandbox, post-redaction data at the same trust level as `files.json` — not raw package bytes, and nothing credential-derived. It is deleted as soon as the review reaches a terminal state (and its descriptor is removed from `summary_json` in the same patch), and it sits under the per-scan prefix so the existing organization/scan delete sweeps reclaim it regardless.

**Report republication.** When the review lands, the report has to change: `aiFindings`, `risk`, and the index-based `findingAnnotations` all move. The patch writes a **new, content-addressed** `report.{digest16}.json` + `manifest.{digest16}.json` instead of rewriting in place, then flips `report_digest`, `report_artifact_key`, `artifact_manifest_key`, `artifact_manifest_digest`, and `artifact_manifest_size` in the same statement that flips `ai_status`. Rewriting in place would leave a window where R2 holds bytes whose digest is not the one D1 recorded, and the read path (correctly) refuses that pair — a compacted artifact-backed scan would serve metadata only until D1 caught up. With new keys the old pair stays valid until the single D1 write swaps it, so a reader sees either the pre-AI report or the patched one. Two concurrent follow-ups cannot collide either, since different reviews hash to different keys. The pre-AI `report.json` is left in place (it is small, and it is reclaimed by the per-scan prefix sweep).

**Retention.** A patched scan keeps its superseded pre-AI `report.json` and
`manifest.json` alongside the republished pair — roughly 2x the report objects
(the report holds findings, diff, and manifest metadata, not file samples, so
this is tens of KB per scan, not the bulk of a scan's storage). They are left in
place deliberately: deleting the old pair the moment D1 flips would race a
concurrent reader mid-verification for no meaningful saving. Both are reclaimed
by the per-scan and per-organization prefix sweeps on scan or organization
deletion, which stop before the `v{N}` segment and so match every revision. A
losing concurrent follow-up also reclaims the revision it wrote — but only after
re-reading the row and confirming D1 does not reference those keys, because two
deliveries that produce identical bytes produce identical keys.

**Which store wins.** D1's `ai_json` is authoritative for the advisory review: the artifact read path derives `source: "ai"` finding rows from `scans.ai_json` when the caller has it, falling back to the report's own `aiFindings` envelope otherwise. That ordering matters only in one case — the D1 patch succeeded but the republication did not — and there the column is the one that is right. On the degraded (no `ARTIFACTS` binding) path the AI findings are inserted as `scan_findings` rows after the rule rows, with their annotations appended to `summary_json.findingAnnotations` so they are not re-derived by a read that has no baseline files. Deferral requires an `ARTIFACTS` bucket, so in practice a deferred review always patches the artifact-backed path; the row path stays supported for D1-backed scans.

The patch is claimed by `ai_status = "pending"`: only the first follow-up for a scan sees a returned row, so a duplicated or replayed message cannot double-count AI findings. `finding_count`, `risk`, `risk_summary_json`, and `summary_json.risk` are all updated in that same statement.

## Backfill

The Worker exposes an owner/admin backfill route for app-level maintenance:

```http
POST /api/v1/scans/artifacts/backfill
Content-Type: application/json

{ "limit": 10, "cursor": null }
```

The route processes small idempotent batches and returns counts for `scanned`, `backfilled`, `alreadyBacked`, `digestMismatch`, `failed`, and `nextCursor`. A legacy row is marked artifact-backed only after the reconstructed canonical report digest equals the persisted `report_digest`; rows that cannot be reconstructed exactly stay D1-backed.

Production operators should use the repo-local runner instead of browser cookies. It uses the same Cloudflare credentials as Wrangler, reads from D1 with `wrangler d1 execute --json`, writes verified R2 objects with `wrangler r2 object put/get`, then updates D1 artifact metadata:

```sh
pnpm exec wrangler login
pnpm run scan-artifacts:backfill -- \
  --organization-id org_... \
  --limit 50
```

To process every organization in D1:

```sh
pnpm run scan-artifacts:backfill -- \
  --all-organizations \
  --limit 50
```

The script defaults to the production `staged-publish-review` D1 database and `staged-publish-review-artifacts` R2 bucket through remote Wrangler operations. Use `--database`, `--bucket`, `--config`, `--env`, `--local`, or `--persist-to` when targeting a different Wrangler setup. The script prints one progress line per batch and exits nonzero if any row-level `failed` count remains. Use `--cursor <scan_id>` to resume a single-organization run from the last printed `nextCursor`; `--cursor` is intentionally not accepted with `--all-organizations` because cursors are organization-scoped. `digestMismatch` rows are reported but do not fail the script because they remain safely D1-backed.

## Deletion Lifecycle

R2 artifacts are torn down whenever the D1 rows that point at them are deleted, so redacted evidence never outlives its metadata:

- **Organization deletion** (`deleteOrganization`) removes every object under `orgs/{organizationId}/` after the D1 batch completes.
- **Account deletion** (`deleteUserAccount`, invoked by the Better Auth `beforeDelete` hook) deletes each owned organization through `deleteOrganization`, so the personal-workspace and any sole-owned org artifacts go with it.
- **Gate re-run discard** (`discardGateScans`) deletes the per-scan prefixes `orgs/{organizationId}/scans/{scanId}/` for the scans it discards, since a prior attempt may have completed some packages and written their artifacts.
- **Failed-scan deletion** (`DELETE /api/v1/scans/:id`) conditionally deletes only an organization-owned `failed` row, cascades its D1 detail/events, records an organization audit event, and sweeps the per-scan R2 prefix.

Deletion uses the raw `ARTIFACTS` binding, not the read-gated bucket: `SCAN_ARTIFACT_READS_DISABLED` is a read kill-switch and must not strand objects. The delete prefixes intentionally stop before the `v{N}` segment so a cleanup removes every storage version. Cleanup is fail-soft — a delete error is logged (`scan.artifacts.delete_failed`) but never thrown, so it cannot abort the surrounding D1 teardown; a leaked object is recoverable by re-running the prefix sweep. A successful sweep logs `scan.artifacts.deleted` with the object count. Scans discarded before completion (`discardScanAttempt`, which tombstones a withdrawn stage rather than deleting the row, and `deletePendingScanJob`) carry no artifacts, so they skip R2 cleanup. A deferred review's content-addressed AI input is deleted by the review patch itself; if that delete fails it is logged (`scan.artifacts.ai_input_delete_failed`), never thrown, and reclaimed by the per-scan prefix sweep.

Time-based retention (a TTL sweep that deletes old scans on a schedule) is not yet implemented and is tracked separately.

## Rollback

Set `SCAN_ARTIFACT_READS_DISABLED=true` (or `1`) to force scan-detail reads back to D1 while leaving R2 artifacts untouched. Do not delete R2 objects during rollback. This restores D1-backed detail for legacy/degraded rows that still have `scan_files` / `scan_findings` content. It does **not** recover detail for compacted artifact-backed scans (the rows were never written), so disabling reads for those rows shows metadata only — keep R2 reads enabled for them. The safe operational lever for a suspect R2 read remains the per-object digest/size verification, which already fails closed to the metadata view.

## D1 Detail Compaction

New artifact-backed scans are compacted at write time: `persistScan` no longer duplicates `scan_files` / `scan_findings` into D1 once the R2 write is verified (see `server/db/scans.ts`). R2 is therefore the single source of truth for file samples, file metadata, the diff, and deterministic findings on those scans. The degraded path (no `ARTIFACTS` binding) still writes the detail to D1 so a scan that cannot reach R2 stays fully readable. Legacy rows written before this change are unaffected until an explicit one-time D1 cleanup of their now-redundant detail rows — that cleanup is still a separate, deliberate step and must only target rows that already carry verified artifact metadata.
