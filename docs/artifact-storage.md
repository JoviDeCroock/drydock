# Scan Artifact Storage

Drydock keeps D1 as the authoritative metadata/index store and uses R2 for the large redacted derived artifacts. Raw tarballs are still not retained by default.

R2 is the **only** store for a completed scan's body. There is no D1 copy and no D1 fallback: `scan_files` and `scan_findings` were dropped in migration `0028`, and the `ARTIFACTS` binding is required.

## Provisioning

Wrangler binds the artifact bucket as `ARTIFACTS`. The binding is required — a Worker without it cannot persist a completed scan:

```sh
wrangler r2 bucket create staged-publish-review-artifacts
```

Local Worker tests bind `staged-publish-review-test-artifacts` through `test/config/wrangler.jsonc`. Production deploys should confirm the bucket exists before applying the migration that adds the artifact metadata columns.

## D1 Metadata

A completed scan points at its artifact set through these `scans` columns:

- `artifact_storage_version`
- `artifact_manifest_key`
- `artifact_manifest_digest`
- `artifact_manifest_size`
- `report_artifact_key`
- `file_samples_artifact_key`
- `diff_artifact_key`

D1 keeps scan status/lifecycle fields, ownership, package/version metadata, decisions, compact list summaries (including `risk_summary_json` and the summary-embedded diff), and report digest/version — and nothing else about the scan. The per-row detail (file metadata, redacted samples, diff, deterministic findings) is read back from `files.json` / `diff.json` / `report.json`.

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

User-initiated report downloads serve the same canonical `report.json` bytes with a package-scoped filename: `drydock-{package-name}-{version}.json`. The export's `findings[]` stays deterministic-only (every entry keeps its `ruleId`/`ruleVersion`); the advisory AI review, when one exists, is carried separately in the export's `aiReview` block, so AI findings are never double-listed. Package names are normalized to a path-safe filename segment for the `Content-Disposition` header. Dashboard download links include the active organization as a validated query parameter because native browser downloads cannot attach the dashboard's `x-organization-id` fetch header.

## Write And Read Flow

Completed scans write `report.json`, `files.json`, `diff.json`, and `manifest.json` to R2 before `persistScan` writes the D1 row. Each object is read back and verified against its expected size and SHA-256 digest before D1 metadata is saved. Transient write or verification failures are retried; exhausted failures log `scan.artifacts.write_failed` and fail closed so the scan can retry. A missing `ARTIFACTS` binding logs `scan.artifacts.binding_missing` and throws for the same reason: there is no second place to put the body.

`GET /api/v1/scans/:id` returns scan metadata, findings, events, and file metadata without staged file bodies. Findings cover both deterministic rules (`source: "rule"`) and a completed AI review's findings (`source: "ai"`), the latter derived from the verified report's `aiFindings` envelope and appended after `ruleFindings` in the same combined order the report's `findingAnnotations` index over. Both sources count into `finding_count` and the risk summary; AI findings stay advisory and never alter rule findings. The dashboard fetches a selected staged body on demand through:

```http
GET /api/v1/scans/:id/file?path=package.json
```

Both the detail read and the file-body read go to R2. The artifact read path verifies:

- manifest key, size, and digest;
- manifest scan/org identity and object-key references;
- on the detail read, the `report.json` digest against `scans.report_digest` (the findings are parsed from that verified report);
- each object's size + digest against the manifest descriptor, and the file/diff payload shape.

Any mismatch, missing object, invalid payload, or R2 read failure logs `scan.artifacts.fallback_read` and degrades to the D1 metadata: the scan row, its risk summary, and the summary-embedded diff render, with no file samples and no findings. It never fails the request and never serves unverified bytes. This is the single-source-of-truth tradeoff; there is nothing to fall back to, so `SCAN_ARTIFACT_READS_DISABLED` is a read kill-switch, not a recovery path.

Release memory reads a prior approved scan's rule findings through the same path. An unreadable report there yields **no profile** rather than an empty one, so a transient R2 failure cannot make a routine release read as `diverged`.

## Deletion Lifecycle

R2 artifacts are torn down whenever the D1 rows that point at them are deleted, so redacted evidence never outlives its metadata:

- **Organization deletion** (`deleteOrganization`) removes every object under `orgs/{organizationId}/` after the D1 batch completes.
- **Account deletion** (`deleteUserAccount`, invoked by the Better Auth `beforeDelete` hook) deletes each owned organization through `deleteOrganization`, so the personal-workspace and any sole-owned org artifacts go with it.
- **Gate re-run discard** (`discardGateScans`) deletes the per-scan prefixes `orgs/{organizationId}/scans/{scanId}/` for the scans it discards, since a prior attempt may have completed some packages and written their artifacts.
- **Failed-scan deletion** (`DELETE /api/v1/scans/:id`) conditionally deletes only an organization-owned `failed` row, cascades its scan events, records an organization audit event, and sweeps the per-scan R2 prefix.

