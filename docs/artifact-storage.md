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

D1 still keeps scan status/lifecycle fields, ownership, package/version metadata, decisions, compact list summaries, report digest/version, file metadata, and findings. Artifact-backed new scans write `scan_files` rows with `text_sample = NULL`; the redacted samples live in R2. Existing rows keep their historical `scan_files.text_sample` values until a later explicit compaction step.

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

User-initiated report downloads serve the same canonical `report.json` bytes with a package-scoped filename: `drydock-{package-name}-{version}.json`. Package names are normalized to a path-safe filename segment for the `Content-Disposition` header. Dashboard download links include the active organization as a validated query parameter because native browser downloads cannot attach the dashboard's `x-organization-id` fetch header.

## Write And Read Flow

New completed scans try to write `report.json`, `files.json`, `diff.json`, and `manifest.json` to R2 before `persistScan` marks the D1 row artifact-backed. Each object is read back and verified against its expected size and SHA-256 digest before D1 metadata is saved. Transient write or verification failures are retried; exhausted failures log `scan.artifacts.write_failed` and fail closed so the scan can retry instead of persisting new file samples into D1. When the R2 write succeeds, D1 stores compact file metadata only and leaves `scan_files.text_sample` null.

`GET /api/v1/scans/:id` shadow-reads R2 when all artifact metadata exists. The read path verifies:

- manifest key, size, and digest;
- manifest scan/org identity and object-key references;
- report object digest against `scans.report_digest`;
- file/diff payload shape.

Any mismatch, missing object, invalid payload, or R2 read failure logs `scan.artifacts.fallback_read` and returns the existing D1-backed detail instead. For artifact-backed scans created after this rollout, that fallback keeps file metadata and findings readable but does not include redacted file text samples because new samples are not duplicated into D1.

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

## Rollback

Set `SCAN_ARTIFACT_READS_DISABLED=true` (or `1`) to force scan-detail reads back to D1 while leaving R2 artifacts untouched. Do not delete R2 objects during rollback. This restores historical D1-backed samples for old rows; new artifact-backed rows continue to show compact file metadata without samples until R2 reads are re-enabled.

D1 compaction is a later explicit step after backfill and shadow-read confidence. Compaction must not run until operators are comfortable with fallback/read metrics and have a separate rollback plan for any compacted rows.
