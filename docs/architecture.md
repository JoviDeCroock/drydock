# Architecture

Staged Publish Review is a Cloudflare-first SaaS for reviewing npm staged publishes before human approval. The product is intentionally centered on one question: **what changed in this staged publish, and should a maintainer pause before approving it?**

## Runtime components

```text
Browser UI
  │ same-origin fetch
  ▼
Hono Worker
  ├─ Better Auth session guard
  ├─ organization ownership checks
  ├─ D1 persistence
  ├─ Dynamic Worker loader
  └─ NpmStageGateway outbound gateway
        │ attaches org npm auth only for allowed npm endpoints
        ▼
      npm registry

Dynamic Worker sandbox
  ├─ receives no npm token
  ├─ fetches only through NpmStageGateway
  ├─ gunzips/parses tarball
  └─ returns bounded file metadata + text samples
```

Scan orchestration lives in `server/lib/scan-pipeline.ts` and is shared by both entrypoints. The product path is the queued/background lifecycle: `POST /api/v1/scans` creates a scan, a Queue consumer or local `waitUntil()` job runs the pipeline, and the UI reads status/report data from `GET /api/v1/scans/:id`. `POST /api/v1/scan` remains only as a synchronous compatibility shim during the migration.

The pipeline is **ecosystem-agnostic**: it accepts a `PackageAdapter` (`server/lib/adapters/types.ts`) and delegates everything npm-specific — input parsing, artifact acquisition, baseline selection, deterministic findings, package projection, staged-details summarization — to it. The only adapter today is `npmAdapter` (`server/lib/adapters/npm/`); future adapters slot in by implementing the same interface.

Baseline selection should be tag-aware rather than simply highest-semver. See [`diff-baseline.md`](./diff-baseline.md) for the staged metadata constraints and the recommended default comparison strategy.

## Trust boundaries

### Browser/UI

The UI is not trusted for authorization decisions. It sends authenticated requests and renders escaped text previews. It must never render package-provided HTML, scripts, images, SVG, or other active content from a scanned package.

### Parent Worker

The parent Worker is the trusted control plane. Route handlers should stay thin; scan behavior belongs in `server/lib/scan-pipeline.ts` so HTTP and Queue entrypoints share one implementation. The parent Worker:

- authenticates users with Better Auth;
- resolves the current organization;
- loads organization-scoped npm credentials;
- creates and updates scan records;
- invokes the Dynamic Worker sandbox;
- computes deterministic findings and risk;
- persists redacted report data and audit events.

### Dynamic Worker sandbox

The Dynamic Worker handles untrusted package bytes. It:

- receives only scan options and registry URLs;
- never receives npm credentials;
- cannot directly reach the Internet except through `globalOutbound`;
- parses archive bytes into bounded file summaries;
- returns metadata and text samples, not executable behavior.

The sandbox must stay small and boring. Do not add package execution, dependency installation, build steps, import resolution, or rendering.

The dynamic Worker's archive parser is defined in `server/lib/tar-parser.js` and concatenated into the sandbox module by `server/lib/sandbox.ts` via `Function.prototype.toString()`. It covers gzipped tar archives for npm/sdist flows and ZIP archives for PyPI wheels. This keeps the parser code path the one exercised by the unit tests in `test/tar-parser.test.mjs` and `test/zip-parser.test.mjs` instead of sibling string copies that could drift.

