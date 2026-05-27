# Production roadmap

This roadmap converts the current staged-publish sandbox into a SaaS product while preserving the core safety boundaries. Phases 1–2 (product framing, scan pipeline extraction) and most of phases 3–5 (per-org npm connections, async scans with queues, durable report workbench) have shipped and are no longer tracked here — only outstanding work is listed below.

## Product assumptions

- SaaS product with organization-scoped data.
- No full team RBAC in the first production slice.
- Per-organization npm credentials, not a global production npm token.
- npm approval remains manual and 2FA-protected outside the product.
- Cloudflare Workers AI was the production AI provider. AI review is currently disabled in the pipeline and planned to return as a paid-tier feature; see [`docs/architecture.md`](./architecture.md#workers-ai-disabled) and [`docs/cost-model.md`](./cost-model.md#ai-model-strategy-paused-planned-paid-tier).
- Raw tarballs are not retained by default.
- Signed reports are prepared for but not launched yet.

## Current cut line

The prototype-to-product foundation is in place: authenticated organization-scoped scans, encrypted organization npm connections, async-capable scan jobs (idempotent across retries), persisted report metadata, and a text-only release diff workbench all exist. The next roadmap iteration is **multi-organization workspaces**: a single user can create and switch between multiple organizations, each holding its own granular npm token, so maintainers can segment work by npm scope, employer, or client without juggling accounts.

Closed: tenant-boundary, sandbox-gateway, and archive-parser regression tests now have route- and unit-level coverage (`test/workers/cross-org-routes.test.ts`, `test/workers/cross-org-npm-connection.test.ts`, `test/workers/sandbox-gateway-runtime.test.ts`, `test/tar-parser.test.mjs`).

PyPI workflow-gate support has a backend foundation only: manifest validation, PyPI metadata helpers, safe wheel ZIP parsing, and deterministic PyPI artifact findings. It is not yet a routed or persisted product workflow. See [`pypi-workflow-gate.md`](./pypi-workflow-gate.md).

## Phase 3 — Per-organization npm connections (open follow-up)

Open validation question:

- Confirm the minimum npm token capability required for staged package list/view/download endpoints. Current validation checks registry auth with `/-/whoami` and staged-tarball access for a supplied stage ID; before launch, add list/view endpoint checks if npm exposes/permits them for token validation.

## Phase 4 — Async scans with Cloudflare Queues (remaining)

- Validate that exhausted retryable failures land in the DLQ in production and are visible to operators (queue, DLQ, and bindings are provisioned).
- Add operator-visible scan duration/failure metrics.

## Phase 5 — Durable report workbench (remaining)

- Group deterministic and AI findings by severity/source.
- Group scan lifecycle events into a human-readable timeline.
- Use `completed_at` more visibly in list/detail metadata.
- Add file search/filter and a changed-files-first default while preserving safe text-only rendering.
- Decide TTL/eviction expectations for the production `COMPARE_CACHE` KV namespace (the namespace itself is provisioned).

## Phase 6 — R2 derived artifacts

Status: not started. R2 is not required for private beta if D1 deletion/retention for current redacted samples is implemented, but it becomes important for larger reports, exports, and future signing.

Goals:

- Move larger report artifacts out of D1.
- Preserve useful evidence without default raw tarball retention.

Tasks:

- Add R2 binding and production bucket provisioning docs.
- Store derived/redacted artifacts:
  - canonical report JSON;
  - manifest JSON;
  - redacted changed-file samples;
  - diff JSON.
- Store R2 object references in D1.
- Add retention cleanup strategy and deletion workflow that removes both D1 metadata and R2 objects.
- Document object key format, access rules, and expected object sizes.

Default policy:

- Do not retain raw tarballs.
- Do not retain full unredacted package files.
- Consider raw artifact retention only as a later opt-in org setting with short TTL and audit logs.

Exit criteria:

- D1 remains metadata-focused.
- Report artifacts are retrievable for persisted scans.
- Artifact storage follows the documented safe default.

## Phase 7 — Production hardening (remaining)

- Add structured error classes and user-safe messages across all scan failures.
- Add archive parser fuzz/regression tests and deeper archive-bomb protections.
- Add line numbers to deterministic findings where possible.
- Add metrics/logging for scan durations, queue retries/exhaustion, failures, AI failures, and npm failures.
- Add D1/R2 retention controls for persisted redacted text samples and derived artifacts.
- Add deployment checklist and incident-response notes.

## Phase 8 — Multi-organization workspace

Priority: highest.

Goals:

- One user can own and switch between multiple organizations.
- Each organization holds its own granular npm token (still one connection per org).
- All existing org-scoped surfaces (scans, npm connection, reports) follow the active organization without UI rework beyond a header switcher.
- Personal org behavior is preserved: every user gets a deterministic "Personal" org on first signup and is the default fallback when no org is explicitly selected.

Tasks:

- Server resolver: `server/lib/active-organization.ts` exports `requireActiveOrganization(c, db)`. It reads the `x-organization-id` request header, verifies membership in `organization_members`, and silently falls back to the personal org (creating it via `ensurePersonalOrganization` if missing) when the header is absent or points at a non-member org. No server-side active-org column — switching is per-device.
- Routes: replace every `ensurePersonalOrganization` call in `routes/scan.ts`, `routes/scans.ts`, `routes/npm-connection.ts`, `routes/staged-publishes.ts` with `requireActiveOrganization`. Keep `ensurePersonalOrganization` as the first-signup bootstrap.
- New `routes/organizations.ts`:
  - `GET /api/v1/organizations` — orgs the user belongs to (personal first), each with `isPersonal` and `npmConnectionConfigured`.
  - `POST /api/v1/organizations` — create org + owner membership in one transaction.
  - `PATCH /api/v1/organizations/:id` — owner-only rename.
- UI: `src/models/active-organization.ts` owns the localStorage-backed `activeOrganizationId` signal. `apiFetch` reads it and attaches `x-organization-id` to every request. `src/models/organization.ts` exposes list/create/activate/rename and auto-selects the first listed org when no stored id is valid. `OrgSwitcher` in the dashboard header is a native `<select>` per DESIGN.md with an inline create form.
- Tests: `test/workers/organizations-routes.test.ts` covers list (personal-first ordering), create, rename (owner-only → 403), header-scoped npm-connection write, and non-member header fall-back to personal. Existing `cross-org-routes.test.ts` and `cross-org-npm-connection.test.ts` continue to cover the personal-org default path.

Out of scope (kept in Phase 12): invitations, RBAC beyond owner, org deletion, audit log UI, billing, quotas, cross-device active-org sync.

Exit criteria:

- A user can create an org, switch to it on a given device, attach a different npm token, and run scans scoped to that org without the personal org's data appearing.
- Cross-org isolation tests pass against the header-based path.
- Each device remembers its own active org via localStorage; clearing localStorage falls back to personal.

## Phase 9 — Trustworthy report artifacts

Priority: high.

Goals:

- Make reports durable, understandable, exportable, and ready for later signing.
- Let maintainers archive evidence for what was reviewed.

Tasks:

- Add canonical report JSON export.
- Add human-readable report export, initially HTML; PDF can follow if needed.
- Add report digest tests for stable canonical ordering and evidence changes.
- Store scanner version, deterministic rules version, prompt version, model/provider metadata, and report schema version.
- Add a report provenance section: package name, staged version, previous version, selected comparison version, stage ID, generated timestamp, artifact digests, and review limitations.
- Add AI failure states that preserve deterministic findings when AI is unavailable.
- Store AI latency and provider/model metadata where available.
- Keep signed/public report URLs deferred, but design exports so signing can wrap the same canonical artifact later.

Exit criteria:

- A completed scan can be exported and archived.
- Users can verify whether two report artifacts describe the same evidence.
- Reports clearly distinguish deterministic findings from AI commentary.

## Phase 10 — Maintainer-grade review UX

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
- Add first-run onboarding: connect npm token, wait for automatic validation, paste stage ID, review report.
- Add in-app npm token setup guidance with least-privilege recommendations.

Exit criteria:

- A maintainer can understand the release risk in under a minute.
- Failure and recovery paths are clear.
- The UI reinforces that approval remains manual outside the product.

## Phase 11 — Proactive stage monitoring and email notifications

Priority: high after the manual scan flow is reliable.

Goals:

- Let maintainers opt in to automatic discovery of new npm staged publishes.
- Reuse the existing queued scan pipeline so newly discovered stages are scanned without the user pasting a stage ID.
- Notify the right user when an automatic scan finishes or fails, while keeping npm approval manual and outside the product.

Tasks:

- Confirm npm staged-publish list/view APIs can enumerate new stages with organization-owned credentials, and document the minimum token capabilities required.
- Add organization/package monitoring settings for opt-in scopes/packages, notification recipients, and notification preferences.
- Add a scheduled discovery job, likely Cloudflare Cron-triggered, that polls for new staged publishes per npm connection.
- Deduplicate discovered stage IDs in D1 and enqueue scan jobs idempotently so retries or repeated polls do not create duplicate automatic scans.
- Reuse the existing scan lifecycle and persisted report surface for automatic scans.
- Add an email notification provider and safe templates for scan complete, high-risk scan complete, and scan failed states, each linking back to the persisted report.
- Add audit events and operator metrics for stage discovered, automatic scan queued, notification sent, and notification failed.
- Add UI for enabling/disabling monitoring and showing last discovery/notification status.

Exit criteria:

- An opted-in organization automatically scans new staged publishes without manually pasting a stage ID.
- Each discovered stage is scanned at most once per organization unless a user explicitly retries it.
- Users receive an email with a link to the persisted scan report when the automatic scan reaches a terminal state.
- The product still makes clear that npm approval remains manual outside the product.

## Phase 12 — Team and commercial readiness

Priority: medium after private beta proves value.

Goals:

- Support real organizations instead of only personal organization ownership.
- Prepare the product for team usage, billing, and operator administration.

Tasks:

- Add multiple npm connections per organization so maintainers can segment tokens by npm scope, package, or release workflow.
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

## Phase 13 — Security-product defensibility

Priority: ongoing.

Goals:

- Make detection quality measurable and defensible.
- Improve confidence over time without weakening the sandbox and credential boundaries.

Tasks:

- Expand the golden fixture corpus of benign and malicious npm package patterns. The initial safe synthetic corpus and research notes live in [`security-detection-corpus.md`](./security-detection-corpus.md).
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

## Phase 14 — PyPI workflow gate

Priority: after the npm review loop is stable enough for a second operating mode.

Goals:

- Review PyPI release candidates before the trusted-publishing job uploads them.
- Preserve the invariant that the publish job uploads the exact wheel/sdist bytes Drydock reviewed.
- Keep PyPI credentials and OIDC token exchange outside Drydock.

Implemented foundation:

- `server/lib/adapters/pypi/index.ts` validates `drydock.release-artifacts.v1` PyPI manifests, reads PyPI project JSON metadata, selects a published baseline, and creates PyPI deterministic findings through the shared `PackageAdapter` contract.
- `server/lib/tar-parser.js` now supports safe ZIP parsing for wheel archives.
- `NpmStageGateway` can allow exact public artifact URLs without attaching npm credentials.

Remaining tasks:

- Add GitHub App installation, repository, workflow, and environment mapping.
- Handle GitHub `deployment_protection_rule` webhooks for the PyPI environment.
- Fetch GitHub Actions artifacts and the required `drydock-manifest.json`.
- Verify artifact SHA-256 digests before review and before publish.
- Persist workflow-gate reviews without overloading npm `stage_id`.
- Download previous PyPI release artifacts from `files.pythonhosted.org` for comparison.
- Add UI for PyPI setup, gate status, and review reports.

Exit criteria:

- A GitHub Actions PyPI publish job waits on Drydock through a GitHub Environment gate.
- Drydock reviews all candidate wheels/sdists and compares them to the selected previous PyPI release.
- The publish job verifies the reviewed manifest digest and publishes with PyPI Trusted Publishing only after gate approval.

## Deferred work

- Public signed report URLs until canonical exports are stable.
- User-signed review decisions until team workflows are stable.
- Optional raw tarball retention.
- Multiple AI provider abstraction.
- Deep native/binary malware analysis.
- Automated publish approval, which is intentionally out of scope.
- Private beta operations gating: production Queues/KV/D1/secrets configuration, scan-duration / failure / retry metrics + logging, email verification + Turnstile, endpoint rate limits, custom-registry abuse controls, and a deployment + incident-response checklist. Defer until product surface stabilizes after multi-org and the diff-first review UX land.
- Scan/report deletion and a documented retention policy for persisted redacted text samples. Defer alongside private beta operations.

## Suggested next implementation slice

Multi-organization workspace (Phase 8) is the next slice — schema migration, active-org resolver, organizations route, dashboard switcher, and refreshed cross-org tests. Once it lands, Phase 10 (maintainer-grade review UX) is next and should be reframed around the diff-first product direction before implementation starts.
