# Scan artifact storage

D1 indexes completed scans and R2 stores their redacted derived bodies. **Authority:** internal. **Owner:** `server/lib/scan/artifacts/index.ts`.

## At a glance

| Thing | Owner file | Who may call / trigger | Pinned by (test) |
| --- | --- | --- | --- |
| Verified artifact writes | `server/lib/scan/artifacts/write.ts` | Scan completion pipeline | `test/workers/scan-artifacts-routes.test.ts` |
| Verified detail/file reads | `server/lib/scan/artifacts/read.ts` | Organization-scoped scan readers | `test/workers/scan-artifacts-routes.test.ts` |
| Finding annotations | `server/lib/scan/artifacts/parse.ts` | Verified report parser | `test/scan-artifacts-annotations.test.mjs` |
| Display sample clipping | `server/lib/scan/artifacts/write.ts` | Artifact writer | `test/scan-artifacts-sample.test.mjs` |
| Prefix cleanup | `server/lib/scan/artifacts/delete.ts` | Organization/scan teardown or losing completion attempt | `test/workers/scan-artifact-cleanup.test.ts` |

## Contract

### Provisioning and metadata

| Item | Contract | Owner |
| --- | --- | --- |
| `ARTIFACTS` | Required R2; no D1 body copy or fallback | `server/lib/scan/artifacts/write.ts` |
| Production bucket | Create `staged-publish-review-artifacts` before artifact metadata migrations | `wrangler.jsonc` |
| Test bucket | `staged-publish-review-test-artifacts` | `test/config/wrangler.jsonc` |
| Storage version | `SCAN_ARTIFACT_STORAGE_VERSION` | `server/lib/scan/artifacts/types.ts` |
| Write retries | `SCAN_ARTIFACT_WRITE_ATTEMPTS`; reuse run id | `server/lib/scan/artifacts/types.ts` |
| Display sample cap | `SCAN_FILE_SAMPLE_LIMIT`; never narrows detection/AI input | `server/lib/sample-retention.ts` |
| Read switch | `SCAN_ARTIFACT_READS_DISABLED=true` or `1`; objects untouched | `server/lib/scan/artifacts/read.ts` |
| D1 scan data | Lifecycle, ownership, package/version, decisions, compact summaries, report digest/version | `server/db/scan-persist.ts` |

Artifact columns on `scans` (`server/db/schema.ts`):

```text
artifact_storage_version
artifact_manifest_key
artifact_manifest_digest
artifact_manifest_size
report_artifact_key
file_samples_artifact_key
diff_artifact_key
```

D1 summaries include `risk_summary_json` and the summary-embedded diff. `scan_files` and `scan_findings` do not exist (`drizzle/0028_deep_vindicator.sql`); `persistScan` requires artifact metadata and updates the scan row (`server/db/scan-persist.ts`).

```sh
pnpm exec wrangler r2 bucket create staged-publish-review-artifacts
```

Raw tarballs are not retained by default. See [security boundaries](./security-model.md) and [deployment](./self-hosting.md).

### Object layout

| Key under `orgs/{organizationId}/scans/{scanId}/v1/{runId}/` | Body |
| --- | --- |
| `manifest.json` | Scan/org identity, generation time; object keys, SHA-256 digests, byte sizes, content types and applicable counts |
| `report.json` | Canonical internal report; digest must equal `scans.report_digest` |
| `files.json` | Redacted staged display samples and file metadata |
| `diff.json` | Generated file diff |

| Segment | Contract | Owner |
| --- | --- | --- |
| `{runId}` | UUID minted once per write attempt, reused across its write retries | `server/lib/scan/artifacts/write.ts` |
| Every segment | URL-encoded with `%` replaced by `~` | `server/lib/scan/artifacts/keys.ts` |
| Keys without `{runId}` | Remain readable: reads use persisted keys, never reconstruct them; no storage-version bump is required for the run segment | `server/lib/scan/artifacts/read.ts` |

