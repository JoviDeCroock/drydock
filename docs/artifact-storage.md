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
orgs/{organizationId}/scans/{scanId}/v1/{runId}/manifest.json
orgs/{organizationId}/scans/{scanId}/v1/{runId}/report.json
orgs/{organizationId}/scans/{scanId}/v1/{runId}/files.json
orgs/{organizationId}/scans/{scanId}/v1/{runId}/diff.json
```

`{runId}` is a UUID minted once per write attempt (reused across that attempt's retries). Path segments are URL-encoded with `%` replaced by `~` so object keys stay path-safe.

Objects written before run ids existed have no `{runId}` segment and stay readable: the read path resolves keys from the `scans` columns above rather than recomputing them, so the key shape is not part of any read-time contract and adding the segment needed no storage-version bump.

The manifest records each object key, SHA-256 digest, byte size, content type, and count where applicable. `report.json` is the canonical report JSON whose digest must equal `scans.report_digest`; it includes redacted dependency evidence but never dependency file bodies. `files.json` stores redacted staged file samples plus file metadata. `diff.json` stores the generated file diff.

User-initiated report downloads serve the same canonical `report.json` bytes with a package-scoped filename: `drydock-{package-name}-{version}.json`. The export's `findings[]` stays deterministic-only (every entry keeps its `ruleId`/`ruleVersion`); structured dependency coordinates remain on dependency findings, and validated dependency evidence is exported as `dependencies.evidence`. The advisory AI review, when one exists, is carried separately in the export's `aiReview` block, so AI findings are never double-listed. Package names are normalized to a path-safe filename segment for the `Content-Disposition` header. Dashboard download links include the active organization as a validated query parameter because native browser downloads cannot attach the dashboard's `x-organization-id` fetch header.

## Concurrent Completion Attempts

A duplicate queue delivery can run a second completion attempt for the same scan. No application path produces one: every producer mints a fresh scan id and its own row, and `message.retry()` is called after the handler returns, so a retry is sequential and `claimScanForRun` skips it once the row is terminal. The trigger is Cloudflare Queues' at-least-once delivery — the same message delivered again while the first invocation is still alive. That is rare, but when it fires the corruption is certain rather than probabilistic: `manifest.generatedAt` is wall-clock, so two attempts never write identical manifest bytes.

Each attempt writes its artifact set _before_ `persistScan` decides which one owns the D1 row, so the invariant that keeps this safe is structural: **an attempt's object set is unaddressable by any other attempt.** The `{runId}` segment is what provides it.

Without it, both attempts wrote the same four keys. A loser whose R2 write landed after the winner's D1 batch committed left the row pointing at digests that no longer matched the stored bytes, and the detail read then failed closed to metadata-only — permanently, since nothing rewrites the objects. For a scan shared through a public report token that is worse than an empty page: `loadSharedScanDetail` attests over exactly those serialized bytes, so the same token would start serving different bytes under a different attested subject digest.

An attempt that loses the claim (`persisted: false`) sweeps its own prefix and logs `scan.artifacts.run_discarded`. The sweep runs only on an explicit `persisted === false`, never from a `catch`: if `persistScan` throws, the D1 batch may or may not have committed, and deleting the run could destroy the winner's objects.

One orphan class is accepted, and it is a deliberate trade rather than an oversight. An attempt that writes R2 and then fails or crashes before `persistScan` returns — a retryable D1 error, an isolate eviction, a queue timeout — leaks up to four objects, where the shared-key layout would have let the next attempt overwrite them. That is the cost of the guarantee above: a set that a later attempt can overwrite is a set that a _stale_ attempt can overwrite. Leaked objects are bounded by the queue retry budget (up to `MAX_SCAN_JOB_ATTEMPTS` sets per scan), are a few KB each, and are reclaimed by the scan/org prefix sweeps on deletion. There is no reaper; adding one would cost more than the leak. To find an orphan, correlate the logs — it is a `scan.artifacts.written` `runId` for a scan with neither a completion nor a matching `scan.artifacts.run_discarded`.

## Write And Read Flow

Completed scans write `report.json`, `files.json`, `diff.json`, and `manifest.json` to R2 before `persistScan` writes the D1 row. Each object is read back and verified against its expected size and SHA-256 digest before D1 metadata is saved. Transient write or verification failures are retried under the same run id — a retry replaces its own partial objects instead of orphaning them. An exhausted writer logs `scan.artifacts.write_failed`, fail-soft sweeps that run prefix, and throws so the scan can retry; the sweep is safe because D1 persistence has not started and nothing can reference that run. A missing `ARTIFACTS` binding logs `scan.artifacts.binding_missing` and throws for the same reason: there is no second place to put the body.

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
- **Lost completion claim** (`discardScanArtifactRun`) — the one trigger with no D1 deletion behind it — deletes the single run prefix `orgs/{organizationId}/scans/{scanId}/v{N}/{runId}/` an attempt wrote before it discovered another attempt owned the row. It logs `scan.artifacts.run_discarded` at `warn` _before_ deleting, so the discard is on record even if the sweep fails, and the sweep itself emits `scan.artifacts.deleted` with `scope: "run"`. The prefix must come from the writer's in-memory result: reconstructing one by stripping a filename off a persisted key would, for a pre-run-id key, strip to the scan's whole `v{N}/` directory and delete a live artifact set. A prefix that does not sit under the scan's own prefix is rejected with `scan.artifacts.run_discard_rejected` and nothing is deleted.

Deletion uses the raw `ARTIFACTS` binding, not the read-gated bucket: `SCAN_ARTIFACT_READS_DISABLED` is a read kill-switch and must not strand objects. The org and scan delete prefixes intentionally stop before the `v{N}` segment, so a cleanup removes every storage version — and, for the same reason, every run prefix under it. Cleanup is fail-soft — a delete error is logged (`scan.artifacts.delete_failed`) but never thrown, so it cannot abort the surrounding D1 teardown; a leaked object is recoverable by re-running the prefix sweep. A successful sweep logs `scan.artifacts.deleted` with the object count. Pending/running scans that are discarded before completion (`discardScanAttempt`, `deletePendingScanJob`) carry no artifacts, so they skip R2 cleanup.

Time-based retention (a TTL sweep that deletes old scans on a schedule) is not yet implemented and is tracked separately.

## Rollback

`SCAN_ARTIFACT_READS_DISABLED=true` (or `1`) stops scan-detail reads from touching R2 while leaving the objects untouched. There is no D1 copy to fall back to, so every completed scan then renders as metadata only — no file samples, no findings. Treat it as a containment switch for a suspect bucket, not a rollback. The routine lever for a suspect object is the per-object digest/size verification, which already fails closed to the same metadata view.

## D1 Detail Removal

`scan_files` and `scan_findings` are gone (migration `0028_deep_vindicator.sql`). They were last written on the degraded path — a Worker with no `ARTIFACTS` binding — which is now a hard error instead. `persistScan` therefore writes exactly one row per scan and takes its `artifacts` metadata as a required input.

Legacy scans written before artifact storage had their bodies in those tables; they were migrated with the (now removed) artifact backfill before the drop. A pre-artifact scan that was never backfilled keeps its metadata row and renders as metadata only.
