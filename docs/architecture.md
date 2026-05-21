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
  ├─ Workers AI review
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
- calls Workers AI with constrained inputs;
- persists redacted report data and audit events.

### Dynamic Worker sandbox

The Dynamic Worker handles untrusted package bytes. It:

- receives only scan options and registry URLs;
- never receives npm credentials;
- cannot directly reach the Internet except through `globalOutbound`;
- parses archive bytes into bounded file summaries;
- returns metadata and text samples, not executable behavior.

The sandbox must stay small and boring. Do not add package execution, dependency installation, build steps, import resolution, or rendering.

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
2. API validates input and resolves the authenticated user's personal organization.
3. Parent Worker loads the staged tarball in a Dynamic Worker.
4. Gateway attaches npm auth only for allowed npm registry endpoints.
5. Sandbox extracts bounded file records and package metadata.
6. Parent Worker fetches npm package metadata and the previous published tarball when available.
7. Sandbox extracts the previous tarball.
8. Parent Worker computes:
   - package file diff;
   - package.json diff;
   - deterministic findings;
   - redacted package/file records.
9. Workers AI reviews changed files only with a static prompt-injection-resistant system prompt.
10. Parent Worker combines deterministic and AI risk, persists the scan, records audit events, and returns/report renders the result.

Current async-capable flow:

1. `POST /api/v1/scans` creates a `pending` scan and returns the scan ID.
2. If `SCAN_QUEUE` is bound, the parent Worker sends a token-free scan job message to Cloudflare Queues; otherwise local/dev falls back to `executionCtx.waitUntil()`.
3. Queue/background execution marks the scan `running`, resolves the organization's encrypted npm connection, and executes the scan pipeline.
4. Pipeline stores derived/redacted report data and marks the scan `complete`.
5. Failures are persisted as `failed` with structured `error_json`.
6. UI polls `GET /api/v1/scans/:id` until terminal state.

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

### Workers AI

Workers AI is the production AI provider for now. The AI reviewer:

- sees changed files only;
- sees redacted bounded text samples;
- receives deterministic findings as authoritative evidence;
- treats every package-derived string as hostile evidence, not instructions;
- explicitly checks npm supply-chain hazards such as lifecycle scripts, added dependencies whose own postinstall/install hooks are not visible in the staged tarball, entrypoint changes, credential access, network/process execution, obfuscation, and native artifacts;
- must return schema-constrained JSON;
- can raise risk or add context only when the returned review is complete, schema-valid, and includes findings or an explicit manual-review flag;
- cannot approve a release or downgrade deterministic findings.

If the AI response is unavailable, malformed, or incomplete, the scan records that assistant review status separately as `unavailable` or `invalid`. That fallback does **not** raise package risk by itself; the deterministic scanner remains authoritative and the UI should show the AI review as not assessed rather than treating parser/model failure as evidence of suspicious package behavior.

## Organization model

The product target is SaaS with organization-scoped resources.

Current implementation creates a personal organization per authenticated user. This is acceptable for the first production slice and keeps future team support straightforward.

Near-term organization-owned resources:

- scans;
- audit events;
- npm connections;
- future report signatures;
- future artifact retention settings.

RBAC is deferred. Until RBAC ships, route guards should continue to enforce organization ownership even if every member is effectively an owner.

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

Credential validation is empirical where possible: it checks registry auth through `/-/whoami`, and when the user supplies a real stage ID it checks staged-tarball access through the staged tarball endpoint without retaining the tarball. Before launch, add any remaining npm list/view capability checks once the exact endpoint permissions are confirmed. Do not rely solely on broad token labels.

## Report model and future signing

Reports should become canonical data objects even before public signing launches.

Implemented foundation:

- newly completed scans store report metadata inside `summary_json.report`;
- `digest` is SHA-256 over stable canonical report JSON built from redacted scan evidence;
- persisted scan detail renders report version, digest, package diff, AI review, and safety posture.

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
- `GET /api/v1/scans` — list organization scans;
- `GET /api/v1/scans/:id` — scan status/report detail;
- `GET /api/v1/npm-connection` — read connection metadata;
- `POST /api/v1/npm-connection` — create/rotate connection;
- `POST /api/v1/npm-connection/validate` — validate access;
- `DELETE /api/v1/npm-connection` — remove connection.

Keep `POST /api/v1/scan` only as a compatibility shim during migration.
