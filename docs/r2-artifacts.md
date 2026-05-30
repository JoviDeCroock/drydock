# R2 Scan Artifacts

This note records how scan report artifacts move from D1 to R2. It covers the
object key format, the bundle schema, digest verification, the dual-write /
shadow-read / backfill phases, the rollback path, and bucket provisioning.

Source: `server/lib/scan-artifacts.ts` (storage primitives, no D1 imports),
`server/lib/canonical-json.ts` (`stableJson` + `sha256Hex`),
`server/lib/scan-pipeline.ts` (dual-write), `server/db/index.ts`
(`markScanArtifactBacked`, `listScanArtifactBackfillCandidates`, shadow-read in
`getScan`), and `server/lib/artifact-backfill.ts` (sweep).

## Why

D1 stays the authoritative metadata and index store, but the heavy derived
evidence — the canonical report JSON, the redacted summary/diff snapshot, and the
redacted changed-file text samples — grows with package size and is awkward to
keep in row storage. That payload moves into a single digest-verified R2 object
per scan. D1 keeps a small reference (key, digest, size, storage version) so
retention, rollback, and integrity checks stay simple.

This is the first rollout from drydock issue #99. **D1 compaction is deliberately
deferred**: no existing scan data is deleted here. Old rows keep their
`text_sample` columns; the R2 bundle shadows them. Compaction is a separate
explicit step after a backfill + shadow-read soak.

## Object key format

```
reports/{organizationId}/{scanId}/v{storageVersion}.json
```

`SCAN_ARTIFACT_STORAGE_VERSION` is currently `1`. Keying by storage version lets a
future schema bump write `v2.json` alongside `v1.json` without a destructive
rewrite, and keeps retention/rollback per-version. One object per scan; we do not
write per-artifact objects.

## Bundle schema

A bundle (`ScanArtifactBundle`) is JSON with:

- `storageVersion` — matches the key suffix.
- `scanId`, `organizationId` — also mirrored into the object's `customMetadata`.
- `origin` — `"pipeline"` (written live by a completed scan) or `"backfill"`
  (written by the catch-up sweep for scans that predate R2).
- `report` — `{ version, digest, payload }`.
  - For `pipeline` bundles `payload` is the canonical report object and its
    `sha256Hex(stableJson(payload))` must equal `report.digest` (which equals
    `scans.report_digest`). This is re-verified on write.
  - For `backfill` bundles `payload` is `null`: the original canonical report
    predates R2 and cannot be rebuilt from D1, so the bundle is verified by its
    byte digest only.
- `summary` — snapshot of `scans.summary_json` (diff, packageJsonDiff, risk,
  baseline, safety).
- `fileSamples` — array of `{ path, textSample }`, only for files that carry a
  non-empty redacted text sample. Files without a sample are fully
  reconstructable from their D1 metadata row and are skipped.

`fileSamples` carries only redacted derived evidence. Raw tarballs and
unredacted file contents are never stored, consistent with the security model.

## Digest verification

Two independent digests guard the data:

1. **Byte digest** — `sha256Hex(JSON.stringify(bundle))`, persisted as
   `scans.artifact_digest`. On write, the object is immediately re-read and its
   recomputed digest must match before the row is marked artifact-backed. On
   read, when `artifact_digest` is present, a mismatch rejects the read.
2. **Report digest** — for `pipeline` bundles only,
   `sha256Hex(stableJson(report.payload))` is re-derived on write and must equal
   `report.digest` / `scans.report_digest`. This proves the canonical report
   bytes in R2 match the digest D1 already committed.

`stableJson` sorts object keys and drops `undefined` so the same logical value
always hashes identically regardless of property order. It is shared by the scan
pipeline and the artifact store to avoid digest drift.

Verification failures raise `ScanArtifactError` with one of:
`artifact_readback_missing`, `artifact_digest_mismatch`, `report_digest_mismatch`,
`artifact_malformed`.

## Phases

### Dual-write (live scans)

After a scan is persisted, `writeScanArtifactForCompletedScan` builds a
`pipeline` bundle, writes + verifies it, and calls `markScanArtifactBacked` to
set the four `artifact_*` columns. It is **best effort**: if `ARTIFACTS` is
unbound or any write/verification step fails, the error is logged
(`scan.artifact.write_failed`) and swallowed. D1 already holds the authoritative
copy, so the scan simply stays D1-only and shadow-read falls back automatically.
Success logs `scan.artifact.written`.

### Shadow-read

`getScan` accepts `{ artifacts?: R2Bucket }`. When a scan is artifact-backed and
the binding is present, `hydrateScanFileSamples` reads and verifies the bundle
and overrides each file's `textSample` from it. On a missing object, digest
mismatch, or any read error it logs `scan.artifact.read_fallback` and returns the
D1 file rows unchanged. Routes pass `c.env.ARTIFACTS` into `getScan`,
`recordScanDecision`, and the compare-context read.

Only `textSample` is hydrated from R2 in this rollout. `summary_json.diff` stays
authoritative in D1 until compaction, so finding-annotation logic is unchanged.

### Backfill

`runArtifactBackfillSweep` (in the Worker `scheduled` handler, after the
staged-publish discovery cron) writes one batch of old completed scans that have
no `artifact_storage_version` yet, oldest first. Candidates must have
`completed_at` at least one hour in the past so the catch-up sweep does not race
the live pipeline's same-key dual-write for a freshly completed scan. It is
**gated behind
`ARTIFACT_BACKFILL`** and off by default. Backfill is naturally idempotent: a
successful write sets `artifact_storage_version`, removing the scan from the next
sweep's candidate set, so repeated runs converge without double-writing. The
sweep logs `scan.artifact.backfill_failed` per failure and a
`scan.artifact.backfill_sweep` summary, and a top-level failure is caught so it
never breaks the discovery cron.

`listScanArtifactBackfillCandidates` selects `status = "complete"` scans where
`artifact_storage_version IS NULL`, `organization_id IS NOT NULL`, and
`completed_at` is older than the one-hour cutoff. The
`scans_artifact_backfill_idx` index (`status, artifact_storage_version,
created_at`) backs the candidate query.

## Rollback

Reads flip back to D1 without touching R2:

- **Unbind `ARTIFACTS`** (or remove the env passing): `getScan` stops shadow-
  reading and serves D1 rows; dual-write becomes a no-op; the backfill sweep
  returns early.
- **Set `ARTIFACT_BACKFILL` off** (its default): the sweep stops enrolling new
  scans while leaving everything already written intact.

Because no D1 data is deleted in this rollout, both toggles are safe and
non-destructive. R2 objects can be left in place or cleaned up separately.

## Bucket provisioning

`wrangler.jsonc` binds `ARTIFACTS` to `staged-publish-review-artifacts`;
`wrangler.test.jsonc` binds it to `staged-publish-review-artifacts-test` (miniflare
simulates it locally). The binding is optional in `server/env.d.ts` so dev, tests,
and the worker degrade gracefully to D1-only when it is absent.

Create the production bucket before enabling reads:

```
npx wrangler r2 bucket create staged-publish-review-artifacts
```

Roll out in order: deploy with dual-write (binding present), let new scans
populate R2 and confirm `scan.artifact.written` events, then enable
`ARTIFACT_BACKFILL` to drain old scans, watch `scan.artifact.backfill_sweep`
converge to zero work and `scan.artifact.read_fallback` stay quiet, and only then
plan D1 compaction as a separate change.
