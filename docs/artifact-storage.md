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

D1 still keeps scan status/lifecycle fields, ownership, package/version metadata, decisions, compact list summaries (including `risk_summary_json`, `finding_profile_json`, and the [compacted summary diff](#summary-diff-compaction)), and report digest/version. The per-row detail — `scan_files` and `scan_findings` — is **no longer duplicated into D1 for artifact-backed scans**: once the R2 write succeeds, `persistScan` skips those inserts entirely and the detail (file metadata, redacted samples, diff, deterministic findings) is read back from `files.json` / `diff.json` / `report.json`. The detail rows are written only on the degraded path (no `ARTIFACTS` binding, so the R2 write was skipped and the scan falls back to D1). Legacy rows written before this change keep their historical `scan_files` / `scan_findings` content; the read path prefers R2 for any scan that carries artifact metadata.

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

New completed scans try to write `report.json`, `files.json`, `diff.json`, and `manifest.json` to R2 before `persistScan` marks the D1 row artifact-backed. Each object is read back and verified against its expected size and SHA-256 digest before D1 metadata is saved. Transient write or verification failures are retried; exhausted failures log `scan.artifacts.write_failed` and fail closed so the scan can retry instead of persisting detail into D1. When the R2 write succeeds, D1 stores the scan metadata row only — no `scan_files` or `scan_findings` rows are written, so the redacted samples, file metadata, diff, and findings live exclusively in R2.

`GET /api/v1/scans/:id` returns scan metadata, findings, events, and file metadata without staged file bodies. Findings cover both deterministic rules (`source: "rule"`) and a completed AI review's findings (`source: "ai"`): the degraded path persists AI rows into `scan_findings` after the rule rows, and the artifact read path derives them from the verified report's `aiFindings` envelope, appended after `ruleFindings` in the same combined order the report's `findingAnnotations` index over. Both sources count into `finding_count` and the risk summary; AI rows stay advisory and never alter rule rows. For artifact-backed scans the findings, diff, and file metadata come from R2 (`report.json` / `diff.json` / `files.json`); legacy and degraded scans read them from the D1 `scan_findings` / `scan_files` rows. The dashboard fetches a selected staged body on demand through:

```http
GET /api/v1/scans/:id/file?path=package.json
```

Both the detail read and the file-body read shadow-read R2 when all artifact metadata exists. The artifact read path verifies:

- manifest key, size, and digest;
- manifest scan/org identity and object-key references;
- on the detail read, the `report.json` digest against `scans.report_digest` (the findings are parsed from that verified report);
- each object's size + digest against the manifest descriptor, and the file/diff payload shape.

Any mismatch, missing object, invalid payload, or R2 read failure logs `scan.artifacts.fallback_read` and returns the D1-backed detail instead. For scans created before D1 detail compaction (or written on the degraded path), that fallback still returns the D1 `scan_files` / `scan_findings` rows. For compacted artifact-backed scans the detail rows do not exist in D1, so a fallback read returns the scan metadata, risk summary, and the summary-embedded diff but no file samples or findings — the read degrades gracefully rather than failing. This is the single-source-of-truth tradeoff the compaction accepts; `SCAN_ARTIFACT_READS_DISABLED` is not a recovery path for these rows because the data is no longer in D1.

When the artifact read succeeds, the scan-detail response also carries the R2-sourced diff as its own `diff` field. That is the complete file diff (from `report.json` / `diff.json`); readers prefer it and fall back to the summary embed, which is the whole diff on legacy/degraded rows and the compacted release delta on artifact-backed ones.

## Summary Diff Compaction

`scans.summary_json` used to embed the whole file diff — one entry per file including every unchanged one, up to the parser's file cap, each carrying two sha256 hex digests. For an artifact-backed scan that is duplication of large immutable data in the metadata store, but it is not dead: it is the last-resort copy behind the fallback read above. So it is compacted rather than dropped (`server/lib/scan/summary-diff.ts`):

- `summary.diff` keeps only the release delta — `added` / `removed` / `modified` entries — with `path`, `status`, the two optional sizes, and `flags`. `previousSha256` / `stagedSha256` are dropped: no reader consumes them off a diff entry, and `files.json` / `scan_files` already carry per-file hashes.
- Retained entries are capped at `SUMMARY_DIFF_MAX_ENTRIES`. The cap matters for the _first_ scan of a package, which has no baseline and therefore reads every file as `added`.
- `summary.diffStats` records the shape of the real diff — per-status counts, `totalCount`, `changedCount`, and `omittedChangedCount` — so a reader can describe the diff without holding it. Rows written before the field have no `diffStats`; `normalizeSummaryDiffStats` reads that as null.
- `summary.diff` stays a `DiffEntry[]`, so every existing reader keeps working against a shorter array rather than needing a new shape.

The **degraded path keeps the full embed.** When there is no `ARTIFACTS` binding the R2 write is skipped, D1 is the only copy, and the [artifact backfill](#backfill) reconstructs a digest-identical `report.json` from that embed — a compacted embed would make those rows permanently un-backfillable.

Artifact-backed rows also stop embedding `summary.findingAnnotations`. Those entries are keyed by `scan_findings.id`, and an artifact-backed scan never writes those rows, so the ids matched nothing; the read path re-derives annotations from `report.json`'s index-based `findingAnnotations`. The degraded path still writes them, because its reader joins on exactly those ids.

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

- **Time-based retention** (the scheduled sweep below) sweeps the per-scan prefix _before_ deleting the row, and skips the row when the sweep fails.

Deletion uses the raw `ARTIFACTS` binding, not the read-gated bucket: `SCAN_ARTIFACT_READS_DISABLED` is a read kill-switch and must not strand objects. The delete prefixes intentionally stop before the `v{N}` segment so a cleanup removes every storage version. Cleanup is fail-soft — a delete error is logged (`scan.artifacts.delete_failed`) but never thrown, so it cannot abort the surrounding D1 teardown; a leaked object is recoverable by re-running the prefix sweep. `deleteScanArtifacts` / `deleteOrganizationArtifacts` return `{ ok, objectsDeleted }` so a caller that must not strand objects can branch on the outcome without the sweep ever throwing. A successful sweep logs `scan.artifacts.deleted` with the object count. Pending/running scans that are discarded before completion (`discardScanAttempt`, `deletePendingScanJob`) carry no artifacts, so they skip R2 cleanup.

## Time-Based Retention

`server/lib/retention.ts` runs on every scheduled tick, after the discovery sweep. Three of its sweeps are unconditional storage hygiene — audit events past `AUDIT_LOG_RETENTION_DAYS` (see [`audit-log.md`](./audit-log.md)), expired Better Auth `session` rows, and expired `verification` tokens. The fourth deletes reviews, so it is **off unless an operator opts in**:

| Setting               | Default         | Meaning                                                                         |
| --------------------- | --------------- | ------------------------------------------------------------------------------- |
| `SCAN_RETENTION_DAYS` | unset (**off**) | Delete scans created more than N days ago. Must be ≥ `SCAN_RETENTION_MIN_DAYS`. |

Unset, unparseable, non-positive, or below the floor all mean "delete nothing" and log `retention.scans.misconfigured`. Scan deletion is irreversible and the review history is what release memory reads, so a mistyped window fails safe instead of emptying the table.

When enabled, each tick deletes at most `SCAN_RETENTION_MAX_PER_TICK` scans (oldest first, via the `scans_created_idx` index); a backlog drains across ticks. Per scan the sweep:

1. Sweeps the per-scan R2 prefix. **If the sweep fails, the D1 row is left in place** (counted as `deferred`) and the next tick retries. Deleting the row first would leave objects that no row points at — the deletion-lifecycle rule above, inverted.
2. Deletes `scan_events`, `scan_findings`, and `scan_files` explicitly and only then the organization-scoped `scans` row, so redacted evidence goes before the metadata describing it rather than relying on cascade ordering.

The sweep **requires the `ARTIFACTS` binding**: without it there is no way to reach a scan's objects, so it logs `retention.scans.skipped` and deletes nothing. Every sweep is bounded (LIMIT + iterate with a per-tick batch cap) and independently wrapped, so one failure neither stops the others nor throws into the scheduled handler.

Deleting a `publish`-decided scan also removes it from release memory: a later release of the same package will find no prior approved scan and score as it did before release memory existed. That is inherent to a retention window, not a regression.

## Rollback

Set `SCAN_ARTIFACT_READS_DISABLED=true` (or `1`) to force scan-detail reads back to D1 while leaving R2 artifacts untouched. Do not delete R2 objects during rollback. This restores D1-backed detail for legacy/degraded rows that still have `scan_files` / `scan_findings` content. It does **not** recover detail for compacted artifact-backed scans (the rows were never written), so disabling reads for those rows shows metadata only — keep R2 reads enabled for them. The safe operational lever for a suspect R2 read remains the per-object digest/size verification, which already fails closed to the metadata view.

## D1 Detail Compaction

New artifact-backed scans are compacted at write time: `persistScan` no longer duplicates `scan_files` / `scan_findings` into D1 once the R2 write is verified (see `server/db/scan-persist.ts`). R2 is therefore the single source of truth for file samples, file metadata, the diff, and deterministic findings on those scans. The degraded path (no `ARTIFACTS` binding) still writes the detail to D1 so a scan that cannot reach R2 stays fully readable. Legacy rows written before this change are unaffected until an explicit one-time D1 cleanup of their now-redundant detail rows — that cleanup is still a separate, deliberate step and must only target rows that already carry verified artifact metadata.
