-- One-off backfill for the denormalized scan list summary columns added by
-- migration 0009_condemned_archangel.sql. Idempotent: rerunning only touches
-- rows still missing values.
--
-- changed_file_count and finding_count are aggregated from scan_files /
-- scan_findings. risk_summary_json is lifted from summary_json.risk, which
-- the scan pipeline has always written for completed scans. Rows whose
-- summary_json has no `risk` key (very old or hand-seeded) keep risk_summary_json
-- NULL; the list route renders them with a null riskSummary until they are
-- backfilled manually.

UPDATE scans
SET
  changed_file_count = COALESCE(
    changed_file_count,
    (
      SELECT COUNT(*)
      FROM scan_files
      WHERE scan_files.scan_id = scans.id
        AND scan_files.status IN ('added', 'removed', 'modified')
    )
  ),
  finding_count = COALESCE(
    finding_count,
    (SELECT COUNT(*) FROM scan_findings WHERE scan_findings.scan_id = scans.id)
  ),
  risk_summary_json = COALESCE(
    risk_summary_json,
    json_extract(summary_json, '$.risk')
  )
WHERE status = 'complete'
  AND (
    changed_file_count IS NULL
    OR finding_count IS NULL
    OR risk_summary_json IS NULL
  );