### Write and read sequence

1. `writeScanArtifactsWithRetry` writes report, files, diff, then manifest; every write is read back and size/SHA-256 verified before D1 persistence (`server/lib/scan/artifacts/write.ts`).
2. `persistScan` conditionally claims the nonterminal organization-owned row and saves artifact references (`server/db/scan-persist.ts`).
3. An explicit `persisted: false` discards only that attempt's in-memory run prefix; an exception from D1 must never trigger this sweep (`server/lib/scan/pipeline-phases.ts`).
4. Full artifact reads verify manifest size/digest, scan/org identity, version and object references; detail reads also bind report digest to D1 (`server/lib/scan/artifacts/read.ts`).
5. Object reads verify size/digest before parsing payload shapes; metadata-only reads verify the report directly against its D1 digest (`server/lib/scan/artifacts/read.ts`).

| Method | Path | Auth/role | Response |
| --- | --- | --- | --- |
| GET | `/api/v1/scans/:id` | Session, active org member | Metadata, findings, events, file metadata; no bodies |
| GET | `/api/v1/scans/:id/file?path=package.json` | Session, active org member | Selected redacted body from R2 |
| GET | `/api/v1/scans/:id/report.json` | Session, validated org membership | Completed-scan export |
| DELETE | `/api/v1/scans/:id` | Session, active org member | Delete owned failed row, cascade events, audit, sweep R2 |

`server/routes/scans/lifecycle.ts` owns detail/file/delete; `server/routes/scans/sharing.ts` owns export.

| Findings / export | Contract |
| --- | --- |
| Detail findings | Rule rows then completed AI rows; order matches `findingAnnotations` |
| Source tags | `source: "rule"` / `source: "ai"` in `server/lib/scan/artifacts/parse.ts` |
| Counts and risk | Both sources count in `finding_count` and risk summary |
| AI authority | Advisory; never alters rule findings (`server/lib/scan/pipeline-phases.ts`) |
| Export findings | Deterministic-only `findings[]`; every entry retains `ruleId`/`ruleVersion` |
| AI export | Separate `aiReview` block, never double-listed |
| Filename | Path-safe `drydock-{package-name}-{version}.json`; fallback uses scan id |

`REPORT_EXPORT_SCHEMA` in `server/lib/scan/report-export.ts` names the canonical export projection; it is not the internal R2 report bytes. The same owner defines export findings and filenames. Dashboard download links pass validated `organizationId` because native downloads cannot send `x-organization-id` (`server/routes/scans/sharing.ts`).

### Deletion lifecycle

| Trigger | Prefix / action | Owner |
| --- | --- | --- |
| `deleteOrganization` | After D1 teardown, sweep `orgs/{organizationId}/` | `server/db/organizations.ts` |
| `deleteUserAccount` | Better Auth `beforeDelete` deletes owned personal/sole-owned organizations through `deleteOrganization` | `server/db/organizations.ts` |
| `discardGateScans` | Sweep discarded scan prefixes, including partially completed packages | `server/db/scan-jobs.ts` |
| Failed-scan deletion | Sweep `orgs/{organizationId}/scans/{scanId}/` | `server/routes/scans/lifecycle.ts` |
| `discardScanArtifactRun` | Sweep only `orgs/{organizationId}/scans/{scanId}/v{N}/{runId}/`; no D1 deletion | `server/lib/scan/artifacts/delete.ts` |
| `discardScanAttempt`, `deletePendingScanJob` | No R2 cleanup: discarded pending/running jobs have no completed artifacts | `server/db/scan-jobs.ts` |
| Time-based retention | No scheduled TTL sweep or orphan reaper | `server/lib/scan/artifacts/delete.ts` |

## Invariants

