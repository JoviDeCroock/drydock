-- One-off backfill that strips the two content digests from every persisted
-- `scans.summary_json` diff entry.
--
-- The pipeline stopped writing `previousSha256`/`stagedSha256` into
-- `summary_json.diff` (see `summaryDiffEntries` in server/lib/review/diff.ts):
-- the full-fidelity diff already lives in R2 twice — `diff.json` and the `diff`
-- array inside `report.json`, both digest-verified — and the report export now
-- reads it from there. This rewrites the rows written before that change.
--
-- Idempotent: the WHERE clause only matches artifact-backed rows that still
-- carry a digest, so a rerun is a no-op. Rows with no `$.diff` (failed scans,
-- hand-seeded rows) and legacy rows with no verified R2 copy are never touched.
--
-- ORDER MATTERS: deploy the pipeline + export change first. Once a row is
-- rewritten, its `summary_json.diff` can no longer reproduce the pre-change
-- export bytes on the degraded (artifacts-unreadable) path.
--
-- `json()` re-applies the JSON subtype the aggregate subquery drops, so the
-- rewritten array is stored as JSON rather than as a quoted string. The inner
-- `ORDER BY j.key` pins array order: diff order is meaningful (the file tree
-- renders it) and json_group_array has no inherent ordering guarantee.

UPDATE scans
SET summary_json = json_set(
  summary_json,
  '$.diff',
  json((
    SELECT json_group_array(json(entry))
    FROM (
      SELECT json_remove(j.value, '$.previousSha256', '$.stagedSha256') AS entry
      FROM json_each(scans.summary_json, '$.diff') j
      ORDER BY j.key
    )
  ))
)
WHERE artifact_storage_version = 1
  AND artifact_manifest_key IS NOT NULL
  AND artifact_manifest_digest IS NOT NULL
  AND artifact_manifest_size IS NOT NULL
  AND report_artifact_key IS NOT NULL
  AND report_digest IS NOT NULL
  AND file_samples_artifact_key IS NOT NULL
  AND diff_artifact_key IS NOT NULL
  AND json_type(summary_json, '$.diff') = 'array'
  AND EXISTS (
    SELECT 1
    FROM json_each(scans.summary_json, '$.diff') j2
    WHERE json_extract(j2.value, '$.previousSha256') IS NOT NULL
       OR json_extract(j2.value, '$.stagedSha256') IS NOT NULL
  );
