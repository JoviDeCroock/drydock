# Production roadmap

This roadmap converts the current staged-publish sandbox into a SaaS product while preserving the core safety boundaries. Phases 1–4, most of Phase 5, Phase 8 multi-organization workspaces, the scheduled npm discovery foundation, and the PyPI workflow-gate foundation have shipped. Remaining sections track production hardening, report/provenance work, UX polish, team/commercial features, and detection quality.

## Product assumptions

- SaaS product with organization-scoped data.
- No full team RBAC in the first production slice.
- Per-organization npm credentials, not a global production npm token.
- npm approval remains manual and 2FA-protected outside the product.
- Cloudflare Workers AI is the production AI provider. AI review is wired through `maybeRunAiReview` but gated off by default behind the per-organization Flagship `ai-review` flag for the planned paid-tier feature; see [`docs/architecture.md`](./architecture.md#workers-ai-flagship-gated) and [`docs/cost-model.md`](./cost-model.md#ai-model-strategy-flagship-gated-planned-paid-tier).
- Raw tarballs are not retained by default.
- Signed reports are prepared for but not launched yet.

## Current cut line

The prototype-to-product foundation is in place: authenticated organization-scoped scans, encrypted organization npm connections, multi-organization switching, async-capable scan jobs (idempotent across retries), scheduled npm staged-publish discovery, persisted report metadata, and a text-only release diff workbench all exist.

Closed: tenant-boundary, sandbox-gateway, and archive-parser regression tests now have route- and unit-level coverage (`test/workers/cross-org-routes.test.ts`, `test/workers/cross-org-npm-connection.test.ts`, `test/workers/sandbox-gateway-runtime.test.ts`, `test/tar-parser.test.mjs`).

PyPI workflow-gate support is routed, persisted, and visible in the app: the `POST /webhooks/github` deployment-protection webhook resolves a pending gate against `github_release_targets`, persists a `github_workflow_gates` row, and enqueues a queue-driven review (`executeWorkflowGateJob`) that runs the PyPI pipeline. Settings can install the GitHub App and map release targets; the scan workbench shows gate context and approve/reject controls. What remains is storing reviewed artifact digests in the persisted report and validating the full hosted GitHub/PyPI path operationally. See [`pypi-workflow-gate.md`](./pypi-workflow-gate.md).

## Phase 3 — Per-organization npm connections (closed)

Resolved: `validateNpmCredential` checks registry auth (`/-/whoami`), staged-list, staged-view, and staged-tarball access. A read-only granular token reaches all of these staged endpoints, so the minimum-capability question is answered — no broader token scope is required.

## Phase 4 — Async scans with Cloudflare Queues (remaining)

- Validate that exhausted retryable failures land in the DLQ in production and are visible to operators (queue, DLQ, and bindings are provisioned).
- Add operator-visible scan duration/failure metrics.

## Phase 5 — Durable report workbench (remaining)

- Improve deterministic and AI finding grouping by severity/source beyond the current release/context split.
- Group scan lifecycle events into a human-readable timeline.
- Use `completed_at` more visibly in list/detail metadata.
- Surface report digest, rules version, and provenance in the detail workbench.
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
- Build dashboards/alerts from the structured operational events now emitted for scan durations, queue retries/exhaustion, failures, and AI failures; add provider-specific npm failure rollups where the current safe error codes are too coarse.
- Add D1/R2 retention controls for persisted redacted text samples and derived artifacts.
- Add deployment checklist and incident-response notes.

## Phase 8 — Multi-organization workspace (closed)

Implemented:

- `server/lib/active-organization.ts` exports `requireActiveOrganization(c, db)`. It reads the `x-organization-id` request header, verifies membership in `organization_members`, and falls back to the personal org when the header is absent or points at a non-member org.
- Scan, npm-connection, staged-publish discovery, and GitHub App routes use the active-organization resolver.
- `routes/organizations.ts` exposes `GET /api/v1/organizations`, `POST /api/v1/organizations`, and `PATCH /api/v1/organizations/:id`.
- `src/models/active-organization.ts`, `src/models/organization.ts`, and `OrgSwitcher` provide per-device organization switching backed by localStorage.
- Cross-org isolation and organization route tests cover header-scoped scans/connections and non-member fallback.

Out of scope (kept in Phase 12): invitations, RBAC beyond owner, org deletion, audit log UI, billing, quotas, cross-device active-org sync, and multiple npm connections per organization.

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

- Refine the shipped top-level recommendation and highest-impact evidence copy with real maintainer feedback.
- Improve finding grouping by severity/source, while preserving the current release-delta vs package-context split.
- Add dedicated cards for install scripts, entrypoint changes, dependency changes, new binaries/native files, network-capable code, obfuscation, and secret access.
- Add a scan lifecycle timeline: queued, download staged tarball, download previous version, parse, deterministic review, AI review, report generated.
- Add retry failed scan and cancel pending/running scan flows where platform semantics allow it.
- Improve file explorer ergonomics beyond the shipped file filter, changed-files-only default, and lazy previous-file diff.
- Add first-run onboarding around connecting npm, waiting for validation, using "Check npm", and reading the first report.
- Expand in-app npm token setup guidance with least-privilege recommendations.

Exit criteria:

- A maintainer can understand the release risk in under a minute.
- Failure and recovery paths are clear.
- The UI reinforces that approval remains manual outside the product.

## Phase 11 — Proactive stage monitoring and email notifications

Priority: foundation shipped; product controls remain.

Goals:

- Reuse the existing queued scan pipeline so newly discovered stages are scanned without the user pasting a stage ID.
- Notify the right user when an automatic scan finishes or fails, while keeping npm approval manual and outside the product.
- Add product controls so organizations can decide what to monitor and who to notify.

Implemented foundation:

- Keep npm staged-publish list/view/tarball validation in the connection flow and document the read-only granular token setup in product guidance.
- A `*/15 * * * *` Cloudflare Cron trigger sweeps `valid` and `unvalidated` npm connections, validates unvalidated tokens, skips known-invalid tokens, deduplicates stage IDs, and enqueues `auto_discovery` scans.
- `POST /api/v1/staged-publishes/scan` shares the same discovery path for the dashboard "Check npm" button.
- Automatic scan completion/failure emails use the `SEND_EMAIL` binding and suppress likely cross-organization staged-tarball failures.

Remaining tasks:

- Add organization/package monitoring settings for opt-in scopes/packages, notification recipients, and notification preferences.
- Add UI for enabling/disabling monitoring and showing last discovery/notification status beyond the current "Check npm" freshness indicator.
- Add operator metrics for stage discovered, automatic scan queued, notification sent, and notification failed.

Exit criteria:

- An organization can explicitly configure automatic scan scope and recipients.
- Each discovered stage is scanned at most once per organization unless a user explicitly retries it.
- Users receive an email with a link to the persisted scan report when the automatic scan reaches a terminal state.
- The product still makes clear that npm approval remains manual outside the product.

## Phase 12 — Team and commercial readiness

Priority: medium after private beta proves value.

Goals:

- Support multi-member organizations instead of only single-owner organization workspaces.
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

## Phase 14 — PyPI workflow gate (foundation shipped)

Priority: after the npm review loop is stable enough for a second operating mode.

Goals:

- Review PyPI release candidates before the trusted-publishing job uploads them.
- Preserve the invariant that the publish job uploads the exact wheel/sdist bytes Drydock reviewed.
- Keep PyPI credentials and OIDC token exchange outside Drydock.

Implemented foundation:

- `server/lib/adapters/pypi/index.ts` consumes a derived `drydock.release-artifacts.v1` release set, reads PyPI project JSON metadata, selects a published baseline, and creates PyPI deterministic findings through the shared `PackageAdapter` contract.
- `server/lib/tar-parser.js` now supports safe ZIP parsing for wheel archives.
- `NpmStageGateway` can allow exact public artifact URLs without attaching npm credentials.
- GitHub App installation, repository/environment picker, release-target mapping, and setup guidance live in settings.
- `POST /webhooks/github` verifies the GitHub App secret, resolves the release-target mapping, persists a pending gate, and enqueues a workflow-gate job.
- `fetchReleaseBundleForGate` downloads the run's artifact bundle and collects every wheel/sdist; `preparePyPiReleaseCandidateForGate` derives the release set (package name, version, and SHA-256 digests) from the artifact bytes themselves. There is no `drydock-manifest.json` contract.
- Workflow-gate reviews persist as ordinary scans with `source: "workflow_gate"` and synthetic `stageId: "workflow-gate:<gateId>"`.
- Previous PyPI release artifacts are downloaded from `files.pythonhosted.org` for comparison when a matching namespace exists.
- The scan workbench shows gate context, target-specific recommendation copy, and pending approve/reject controls; decided gates are mirrored onto the scan decision.

Remaining tasks:

- Persist reviewed artifact SHA-256 digests in the report payload for audit/provenance.
- Validate hosted GitHub App installation, webhook delivery, artifact fetch, and decision callback behavior against production GitHub/PyPI projects.
- Add operator dashboards/alerts for gate failures, fail-closed artifact rejection, notification failures, and callback redelivery.

Exit criteria:

- A GitHub Actions PyPI publish job waits on Drydock through a GitHub Environment gate.
- Drydock reviews all candidate wheels/sdists and compares them to the selected previous PyPI release.
- The publish job uploads the exact reviewed wheel/sdist bytes with PyPI Trusted Publishing only after gate approval.

## Deferred work

- Public signed report URLs until canonical exports are stable.
- User-signed review decisions until team workflows are stable.
- Optional raw tarball retention.
- Multiple AI provider abstraction.
- Deep native/binary malware analysis.
- Automated publish approval, which is intentionally out of scope.
- Private beta operations gating: production Queues/KV/D1/secrets validation, scan-duration / failure / retry metrics + logging, email verification + Turnstile, endpoint rate limits, custom-registry abuse controls, and a deployment + incident-response checklist.
- Scan/report deletion and a documented retention policy for persisted redacted text samples. Defer alongside private beta operations.

## Suggested next implementation slice

Report/workbench polish is the next slice: render the persisted scan-event timeline, surface report digest/rules/provenance in the detail page, persist PyPI reviewed artifact digests in the report payload, and tighten finding grouping around the release decision.
