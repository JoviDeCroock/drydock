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

Current implementation runs the scan synchronously in `POST /api/v1/scan`, but the scan orchestration lives in `server/lib/scan-pipeline.ts` so it can be reused by a future Queue consumer. The production target is a queued lifecycle where `POST /api/v1/scans` creates a scan, a Queue consumer runs the pipeline, and the UI reads status/report data from `GET /api/v1/scans/:id`.

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

Current code supports encrypted per-organization npm connections and still falls back to a deployment-level `NPM_TOKEN` for local/development use when no organization connection exists. SaaS deployments should set `REQUIRE_ORG_NPM_CONNECTION=true` so scans require the current organization to connect its own credential.

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

Production target flow:

1. `POST /api/v1/scans` creates a `pending` scan and enqueues work.
2. Queue consumer marks scan `running` and executes the scan pipeline.
3. Pipeline stores derived/redacted artifacts and report data.
4. Queue consumer marks scan `complete` or `failed` with a structured error.
5. UI polls `GET /api/v1/scans/:id` until terminal state.

## Data stores

### D1

D1 stores canonical application state:

- Better Auth users/sessions/accounts;
- organizations and organization members;
- scan rows and status;
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
- must return schema-constrained JSON;
- can raise risk or add context;
- cannot approve a release or downgrade deterministic findings.

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

Prepare for:

- `report_version`;
- `report_digest` over canonical report JSON;
- `completed_at`;
- immutable report payload snapshots;
- future `scan_report_signatures` rows signed by a user.

Do not expose public signed report generation until the report payload is stable and access controls are ready.

## API direction

Current API:

- `POST /api/v1/scan` — synchronous scan;
- `GET /api/v1/scans` — list scans;
- `GET /api/v1/scans/:id` — persisted scan detail.

Target API:

- `POST /api/v1/scans` — create queued scan;
- `GET /api/v1/scans` — list organization scans;
- `GET /api/v1/scans/:id` — scan status/report detail;
- `GET /api/v1/npm-connection` — read connection metadata;
- `POST /api/v1/npm-connection` — create/rotate connection;
- `POST /api/v1/npm-connection/validate` — validate access;
- `DELETE /api/v1/npm-connection` — remove connection.

Keep `POST /api/v1/scan` only as a compatibility shim during migration.