`readTar` returns `{ files, suspicious }`. The `suspicious` list carries `tar.suspicious-entry` evidence for non-regular entries (symlinks, hardlinks, devices, FIFOs, reserved typeflags; explicit directories are recorded as informational provenance), duplicate normalized paths (parsed with last-write-wins semantics so deterministic checks inspect the bytes consumers are likely to receive), and paths containing zero-width or visually-confusable characters (e.g., a U+200B between `binding` and `.gyp` that could bypass `isRootGypPath` while npm's own extract canonicalizes it on the consumer side). Confusable paths are still reported when canonicalization turns them into unsafe traversal paths. Local PAX path overrides are applied to the next entry, while global PAX path metadata is ignored so scanner paths match tar extraction. `isRootGypPath` and `canonicalizePath` strip those characters and fold confusable separators (U+2044, U+2215, U+FF0F) and dots (U+FF0E, U+2024) to their ASCII forms before matching, so the implicit `node-gyp rebuild` rule cannot be dodged with confusables. Ordinary Unicode composition, such as decomposed accents in legitimate filenames, is left intact and is not treated as confusable evidence. Suspicious entries are capped at the same bound as regular files plus one omission marker, so a crafted archive cannot fan out into unbounded persisted findings. Suspicious entries surface as deterministic findings via `tarSuspiciousEntryFindings` in the npm adapter.

### NpmStageGateway

`NpmStageGateway` is the only component allowed to attach npm authorization on outbound requests made by the dynamic sandbox. It follows Cloudflare's [outbound Worker pattern for sandbox auth](https://blog.cloudflare.com/sandbox-auth/): the sandbox makes a normal fetch, while a trusted WorkerEntrypoint receives props from the parent Worker and conditionally injects credentials without exposing them to the sandbox.

It should:

- accept an organization-scoped credential context from the parent Worker;
- attach auth only to allowed npm registry endpoints;
- never forward auth to arbitrary origins;
- record token-use audit events at the parent layer;
- keep the sandbox ignorant of credentials.

Current code supports encrypted per-organization npm connections only. Scans require the current organization to connect its own credential before any npm staged-package fetch occurs.

### NpmAdapterBroker

`NpmAdapterBroker` (`server/lib/adapters/npm/broker.ts`) keeps scan-pipeline npm credential use out of the generic orchestrator. It extends the same-script `WorkerEntrypoint` pattern: callers obtain a stub via `ctx.exports.NpmAdapterBroker({ props: { organizationId } })` and invoke RPC methods (`fetchPackageMetadata`, `fetchStagedDetails`, `downloadStaged`, `downloadPublished`). Inside each method the broker resolves the connection from D1, confirms it is still validated, decrypts the token, performs the call, and returns the result. The plaintext token does not cross the broker's method boundary into `scan-pipeline.ts`.

The scan pipeline and `scan-job.ts` receive a connection _reference_ — `{ organizationId }` — never the secret. The orchestrator stays credential-blind, so future additions to the pipeline cannot accidentally read, log, or forward the token. The broker uses `NpmStageGateway` internally when running a sandboxed tarball download; the Dynamic Worker that initially downloads, gunzips, and unpacks untrusted tarball bytes receives only scan options and registry URLs, never the npm token itself.

Sandbox download failures raised inside the broker are rethrown as RPC-safe `SandboxError` standard errors with the JSON detail in `message`, because Workers RPC preserves standard error names/messages but drops custom own properties such as `detail`. Callers must use `sandboxErrorDetail()` instead of reading `err.detail` directly.

Credential resolution failures from the broker are terminal scan errors. Only registry metadata fetch failures after a valid credential has been resolved may degrade to a no-baseline scan.

For tests and non-Workers contexts, `createNpmBroker` falls back to a `LocalNpmBroker` that performs the same credential resolution against the host-supplied `db`. This keeps the broker contract identical between production and unit tests.

## Scan pipeline

Current high-level flow:

1. User submits a `stageId`.
2. API validates input and resolves the authenticated user's active organization via `requireActiveOrganization`.
3. `scan-job.ts` looks up the organization's `npm_connections` row, confirms its `validationStatus === "valid"`, and hands a connection reference (`{ organizationId }`) plus the `npmAdapter` to `runScanPipeline`. The plaintext token stays in D1 until the broker needs it.
4. The pipeline asks the adapter for a broker via `adapter.createBroker(ctx, ref)`. The broker is the only code path that decrypts the npm token.
5. `adapter.acquireStaged` calls `broker.downloadStaged` (which loads the staged tarball in a Dynamic Worker) and `broker.fetchStagedDetails` (which fetches `GET /-/stage/{stageId}` from the trusted parent for dist-tag, shasum, and mismatch checks) in parallel.
6. `NpmStageGateway` attaches npm auth only for allowed sandbox npm registry endpoints; the broker passes the token to the gateway via props on instantiation.
7. The sandbox extracts bounded file records and tarball-derived package metadata. The package metadata models npm manifest normalization that is inferable from tarball contents, including npm's implicit `scripts.install = "node-gyp rebuild"` when a root `*.gyp` file exists and no `install`/`preinstall` script or `gypfile=false` is declared.
8. `adapter.acquireBaseline` resolves the comparison baseline via `broker.fetchPackageMetadata`, picks a tag-aware previous version, and downloads its tarball through `broker.downloadPublished` when available.
9. The pipeline computes:
   - package file diff;
   - package.json (manifest) diff;
   - adapter findings via `adapter.runFindings` — for npm: deterministic findings, package.json diff findings, and staged-metadata-mismatch findings;
   - release/context annotations for the deterministic findings, using package-to-package diff status and changed-line checks where text samples are available;
   - a risk breakdown where `releaseRisk` is the primary saved scan risk, while `artifactRisk` and `contextRisk` keep full-artifact safety context visible;
   - redacted package/file records.
10. The pipeline persists the scan, records audit events, and returns/report renders the result. (AI review is gated by the Cloudflare Flagship `ai-review` flag — see "Workers AI" below.)

Current async-capable flow:

1. `POST /api/v1/scans` creates a `pending` scan and returns the scan ID.
2. If `SCAN_QUEUE` is bound, the parent Worker sends a token-free scan job message to Cloudflare Queues; otherwise local/dev falls back to `executionCtx.waitUntil()`.
3. Queue/background execution marks the scan `running`, resolves the organization's encrypted npm connection, and executes the scan pipeline.
4. Pipeline stores derived/redacted report data and marks the scan `complete`.
5. Terminal failures are persisted as `failed` with structured `error_json`; transient npm/sandbox failures are retried before they are marked failed.
6. Exhausted retryable Queue jobs are sent to the configured dead-letter queue for operator review.
7. UI polls `GET /api/v1/scans/:id` until terminal state.

`POST /api/v1/scan` remains a synchronous compatibility route while the product moves to the persisted report surface.

## Scheduled auto-discovery

A `*/15 * * * *` cron trigger runs `runStagedPublishesDiscoveryCron` in `server/index.ts`. The handler sweeps every npm connection whose `validation_status` is either `valid` or `unvalidated`, attempting to validate any `unvalidated` token against the npm registry before using it (and persisting the resulting `valid`/`invalid` status). Tokens with `validation_status = "invalid"` are skipped without contacting the registry, so a known-bad token never adds noise or burn rate against npm. Discovery itself is shared with the manual `POST /api/v1/staged-publishes/scan` route through `server/lib/staged-publishes-discovery.ts`; it paginates staged-list results, deduplicates stage IDs across pages, and removes a just-created pending scan if Queue dispatch fails so the next sweep can retry discovery cleanly.

Scans created by the cron are marked `scans.source = "auto_discovery"` (manual scans default to `"manual"`). The actor is the npm connection creator when present, otherwise the organization owner. When `executeScanJob` finishes — successfully or as a terminal failure — and the queue message carries `source: "auto_discovery"`, the worker sends an email notification through the `SEND_EMAIL` binding (`server/lib/email.ts` + `server/lib/notify.ts`) to that Better Auth user's email, linking to `/dashboard/scans/:id`. Email authentication for `resynapse.dev` (SPF/DKIM/DMARC) is configured at the Cloudflare account level; the worker only needs the `send_email` binding plus `EMAIL_FROM_ADDRESS` / `EMAIL_FROM_NAME` vars.

Discovery dedupes stage IDs against both the current org's scans and any completed scan in another organization, so a stage that has already been successfully scanned elsewhere never triggers another npm fetch. When an auto-discovered scan terminally fails with `staged_tarball_unavailable` (npm returned 401/403/404 to this org's token), the worker deletes the scan row via `discardScanAttempt`, records a `scan.skipped` audit event, and suppresses the failure email — the package likely belongs to a different organization and shouldn't show up as a failure in this one's dashboard.