Deletion uses the raw `ARTIFACTS` binding, not the read-gated bucket: `SCAN_ARTIFACT_READS_DISABLED` is a read kill-switch and must not strand objects. The delete prefixes intentionally stop before the `v{N}` segment so a cleanup removes every storage version. Cleanup is fail-soft — a delete error is logged (`scan.artifacts.delete_failed`) but never thrown, so it cannot abort the surrounding D1 teardown; a leaked object is recoverable by re-running the prefix sweep. A successful sweep logs `scan.artifacts.deleted` with the object count. Pending/running scans that are discarded before completion (`discardScanAttempt`, `deletePendingScanJob`) carry no artifacts, so they skip R2 cleanup.

## Time-Based Retention

`server/lib/retention.ts` runs on every scheduled tick, after the discovery sweep. Three of its sweeps are unconditional storage hygiene — audit events past `AUDIT_LOG_RETENTION_DAYS` (see [`audit-log.md`](./audit-log.md)), expired Better Auth `session` rows, and expired `verification` tokens. The fourth deletes reviews, so it is **off unless an operator opts in**:

| Setting               | Default         | Meaning                                                                         |
| --------------------- | --------------- | ------------------------------------------------------------------------------- |
| `SCAN_RETENTION_DAYS` | unset (**off**) | Delete scans created more than N days ago. Must be ≥ `SCAN_RETENTION_MIN_DAYS`. |

Unset, unparseable, non-positive, or below the floor all mean "delete nothing" and log `retention.scans.misconfigured`. Scan deletion is irreversible and the review history is what release memory reads, so a mistyped window fails safe instead of emptying the table.

When enabled, each tick deletes at most `SCAN_RETENTION_MAX_PER_TICK` scans (oldest first, via the `scans_created_idx` index); a backlog drains across ticks. Per scan the sweep:

1. Clears the artifact-metadata columns, so the row stops claiming objects that are about to be deleted.
2. Sweeps the per-scan R2 prefix. **If the sweep fails, the D1 row is left in place** (counted as `deferred`) and the next tick retries.
3. Preserves audit events still inside their retention window, then deletes the organization-scoped `scans` row.

Step 1 is what makes step 3 survivable. Sweeping R2 first and then failing the row delete would leave a row that still claims to be artifact-backed while its evidence is gone. An orphaned R2 object is recoverable by re-running a prefix sweep; a scan that reads clean because its evidence was deleted is not. With this ordering the worst residual state is a metadata-only row that is honest about having no detail and that the next tick finishes.

Each candidate is wrapped individually, so one failure cannot abort the rest of the backlog. Two kinds of row are excluded from the candidate query rather than deferred, because a permanently-deferred row at the head of a fixed-size oldest-first page would starve every deletable row behind it: scans with no `organization_id` (the org was deleted, so there is no prefix to sweep and no scope for the delete) and scans attached to a **still-pending** workflow gate (deleting one would null a live gate's `scan_id`). Transiently deferred rows are paged past within the same tick for the same reason.

`scan_events` is handled separately, because it doubles as the organization audit log on its own flat 90-day window: only events already past **that** window are deleted with the scan. Newer ones are detached (`scan_id` set to null) so a recent `scan.decided` entry is not deleted at one day old just because its scan aged out. See [`audit-log.md`](./audit-log.md#retention).

The sweep **requires the `ARTIFACTS` binding**: without it there is no way to reach a scan's objects, so it logs `retention.scans.skipped` and deletes nothing. Every sweep is bounded (LIMIT + iterate with a per-tick batch cap) and independently wrapped, so one failure neither stops the others nor throws into the scheduled handler.

Deleting a `publish`-decided scan also removes it from release memory: a later release of the same package will find no prior approved scan and score as it did before release memory existed. That is inherent to a retention window, not a regression.

## Rollback

`SCAN_ARTIFACT_READS_DISABLED=true` (or `1`) stops scan-detail reads from touching R2 while leaving the objects untouched. There is no D1 detail copy to fall back to, so completed scans render as metadata only. Their diff falls back to the [compacted summary embed](#summary-diff-compaction), which is the capped release delta and is labelled as truncated; the headline changed-file count still comes from `scans.changed_file_count`. Treat the setting as a containment switch for a suspect bucket, not a rollback. The routine lever for a suspect object is digest/size verification, which already fails closed to the same metadata view.

## D1 Detail Removal

`scan_files` and `scan_findings` are gone (migration `0028_deep_vindicator.sql`). They were last written on the degraded path — a Worker with no `ARTIFACTS` binding — which is now a hard error instead. `persistScan` therefore writes exactly one row per scan and takes its `artifacts` metadata as a required input.

Legacy scans written before artifact storage had their bodies in those tables; they were migrated with the (now removed) artifact backfill before the drop. A pre-artifact scan that was never backfilled keeps its metadata row and renders as metadata only.
