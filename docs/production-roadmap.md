# Production roadmap

This roadmap converts the current staged-publish sandbox into a SaaS product while preserving the core safety boundaries. Phases 1–2 (product framing, scan pipeline extraction) and most of phases 3–5 (per-org npm connections, async scans with queues, durable report workbench) have shipped and are no longer tracked here — only outstanding work is listed below.

## Product assumptions

- SaaS product with organization-scoped data.
- No full team RBAC in the first production slice.
- Per-organization npm credentials, not a global production npm token.
- npm approval remains manual and 2FA-protected outside the product.
- Cloudflare Workers AI is the production AI provider for now.
- Raw tarballs are not retained by default.
- Signed reports are prepared for but not launched yet.

## Current cut line

The prototype-to-product foundation is in place: authenticated organization-scoped scans, encrypted organization npm connections, async-capable scan jobs (idempotent across retries), persisted report metadata, and a text-only release diff workbench all exist. The next roadmap iteration is **multi-organization workspaces**: a single user can create and switch between multiple organizations, each holding its own granular npm token, so maintainers can segment work by npm scope, employer, or client without juggling accounts.

Closed: tenant-boundary, sandbox-gateway, and archive-parser regression tests now have route- and unit-level coverage (`test/workers/cross-org-routes.test.ts`, `test/workers/cross-org-npm-connection.test.ts`, `test/workers/sandbox-gateway-runtime.test.ts`, `test/tar-parser.test.mjs`).

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
- All existing org-scoped surfaces (scans, npm connection, reports) follow the user's active organization without UI rework beyond a header switcher.
- Personal org behavior is preserved: every user gets a deterministic "Personal" org on first signup and is auto-activated into it.

Tasks:

- Schema: add nullable `active_organization_id` (FK → `organizations.id`, `onDelete: "set null"`) to the `user` table via a Drizzle migration. Keep the `npm_connections` `UNIQUE(organization_id)` index — one token per org stands.
- Server resolver: `server/lib/active-organization.ts` exporting `requireActiveOrganization(db, session)`. Reads `user.active_organization_id`, verifies membership in `organization_members`, and auto-falls-back to the personal org (creating it via `ensurePersonalOrganization` if missing) when the active id is null or stale.
- Routes: replace every `ensurePersonalOrganization` call in `routes/scan.ts`, `routes/scans.ts`, `routes/npm-connection.ts` with `requireActiveOrganization`. Keep `ensurePersonalOrganization` as the first-signup bootstrap.
- New `routes/organizations.ts`:
  - `GET /api/v1/organizations` — orgs the user belongs to, each with `isActive`, `isPersonal`, `npmConnectionConfigured` flags.
  - `POST /api/v1/organizations` — create org + owner membership in one transaction; does not auto-activate.
  - `POST /api/v1/organizations/:id/activate` — membership-gated, updates `user.active_organization_id`, records a scan event.
  - `PATCH /api/v1/organizations/:id` — owner-only rename.
- UI: `src/models/organization.ts` (list/create/activate/rename + active-org signal), `OrgSwitcher` dropdown in the dashboard header, and a "Create organization" modal. Existing scan/npm-connection panels become implicitly active-org-scoped via the resolver.
- Tests: `test/workers/organizations-routes.test.ts` (create / list / activate own / activate other → 403 / rename non-owner → 403). Refresh `cross-org-routes.test.ts` and `cross-org-npm-connection.test.ts` to exercise the active-org switching path rather than the deterministic personal-org ID.

Out of scope (kept in Phase 12): invitations, RBAC beyond owner, org deletion, audit log UI, billing, quotas.

Exit criteria:

- A user can create an org, switch to it, attach a different npm token, and run scans scoped to that org without the personal org's data appearing.
- Cross-org isolation tests pass against the active-org path.
- Refreshing the page restores the previously-active org.

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
- Store AI latency and provider/model metadata where available, including whether the default model or escalation model reviewed the scan.
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
- Add first-run onboarding: connect npm token, validate it, paste stage ID, review report.
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
- Private beta operations gating: production Queues/KV/D1/secrets configuration, scan-duration / failure / retry metrics + logging, invite-only signup with email verification + Turnstile + endpoint rate limits, and a deployment + incident-response checklist. Defer until product surface stabilizes after multi-org and the diff-first review UX land.
- Scan/report deletion and a documented retention policy for persisted redacted text samples. Defer alongside private beta operations.

## Suggested next implementation slice

Multi-organization workspace (Phase 8) is the next slice — schema migration, active-org resolver, organizations route, dashboard switcher, and refreshed cross-org tests. Once it lands, Phase 10 (maintainer-grade review UX) is next and should be reframed around the diff-first product direction before implementation starts.