## Data stores

### D1

D1 stores canonical application state:

- Better Auth users/sessions/accounts;
- organizations and organization members;
- scan rows, lifecycle status, timestamps, structured errors, and report digest metadata;
- scan file manifests;
- findings;
- audit events;
- npm connection metadata;
- rate-limit buckets;
- future report signature metadata.

D1 should not become a raw artifact store.

### R2

R2 is the target store for durable derived artifacts:

- canonical report JSON;
- redacted package manifests;
- changed-file safe text samples;
- generated diff JSON;
- future signed-report payloads.

Raw tarballs should not be retained by default in SaaS. If needed later, make raw retention an explicit organization setting with a short TTL, access logging, and clear warnings.

### Workers AI (disabled)

Workers AI review is currently **disabled in the scan pipeline**. The reviewer module — `server/lib/ai-review.ts`, its single-model policy (`AI_MODEL` = `@cf/moonshotai/kimi-k2.5`), the prompt-injection-resistant system prompt, the AI SDK evidence-tool loop, and the test suite (skipped) — is kept on disk so it can be re-introduced behind a paid tier without re-engineering the contract.

Scans persist `scan.aiJson = null` while AI review is disabled, and the UI omits the reviewer-notes section entirely. Risk is computed exclusively from deterministic findings.