1. R2 is the only completed-body store; missing `ARTIFACTS` throws (`server/lib/scan/artifacts/write.ts`).
2. Each attempt's object set is unaddressable by another attempt: duplicate at-least-once queue deliveries cannot overwrite committed bytes (`server/lib/scan/artifacts/keys.ts`).
3. Producers create fresh scan ids; sequential retries skip terminal rows through `claimScanForRun` (`server/lib/scan/job.ts`).
4. The discard prefix must come from the writer's in-memory result; deriving it from a persisted key could delete a live run-id-less set (`server/lib/scan/artifacts/delete.ts`).
5. Cleanup uses raw `ARTIFACTS`, so the read kill-switch cannot strand objects (`server/routes/scans/lifecycle.ts`, `server/lib/scan/artifacts/delete.ts`).
6. Scan/org sweep prefixes stop before `v{N}` to remove every storage version and run (`server/lib/scan/artifacts/keys.ts`).
7. Reads fail closed to metadata-only and never serve unverified bytes (`server/lib/scan/artifacts/read.ts`).
8. Release memory treats an unreadable prior report as no profile, never an empty profile that could produce `diverged` (`server/db/release-memory.ts`).

## Failure modes

| Condition | Cause | Outcome | Fix |
| --- | --- | --- | --- |
| Completion fails | Missing `ARTIFACTS` | `scan.artifacts.binding_missing`; throws | Provision bucket |
| Write/readback failure | Transient R2 error | `scan.artifacts.write_failed`; same-run retry | Restore R2 access |
| Write retry exhaustion | Persistent R2 error | Fail-soft run sweep; throws for queue retry | Inspect final attempt |
| D1 exception/crash | Commit unknown | Up to four orphan objects; never sweep from catch | Correlate written/completion/discard logs |
| Lost claim | Other winner/deleted row | Warn `scan.artifacts.run_discarded` before run sweep | No discard retry needed |
| Invalid prefix | Outside scan prefix | `scan.artifacts.run_discard_rejected`; no deletion | Use in-memory writer prefix |
| Artifact read fails | Missing, corrupt, invalid or unavailable bytes | `scan.artifacts.fallback_read`; metadata-only view | Restore verified objects/access |
| Read switch/unbacked scan | R2 unavailable/metadata absent | Metadata-only view; no D1 body recovery | Clear switch after bucket is trusted |
| Cleanup fails | R2 delete error | `scan.artifacts.delete_failed`; never throws | Repeat prefix sweep |

Metadata-only requests still render the D1 row, risk summary and summary diff, without samples/findings. Successful nonempty sweeps log `scan.artifacts.deleted` with object count (`scope: "run"` for run deletion).

Orphans are bounded by queue retry budget `MAX_SCAN_JOB_ATTEMPTS` in `server/lib/scan/job.ts`, with up to four objects per attempt. There is no reaper; scan/org deletion reclaims all run prefixes. Find suspected orphans by a `scan.artifacts.written` run id without completion or matching `scan.artifacts.run_discarded`.

## Change checklist

- If artifact shapes/keys change → update writer, parsers and version handling; run `pnpm exec vitest run --project workers test/workers/scan-artifacts-routes.test.ts test/workers/scan-artifact-cleanup.test.ts`.
- If read fallback changes → check private detail, public shared exports and release memory; run the relevant tests in [release safety](./release-safety.md).
- If deletion changes → preserve raw-bucket cleanup and all-version prefixes; test organization/account/gate/failed-scan teardown.
- If export changes → update `REPORT_EXPORT_SCHEMA` and [public reports](./public-reports.md); preserve deterministic-only exported findings.
- If containing a suspect bucket → set `SCAN_ARTIFACT_READS_DISABLED=true` or `1`; expect metadata-only scans, not restored bodies; leave deletion enabled.

## Why

Concurrent manifests contain wall-clock generation times, so shared keys could replace a winner's verified bytes with a loser's bytes and invalidate public attestations. Disjoint run prefixes prevent that overwrite. A crash can leak a small artifact set; preserving potentially committed evidence takes priority over speculative cleanup.
