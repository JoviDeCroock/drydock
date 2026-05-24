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

The dynamic Worker's tar parser is defined in `server/lib/tar-parser.js` and concatenated into the sandbox module by `server/lib/sandbox.ts` via `Function.prototype.toString()`. This keeps the parser code path the one exercised by the unit tests in `test/tar-parser.test.mjs` instead of a sibling string copy that could drift.

### NpmStageGateway

`NpmStageGateway` is the only component allowed to attach npm authorization. It follows Cloudflare's [outbound Worker pattern for sandbox auth](https://blog.cloudflare.com/sandbox-auth/): the sandbox makes a normal fetch, while a trusted WorkerEntrypoint receives props from the parent Worker and conditionally injects credentials without exposing them to the sandbox.

It should:

- accept an organization-scoped credential context from the parent Worker;
- attach auth only to allowed npm registry endpoints;
- never forward auth to arbitrary origins;
- record token-use audit events at the parent layer;
- keep the sandbox ignorant of credentials.

Current code supports encrypted per-organization npm connections only. Scans require the current organization to connect its own credential before any npm staged-package fetch occurs.

## Scan pipeline

Current high-level flow:

1. User submits a `stageId`.
2. API validates input and resolves the authenticated user's active organization via `requireActiveOrganization`.
3. Parent Worker loads the staged tarball in a Dynamic Worker and fetches staged metadata (`GET /-/stage/{stageId}`) in parallel in the trusted parent for dist-tag, shasum, and mismatch checks. Current npm staged-view responses are metadata-only; if npm later exposes the prepared manifest, the parser can merge it.
4. Gateway attaches npm auth only for allowed sandbox npm registry endpoints.
5. Sandbox extracts bounded file records and tarball-derived package metadata. The package metadata models npm manifest normalization that is inferable from tarball contents, including npm's implicit `scripts.install = "node-gyp rebuild"` when a root `*.gyp` file exists and no `install`/`preinstall` script or `gypfile=false` is declared.
6. Parent Worker fetches npm package metadata, chooses a tag-aware comparison baseline, and downloads the selected previous published tarball when available.
7. Sandbox extracts the selected previous tarball.
8. Parent Worker computes:
   - package file diff;
   - package.json diff;
   - deterministic findings, including implicit npm lifecycle hooks surfaced from tarball shape and warnings when `package.json` cannot be parsed;
   - redacted package/file records.
9. Parent Worker derives risk from deterministic findings, persists the scan, records audit events, and returns/report renders the result. (AI review is disabled — see "Workers AI" below.)

Current async-capable flow:

1. `POST /api/v1/scans` creates a `pending` scan and returns the scan ID.
2. If `SCAN_QUEUE` is bound, the parent Worker sends a token-free scan job message to Cloudflare Queues; otherwise local/dev falls back to `executionCtx.waitUntil()`.
3. Queue/background execution marks the scan `running`, resolves the organization's encrypted npm connection, and executes the scan pipeline.
4. Pipeline stores derived/redacted report data and marks the scan `complete`.
5. Terminal failures are persisted as `failed` with structured `error_json`; transient npm/sandbox failures are retried before they are marked failed.
6. Exhausted retryable Queue jobs are sent to the configured dead-letter queue for operator review.
7. UI polls `GET /api/v1/scans/:id` until terminal state.

`POST /api/v1/scan` remains a synchronous compatibility route while the product moves to the persisted report surface.

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

Workers AI review is currently **disabled in the scan pipeline**. The reviewer module — `server/lib/ai-review.ts`, its two-tier escalation policy (default `@cf/qwen/qwen3-30b-a3b-fp8`, escalation `@cf/moonshotai/kimi-k2.5`), the prompt-injection-resistant system prompt, the JSON schema, and the test suite (skipped) — is kept on disk so it can be re-introduced behind a paid tier without re-engineering the contract.

Scans persist `scan.aiJson = null` while AI review is disabled, and the UI omits the reviewer-notes section entirely. Risk is computed exclusively from deterministic findings.

When AI review returns it will continue to:

- see changed files only;
- see redacted bounded text samples;
- receive deterministic findings as authoritative evidence;
- treat every package-derived string as hostile evidence, not instructions;
- explicitly check npm supply-chain hazards such as lifecycle scripts, added dependencies whose own postinstall/install hooks are not visible in the staged tarball, entrypoint changes, credential access, network/process execution, obfuscation, and native artifacts;
- return schema-constrained JSON;
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
- `digest` is SHA-256 over stable canonical report JSON built from redacted scan evidence, including the deterministic rules version so digests change when the ruleset changes;
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