All `AiReview` consumers must route the persisted record through `displayedAiResult()` (`server/lib/ai-review-types.ts`). The fallback shape used when the assistant did not complete carries `risk: "low"` and `releaseAssessment: "not_assessed"` — reading those fields raw would silently surface "we couldn't review this" as "low risk / nothing unusual." The helper narrows to a `{ kind: "complete" }` discriminated union or a `{ kind: "unavailable" }` view that intentionally omits `risk` and `releaseAssessment`, so neither the UI nor the risk computation can accidentally read fallback values as evidence.

When AI review returns it will continue to:

- start from deterministic findings, package.json/package.json diff, and changed-file metadata rather than a bulk dump of every changed file;
- request targeted redacted evidence through app-owned AI SDK tools — a batched `read` tool that auto-returns a text diff for changed files (and the staged sample otherwise), a batched literal `search_files`, and a `list_files` filter — including unchanged files that a changed `package.json` now exposes as lifecycle-script targets or entrypoints;
- receive release-delta deterministic findings as authoritative evidence;
- treat every package-derived string as hostile evidence, not instructions;
- be limited by controller-enforced step count, per-tool character caps, and total evidence budget;
- suffix Workers AI cache affinity with the scan ID so prompt/cache reuse is scan-scoped;
- explicitly check npm supply-chain hazards such as lifecycle scripts, added dependencies whose own postinstall/install hooks are not visible in the staged tarball, entrypoint changes, credential access, network/process execution, obfuscation, and native artifacts;
- submit schema-constrained JSON through the `submit_review` tool;
- raise risk or add context only when the returned review is complete, schema-valid, and includes findings or an explicit manual-review flag;
- be unable to approve a release or downgrade deterministic findings.

## Organization model

The product target is SaaS with organization-scoped resources.

Every user gets a deterministic "Personal" organization on first signup (id derived from `personalOrganizationId(userId)`). Users can additionally create and switch between any number of organizations they own.

Active-organization selection is **client-owned and per-device**: the browser stores the chosen org id in `localStorage` and sends it as the `x-organization-id` header on every API request. The server resolver `requireActiveOrganization(c, db)` in `server/lib/active-organization.ts` reads that header, verifies the caller is a member via `organization_members`, and falls back to the personal org when the header is absent or points at an org the caller does not belong to. There is no server-side "active org" column — switching devices means each device tracks its own active org, which matches how maintainers tend to use separate machines for separate clients.

Organization-owned resources scope by the active org:

- scans;
- audit events;
- npm connections (one per organization — `UNIQUE(organization_id)` on `npm_connections`);
- future report signatures;
- future artifact retention settings.

Invitations, team membership, RBAC, deletion, audit-log UI, billing, and quotas are deferred (see Phase 12 in `docs/production-roadmap.md`). Until they ship, every member of an organization is effectively an owner, and route guards must continue to verify membership through `organization_members` rather than trusting client-supplied org ids.

## npm connection model

Production SaaS uses per-organization npm credentials instead of a global Worker secret.

Implemented `npm_connections` responsibilities:

- store encrypted npm token material;
- store token label/fingerprint/last4, not plaintext display;
- track registry URL;
- track validation status/capabilities;
- track creator and timestamps;
- support rotation/removal;
- emit audit events for add, validate, use, and delete.

