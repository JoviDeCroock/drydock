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
- It is clear that every scan uses an organization-owned npm credential.
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

- Require each organization to bring its own npm credential.
- Ensure SaaS scans always resolve credentials from the owning organization.

Completed:

- Added `npm_connections` schema via Drizzle.
- Added encryption helpers using the dedicated `NPM_CONNECTIONS_ENCRYPTION_KEY` secret.
- Store token ciphertext, nonce, label, registry URL, fingerprint/last4, validation metadata, and timestamps.
- Added authenticated organization-scoped routes:
  - `GET /api/v1/npm-connection`
  - `POST /api/v1/npm-connection`
  - `POST /api/v1/npm-connection/validate`
  - `DELETE /api/v1/npm-connection`
- Added audit events for connection add, validate, use, and delete.
- Added optional stage-ID validation that checks staged-tarball access without retaining the tarball.
- Updated gateway usage so scan downloads use the current organization's connection.
- Aligned gateway credential injection with Cloudflare's outbound Worker sandbox-auth pattern.

Open validation question:

- Confirm the minimum npm token capability required for staged package list/view/download endpoints. Current validation checks registry auth with `/-/whoami` and staged-tarball access for a supplied stage ID; before launch, add list/view endpoint checks if npm exposes/permits them for token validation.

Exit criteria:

- A scan in SaaS mode uses an org-owned credential.
- Token material is never exposed to sandbox, API responses, logs, reports, or AI.
- Credential validation failure is understandable to users.

## Phase 4 — Async scans with Cloudflare Queues

Status: foundation implemented; production queue resource must be created/configured before deploy.

Goals:

- Avoid request-time scan limits and support larger/retryable packages.
- Make scan status first-class.

Completed:

- Added Queue producer/consumer binding shape for `SCAN_QUEUE`.
- Added queue consumer that executes scan jobs without putting npm token material in the queue payload.
- Added local queue-less execution: when no queue binding is present, `POST /api/v1/scans` creates the D1 row and schedules work with `executionCtx.waitUntil()`.
- Added scan status lifecycle:
  - `pending`
  - `running`
  - `complete`
  - `failed`
- Added fields:
  - `started_at`
  - `completed_at`
  - `error_json`
  - `report_version`
  - `report_digest`
- Added `POST /api/v1/scans` to create scan jobs and return immediately with a scan ID.
- Kept `POST /api/v1/scan` as a compatibility path.
- Updated UI to route immediately to scan detail/progress and poll status.
- Record audit events for queued/backgrounded, started, completed, and failed.

Remaining tasks:

- Create the production queue resource (`staged-publish-review-scans`) and verify deploy-time binding.
- Fix queue retry semantics so transient worker/AI/npm failures are retried instead of only logged.
- Add retry/dead-letter policy once expected package and AI failure modes are observed.
- Add operator-visible scan duration/failure metrics.

Exit criteria:

- HTTP request returns quickly after creating a scan.
- Failed scans persist structured errors.
- UI can recover from refresh while a scan is running.

## Phase 5 — Durable report workbench

Status: partially implemented for persisted scan detail; canonical report digest metadata now exists for newly completed scans.

Goals:

- Make persisted scan detail the canonical product surface.
- Remove dependence on ephemeral immediate scan results.

Completed:

- Persist report metadata in scan summary for newly completed scans:
  - report version;
  - SHA-256 digest over stable canonical report JSON;
  - generation timestamp;
  - safety posture.
- Render persisted AI review from `aiJson` on the scan detail page.
- Render package.json diff from persisted summary/report data.
- Render report metadata and safety posture from persisted summary data.
- Render changed-file diff metadata as a first-class persisted section.
- Keep file explorer text-only with escaped safe previews.
- Poll running scans without emitting repeated `scan.viewed` audit events.

Remaining tasks:

- Group deterministic and AI findings by severity/source.
- Group scan lifecycle events into a human-readable timeline.
- Use `completed_at` more visibly in list/detail metadata.
- Continue improving file explorer ergonomics while preserving safe text-only rendering.

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
- Made organization npm connections mandatory for scans.
- Removed npm response bodies from sandbox download errors returned to users.
- Hardened tar parsing for long paths/PAX paths, symlink/hardlink skipping, path traversal normalization, truncated entries, and expanded archive byte caps.
- Removed deployment-wide npm credential paths; scan npm auth now comes from organization connections.
- Tightened `NpmStageGateway` to attach credentials only for `GET` requests to explicit npm staged-tarball, package metadata, or published tarball endpoints.
- Polished the dashboard with launch guardrails, clearer scan setup, npm connection validation, and token status metadata.

Remaining tasks:

- Add structured error classes and user-safe messages across all scan failures.
- Add cross-organization access tests.
- Add archive parser fuzz/regression tests and deeper archive-bomb protections.
- Add line numbers to deterministic findings where possible.
- Add deterministic rule IDs and versions.
- Add metrics/logging for scan durations, failures, AI failures, and npm failures.
- Add D1/R2 retention controls for persisted redacted text samples and derived artifacts.
- Add deployment checklist and incident-response notes.

Exit criteria:

- Abuse and failure modes are visible.
- A malicious or huge package fails safely.
- Launch operators have clear deployment and incident procedures.

## Product excellence phases

These phases turn the current production foundation into a product maintainers can trust as part of a real release decision workflow.

### Phase 8 — Safe private beta readiness

Priority: highest.

Goals:

- Make the current SaaS safe to operate for invited users.
- Close the most important reliability, abuse, and data-retention gaps.

Tasks:

- Fix Queue retry/DLQ semantics so transient scan failures retry and exhausted jobs are visible to operators.
- Add explicit Cloudflare Queue retry policy and dead-letter queue configuration.
- Ensure scan execution is idempotent across retries.
- Add cross-organization tests for scan detail/list access and npm connection isolation.
- Add sandbox gateway tests that prove credentials are only attached to allowed npm registry requests.
- Add tar parser regression tests for traversal paths, absolute paths, PAX paths, GNU long names, links, truncation, huge file counts, and archive-size caps.
- Add invite-only or allowlist mode for private beta signups.
- Add auth abuse controls: email verification, Turnstile or equivalent, and endpoint-specific rate limits.
- Add scan/report deletion and a documented default retention policy for persisted text samples.
- Investigate build output to ensure local `.dev.vars` secrets are never included in deployable or public artifacts.
- Add deployment and incident-response checklists.

Exit criteria:

- Operators can see and recover from failed jobs.
- Public signup cannot be abused trivially.
- Tenant boundaries and credential boundaries are covered by tests.
- Persisted report data has clear retention and deletion behavior.

### Phase 9 — Trustworthy report artifacts

Priority: high.

Goals:

- Make reports durable, understandable, exportable, and ready for later signing.
- Let maintainers archive evidence for what was reviewed.

Tasks:

- Add canonical report JSON export.
- Add human-readable report export, initially HTML; PDF can follow if needed.
- Add report digest tests for stable canonical ordering and evidence changes.
- Store scanner version, deterministic rules version, prompt version, model/provider metadata, and report schema version.
- Add a report provenance section: package name, staged version, previous version, stage ID, generated timestamp, artifact digests, and review limitations.
- Add deterministic finding rule IDs and versions.
- Add AI failure states that preserve deterministic findings when AI is unavailable.
- Store AI latency and provider/model metadata where available.
- Keep signed/public report URLs deferred, but design exports so signing can wrap the same canonical artifact later.

Exit criteria:

- A completed scan can be exported and archived.
- Users can verify whether two report artifacts describe the same evidence.
- Reports clearly distinguish deterministic findings from AI commentary.

### Phase 10 — Maintainer-grade review UX

Priority: high.

Goals:

- Turn scan detail from a technical result page into a release decision cockpit.
- Help maintainers decide whether to manually approve an npm staged publish.

Tasks:

- Add a top-level recommendation: block, review carefully, or likely safe.
- Explain the recommendation with the highest-impact evidence.
- Group findings by severity and source, with deterministic findings before AI findings.
- Add dedicated cards for install scripts, entrypoint changes, dependency changes, new binaries/native files, network-capable code, obfuscation, and secret access.
- Add a scan lifecycle timeline: queued, download staged tarball, download previous version, parse, deterministic review, AI review, report generated.
- Add retry failed scan and cancel pending/running scan flows where platform semantics allow it.
- Improve file explorer ergonomics with search/filter, changed-files-only default, and clearer bounded text sample labeling.
- Add first-run onboarding: connect npm token, validate it, paste stage ID, review report.
- Add in-app npm token setup guidance with least-privilege recommendations.

Exit criteria:

- A maintainer can understand the release risk in under a minute.
- Failure and recovery paths are clear.
- The UI reinforces that approval remains manual outside the product.

### Phase 11 — Team and commercial readiness

Priority: medium after private beta proves value.

Goals:

- Support real organizations instead of only personal organization ownership.
- Prepare the product for team usage, billing, and operator administration.

Tasks:

- Add real organization creation and switching.
- Add multiple npm connections per user/account, scoped through organizations, so maintainers can segment tokens by npm organization, package scope, or release workflow.
- Add per-scan npm connection selection and organization-level defaults once multiple connections exist.
- Add invitations and membership management.
- Add RBAC after the organization model is stable.
- Add audit log UI for npm credential events, scan events, report exports, and future reviewer decisions.
- Add organization usage and quota pages.
- Add billing integration and plan limits.
- Add account and organization deletion/export workflows.
- Add internal operator admin tools for support and abuse response.

Exit criteria:

- Multiple maintainers can collaborate safely in one organization.
- Usage, billing, and audit data are visible to customers and operators.
- Support can diagnose common tenant issues without direct database access.

### Phase 12 — Security-product defensibility

Priority: ongoing.

Goals:

- Make detection quality measurable and defensible.
- Improve confidence over time without weakening the sandbox and credential boundaries.

Tasks:

- Build a golden fixture corpus of benign and malicious npm package patterns.
- Add continuous deterministic-rule and AI-prompt evals.
- Add tests for malformed AI JSON and prompt-injection-like package contents.
- Add archive parser fuzzing or property-based tests.
- Add package intelligence signals: new maintainers, package transfer indicators where available, suspicious dependency additions, binary/native code, minified bundles, and detected external endpoints.
- Add OpenSSF/package reputation integrations if they provide actionable signal.
- Add incident-response playbooks for credential exposure, false negatives, false positives, and npm API changes.
- Later, add signed reports and user-signed review decisions.

Exit criteria:

- Detection changes are evaluated before release.
- Security claims are backed by tests, fixtures, and documented limitations.
- The product earns trust as a release-security tool, not just a scanner UI.

## Deferred work

- Public signed report URLs until canonical exports are stable.
- User-signed review decisions until team workflows are stable.
- Optional raw tarball retention.
- Multiple AI provider abstraction.
- Deep native/binary malware analysis.
- Automated publish approval, which is intentionally out of scope.

## Suggested next implementation slice

Start Phase 8 by finishing Phase 4/7 reliability hardening: define retryable versus permanent scan failures, wire Cloudflare Queue retry/DLQ behavior accordingly, add operator-visible metrics for scan duration, npm fetch failures, AI failures, and queue exhaustion, then add the cross-organization and sandbox gateway tests that lock down SaaS tenant boundaries.
