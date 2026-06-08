# Scan Artifact Storage

Drydock keeps D1 as the authoritative metadata/index store and uses R2 for large redacted derived artifacts. Raw tarballs are still not retained by default.

## Provisioning

Wrangler binds the artifact bucket as `ARTIFACTS`:

```sh
wrangler r2 bucket create staged-publish-review-artifacts
```

Local Worker tests bind `staged-publish-review-test-artifacts` through `wrangler.test.jsonc`. Production deploys should confirm the bucket exists before applying the migration that adds the artifact metadata columns.

## D1 Metadata

Completed scans can be artifact-backed when these `scans` columns are set:

- `artifact_storage_version`
- `artifact_manifest_key`
- `artifact_manifest_digest`
- `artifact_manifest_size`
- `report_artifact_key`
- `file_samples_artifact_key`
- `diff_artifact_key`

D1 still keeps scan status/lifecycle fields, ownership, package/version metadata, decisions, compact list summaries, report digest/version, file metadata, and findings. The first rollout keeps existing `scan_files.text_sample` values so reads can fall back without data loss.

## Object Layout

Version 1 artifact keys are:

```text
orgs/{organizationId}/scans/{scanId}/v1/manifest.json
orgs/{organizationId}/scans/{scanId}/v1/report.json
orgs/{organizationId}/scans/{scanId}/v1/files.json
orgs/{organizationId}/scans/{scanId}/v1/diff.json
```

Path segments are URL-encoded with `%` replaced by `~` so object keys stay path-safe.

The manifest records each object key, SHA-256 digest, byte size, content type, and count where applicable. `report.json` is the canonical report JSON whose digest must equal `scans.report_digest`. `files.json` stores redacted staged file samples plus file metadata. `diff.json` stores the generated file diff.

## Write And Read Flow

New completed scans write `report.json`, `files.json`, `diff.json`, and `manifest.json` to R2 before `persistScan` marks the D1 row artifact-backed. Each object is read back and verified against its expected size and SHA-256 digest before D1 metadata is saved.

`GET /api/v1/scans/:id` shadow-reads R2 when all artifact metadata exists. The read path verifies:

- manifest key, size, and digest;
- manifest scan/org identity and object-key references;
- report object digest against `scans.report_digest`;
- file/diff payload shape.

Any mismatch, missing object, invalid payload, or R2 read failure logs `scan.artifacts.fallback_read` and returns the existing D1-backed detail instead.

## Backfill

Owners/admins can backfill old completed scans for their active organization:

```http
POST /api/v1/scans/artifacts/backfill
Content-Type: application/json

{ "limit": 10, "cursor": null }
```

The route processes small idempotent batches and returns counts for `scanned`, `backfilled`, `alreadyBacked`, `digestMismatch`, `failed`, and `nextCursor`. A legacy row is marked artifact-backed only after the reconstructed canonical report digest equals the persisted `report_digest`; rows that cannot be reconstructed exactly stay D1-backed.

## Rollback

Set `SCAN_ARTIFACT_READS_DISABLED=true` (or `1`) to force scan-detail reads back to D1 while leaving R2 artifacts untouched. Do not delete R2 objects during rollback. In this first rollout D1 text samples are retained, so disabling artifact reads restores the pre-R2 read path.

D1 compaction is a later explicit step after backfill and shadow-read confidence. Compaction must not run until operators are comfortable with fallback/read metrics and have a separate rollback plan for any compacted rows.
