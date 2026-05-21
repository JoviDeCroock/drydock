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

The prototype-to-product foundation is in place: authenticated organization-scoped scans, encrypted organization npm connections, async-capable scan jobs (idempotent across retries), persisted report metadata, and a text-only release diff workbench all exist. The next roadmap iteration should optimize for **safe private beta**, not breadth.

Private beta blockers:

- Tenant-boundary, sandbox-gateway, and archive-parser regression tests.
- Operator-visible failure metrics for scan duration, queue retries, and AI/npm failures.
- Signup/credential abuse controls for an invite-only beta.
- Report deletion plus a documented retention policy for persisted redacted evidence.
- Production deploy checklist covering D1 migrations, Queues, KV, secrets, and incident response.

Not private-beta blockers unless customer evidence demands them:

- Team RBAC beyond personal organizations.
- Public signed reports.
- Raw tarball retention.
- Deep native/binary malware analysis.
- Automated npm publish approval, which remains intentionally out of scope.

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
- Add cross-organization access tests.
- Add archive parser fuzz/regression tests and deeper archive-bomb protections.
- Add line numbers to deterministic findings where possible.
- Add deterministic rule IDs and versions.
- Add metrics/logging for scan durations, queue retries/exhaustion, failures, AI failures, and npm failures.
- Add D1/R2 retention controls for persisted redacted text samples and derived artifacts.
- Add deployment checklist and incident-response notes.

## Phase 8 — Safe private beta readiness

Priority: highest.

Goals:

- Make the current SaaS safe to operate for invited users.
- Close the most important reliability, abuse, and data-retention gaps.

Remaining gate tasks:

Reliability and operations:

- Verify Queue retry/DLQ semantics in production so transient scan failures retry and exhausted jobs are visible to operators.
- Continue expanding the structured scan error taxonomy with user-safe messages and operator-facing details.
- Add metrics/logs for scan duration, queue retries/exhaustion, npm fetch failures, AI failures, archive parser failures, and rate-limit events.

Security boundaries:

- Add cross-organization tests for scan detail/list/compare access and npm connection isolation. (DB-layer cross-org assertion landed via `test/workers/scan-idempotency.test.ts`; still need route-level coverage.)
- Add sandbox gateway tests that prove credentials are only attached to allowed npm registry requests. (Pure-function policy coverage exists; add an end-to-end test that exercises the gateway through the Worker runtime — the `@cloudflare/vitest-pool-workers` harness is now in place.)
- Add tar parser regression tests for traversal paths, absolute paths, PAX paths, GNU long names, links, truncation, huge file counts, and archive-size caps.
- Investigate build output to ensure local `.dev.vars` secrets are never included in deployable or public artifacts.

Abuse and data lifecycle:

- Add invite-only or allowlist mode for private beta signups.
- Add auth abuse controls: email verification, Turnstile or equivalent, and endpoint-specific rate limits.
- Add scan/report deletion and a documented default retention policy for persisted text samples.
- Add deployment and incident-response checklists.

Nice-to-have before widening beta:

- Add basic AI model routing from [`docs/cost-model.md`](./cost-model.md): cheaper default triage, Kimi escalation for risky or ambiguous scans.
- Add first-run onboarding copy for least-privilege npm token setup.

Exit criteria:

- Operators can see and recover from failed jobs.
- Public signup cannot be abused trivially.
- Tenant boundaries and credential boundaries are covered by tests.
- Persisted report data has clear retention and deletion behavior.

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
- Add deterministic finding rule IDs and versions.
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

## Suggested next implementation slice

With queue idempotency landed, the next two slices for Phase 8 are:

1. **Boundary tests:** add cross-organization tests for list/detail/compare routes, sandbox gateway credential-injection tests at the runtime layer, and archive parser regression fixtures.
2. **Private beta operations:** configure production Queues/KV/D1/secrets, add metrics/logging for scan duration and failure classes, add invite-only signup protection, and document deployment + incident response.

After those land, improve maintainer UX by grouping findings and adding the lifecycle timeline before broadening beta access.