Credential validation is empirical where possible: it checks registry auth through `/-/whoami`, staged list access through `GET /-/stage?perPage=1`, and when the user supplies a real stage ID it checks staged view plus ranged staged-tarball access without retaining the tarball. Before launch, confirm the least-privilege token shape with real npm tokens. Do not rely solely on broad token labels.

## Report model and future signing

Reports should become canonical data objects even before public signing launches.

Implemented foundation:

- newly completed scans store report metadata inside `summary_json.report`;
- `digest` is SHA-256 over stable canonical report JSON built from redacted scan evidence, including the deterministic rules version and release/context finding annotations so digests change when the ruleset or visible risk interpretation changes;
- newly completed scans store `summary_json.risk` with release, artifact, and context risk; `scans.risk` stores the primary release risk for new reports, while old reports without the breakdown are treated as legacy artifact-risk rows;
- each deterministic finding carries `ruleId` and `ruleVersion` (see `DETERMINISTIC_RULES_VERSION` in `server/lib/review.ts`), persisted on `scan_findings.rule_id` / `rule_version`;
- persisted scan detail renders report version, digest, rules version, package diff, and safety posture (AI review is disabled — see the Workers AI section).

Prepare next for:

- dedicated `report_version` / `report_digest` columns if queryability becomes important;
- `completed_at`;
- immutable report payload snapshots in R2;
- future `scan_report_signatures` rows signed by a user.

Do not expose public signed report generation until the report payload is stable and access controls are ready.

## API direction

Current API:

- `POST /api/v1/scans` — create queued/background scan;
- `POST /api/v1/scan` — synchronous compatibility scan;
- `POST /api/v1/staged-publishes/scan` — discover open staged publishes and create scans for newly found stage IDs;
- `GET /api/v1/scans` — list organization scans. Supports `filter=undecided|publish|no_publish|all` (default `undecided`), `limit` (default 20, max 100), and `cursor` (opaque `<createdAtMs>:<id>` token). Response includes `nextCursor` for the next page; retries are no longer deduplicated by stage id so every scan appears in the timeline;
- `GET /api/v1/scans/:id` — scan status/report detail;
- `POST /api/v1/scans/:id/decision` — record a `publish` or `no_publish` decision on a `complete` scan with an optional `reason` (≤500 chars). Returns the updated scan detail and emits a `scan.decided` audit event. Returns 409 if the scan is not yet complete;
- `GET /api/v1/npm-connection` — read connection metadata;
- `POST /api/v1/npm-connection` — create/rotate connection;
- `POST /api/v1/npm-connection/validate` — validate access;
- `DELETE /api/v1/npm-connection` — remove connection.
- `GET /api/v1/organizations` — list the caller's organizations (personal first), each with `npmConnectionConfigured`;
- `POST /api/v1/organizations` — create a new organization owned by the caller;
- `PATCH /api/v1/organizations/:id` — rename (owner-only).

All other `/api/v1/*` endpoints honor the `x-organization-id` request header to pick the active org; absent or non-member ids silently fall back to the caller's personal org.

Keep `POST /api/v1/scan` only as a compatibility shim during migration.

## PyPI workflow-gate foundation

PyPI support is intentionally modeled as a separate workflow-gate mode because PyPI does not have npm's staged-publish review primitive. The current backend foundation lives in `server/lib/adapters/pypi/index.ts` as a `PackageAdapter` implementation, but it is not yet mounted as a route or persisted scan type.

Implemented pieces:

- `drydock.release-artifacts.v1` manifest validation for `ecosystem: "pypi"`;
- PyPI wheel/sdist artifact normalization and metadata extraction;
- safe ZIP parsing for `.whl` archives in the sandbox parser;
- PyPI-specific deterministic findings for manifest/metadata mismatches, missing wheel `RECORD`, `.pth` startup hooks, custom `setup.py` install commands, and `.pyd` native extensions;
- PyPI project JSON metadata helpers for baseline release selection and wheel/sdist download metadata.

The target gate is a GitHub custom deployment protection rule on the same GitHub Environment configured in PyPI Trusted Publishers. CI must build artifacts before the gate, Drydock must review those exact artifact digests, and the publish job must verify the digest manifest immediately before invoking PyPI trusted publishing. See [`pypi-workflow-gate.md`](./pypi-workflow-gate.md).
