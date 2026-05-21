# Production roadmap

This roadmap converts the current staged-publish sandbox into a SaaS product while preserving the core safety boundaries.

## Product assumptions

- SaaS product with organization-scoped data.
- No full team RBAC in the first production slice.
- Per-organization npm credentials, not a global production npm token.
- npm approval remains manual and 2FA-protected outside the product.
- Cloudflare Workers AI is the production AI provider for now.
- Raw tarballs are not retained by default.
- Signed reports are prepared for but not launched yet.

## Phase 1 — Product baseline

Status: documentation in progress.

Goals:

- Reframe repository from prototype to production product.
- Document architecture, trust boundaries, and security posture.
- Keep implementation behavior stable while product decisions are made explicit.

Deliverables:

- README product framing.
- Architecture documentation.
- Security model documentation.
- Production roadmap.

Exit criteria:

- New contributors can understand the target SaaS model.
- It is clear that global `NPM_TOKEN` is not the production credential model.
- It is clear that approval automation is out of scope.

## Phase 2 — Scan pipeline extraction

Status: implemented for the synchronous route; ready to be reused by a Queue consumer.

Goals:

- Make scan execution reusable outside the synchronous route.
- Prepare for Queues without changing user-visible behavior yet.

Completed:

- Moved scan orchestration from `server/routes/scan.ts` to `server/lib/scan-pipeline.ts`.
- Kept `POST /api/v1/scan` working as a compatibility wrapper.
- Centralized scan persistence and completion audit-event emission in the pipeline.
- Preserved current test/typecheck behavior.

Remaining follow-up:

- Add focused tests once the pipeline has injectable downloader/AI dependencies or a Queue consumer.

Exit criteria:

- The route handler is thin.
- The same pipeline can be called by an HTTP route or Queue consumer.
- No behavior regressions in current tests/typecheck.

## Phase 3 — Per-organization npm connections

Status: foundation implemented; staged-tarball capability validation implemented when a stage ID is supplied; npm list/view validation still pending.

Goals:

- Replace production reliance on deployment-level `NPM_TOKEN`.
- Let each organization bring its own npm credential.

Completed:

- Added `npm_connections` schema via Drizzle.
- Added encryption helpers using a Worker secret-derived key.
- Store token ciphertext, nonce, label, registry URL, fingerprint/last4, validation metadata, and timestamps.
- Added authenticated organization-scoped routes:
  - `GET /api/v1/npm-connection`
  - `POST /api/v1/npm-connection`
  - `POST /api/v1/npm-connection/validate`
  - `DELETE /api/v1/npm-connection`
- Added audit events for connection add, validate, use, and delete.
- Added optional stage-ID validation that checks staged-tarball access without retaining the tarball.
- Updated gateway usage so scan downloads use the current organization's connection when present.
- Kept global `NPM_TOKEN` as a local/dev fallback when no organization connection exists.
- Aligned gateway credential injection with Cloudflare's outbound Worker sandbox-auth pattern.

Open validation question:

- Confirm the minimum npm token capability required for staged package list/view/download endpoints. Current validation checks registry auth with `/-/whoami` and staged-tarball access for a supplied stage ID; before launch, add list/view endpoint checks if npm exposes/permits them for token validation.

Exit criteria:

- A scan in SaaS mode uses an org-owned credential.
- Token material is never exposed to sandbox, API responses, logs, reports, or AI.
- Credential validation failure is understandable to users.

## Phase 4 — Async scans with Cloudflare Queues

Goals:

- Avoid request-time scan limits and support larger/retryable packages.
- Make scan status first-class.

Tasks:

- Add Queue binding and consumer.
- Add scan status lifecycle:
  - `pending`
  - `running`
  - `complete`
  - `failed`
- Add fields as needed:
  - `started_at`
  - `completed_at`
  - `error_json`
  - `report_version`
  - `report_digest`
- Add `POST /api/v1/scans` to create scan jobs.
- Keep/deprecate `POST /api/v1/scan` as a compatibility path.
- Update UI to route immediately to scan detail/progress and poll status.
- Record audit events for created, queued, started, completed, and failed.

Exit criteria:

- HTTP request returns quickly after creating a scan.
- Failed scans persist structured errors.
- UI can recover from refresh while a scan is running.

## Phase 5 — Durable report workbench

Goals:

- Make persisted scan detail the canonical product surface.
- Remove dependence on ephemeral immediate scan results.

Tasks:

- Render persisted AI review from `aiJson`.
- Render package.json diff from persisted summary/report data.
- Render changed-file diff metadata from persisted summary/report data.
- Group findings by severity/source.
- Show scan lifecycle state and structured errors.
- Add report metadata:
  - report version;
  - report digest;
  - scan completion time;
  - safety posture.
- Improve file explorer while preserving safe text-only rendering.

Exit criteria:

- Opening a persisted scan shows all important report sections.
- The page is useful for maintainer review without rerunning a scan.
- Report data is stable enough for future signing work.

## Phase 6 — R2 derived artifacts

Goals:

- Move larger report artifacts out of D1.
- Preserve useful evidence without default raw tarball retention.

Tasks:

- Add R2 binding.
- Store derived/redacted artifacts:
  - canonical report JSON;
  - manifest JSON;
  - redacted changed-file samples;
  - diff JSON.
- Store R2 object references in D1.
- Add retention cleanup strategy.
- Document object key format and access rules.

Default policy:

- Do not retain raw tarballs.
- Do not retain full unredacted package files.
- Consider raw artifact retention only as a later opt-in org setting with short TTL and audit logs.

Exit criteria:

- D1 remains metadata-focused.
- Report artifacts are retrievable for persisted scans.
- Artifact storage follows the documented safe default.

## Phase 7 — Production hardening

Status: partially implemented in the synchronous path; operational metrics/alerts and async failure handling still pending.

Goals:

- Reduce operational and abuse risk before launch.

Completed:

- Added D1-backed rate limits for scan creation, npm connection save, and npm connection validation.
- Added a production hardening switch, `REQUIRE_ORG_NPM_CONNECTION=true`, to reject scans without an organization npm connection.
- Removed npm response bodies from sandbox download errors returned to users.
- Hardened tar parsing for long paths/PAX paths, symlink/hardlink skipping, path traversal normalization, truncated entries, and expanded archive byte caps.
- Polished the dashboard with launch guardrails, clearer scan setup, npm connection validation, and token status metadata.

Remaining tasks:

- Add structured error classes and user-safe messages across all scan failures.
- Add cross-organization access tests.
- Add archive parser fuzz/regression tests and deeper archive-bomb protections.
- Add line numbers to deterministic findings where possible.
- Add deterministic rule IDs and versions.
- Add metrics/logging for scan durations, failures, AI failures, and npm failures.
- Add deployment checklist and incident-response notes.

Exit criteria:

- Abuse and failure modes are visible.
- A malicious or huge package fails safely.
- Launch operators have clear deployment and incident procedures.

## Deferred work

- Full team RBAC and invitations.
- Public signed report URLs.
- User-signed review decisions.
- Optional raw tarball retention.
- Multiple AI provider abstraction.
- Deep native/binary malware analysis.
- Automated publish approval, which is intentionally out of scope.

## Suggested next implementation slice

Start Phase 4: add Queue-backed async scans. The scan pipeline and org-owned npm credential foundation now exist, so the next major product seam is creating scans quickly, enqueueing work, and polling persisted scan status/report data.
