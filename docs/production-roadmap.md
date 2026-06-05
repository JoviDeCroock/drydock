# Production roadmap

This roadmap tracks remaining product slices. Closed implementation history is intentionally compact here; use git history and the focused docs for detail.

## Product assumptions

- SaaS product with organization-scoped data.
- Basic organization RBAC ships with `owner`, `admin`, and `member` roles. Billing, quotas, audit-log UI, deletion/export, and operator tooling remain later commercial-readiness work.
- npm approval remains manual and 2FA-protected outside Drydock.
- npm uses registry-stage mode: Drydock reviews npm-staged bytes, then the maintainer approves in npm.
- PyPI uses workflow-gate mode: GitHub Environment protection blocks the trusted-publishing job while Drydock reviews built artifacts.
- Per-organization npm credentials are required for npm evidence retrieval; no deployment-wide production npm token.
- AI review is wired but runs only on the gated-target surface (workflow-gate mode) and is default-off behind the per-organization Flagship `ai-review` flag. The staged-publish hot path stays deterministic-only. Deterministic findings remain authoritative.
- Raw tarballs are not retained by default.
- Signed/public reports are prepared for but not launched yet.

## Shipped foundation

The prototype-to-product foundation is in place:

- Better Auth session guard for every non-auth `/api/*` endpoint.
- Organization-scoped scans, npm connections, GitHub App release targets, and active-org selection.
- Owner/admin/member role gates, organization member rosters, and email-token invitations.
- Encrypted per-organization npm token storage and validation.
- Dynamic Worker sandbox for archive parsing, with `NpmStageGateway` as the credentialed egress boundary.
- Async-capable scan jobs with Queue support, retry classification, and scan lifecycle persistence.
- Scheduled npm staged-publish discovery plus manual “Check npm” discovery.
- Per-organization notification recipients for scan-completion and workflow-gate emails, falling back to the organization owner when unset.
- Persisted scan reports with redacted file summaries, deterministic findings, risk summary, report digest metadata, and decision records.
- Tag-aware npm baseline selection and alternate-version compare cache.
- Security corpus and eval harness for deterministic detection.
- GitHub App foundation for PyPI workflow gates: install/callback, release-target mapping, signed webhook handling, queue-driven review, gate decision callbacks, and workbench controls.
- Test coverage for tenant isolation, sandbox gateway behavior, tar/zip parsing, route auth, queue paths, GitHub webhooks, workflow gates, organization membership, and security corpus rules.

## Current cut line

The app is credible for private-beta hardening, not broad self-serve launch.

The next slice should make review artifacts and operations boring:

1. show report provenance clearly;
2. persist PyPI reviewed artifact digests;
3. validate production Queue/DLQ and hosted GitHub/PyPI paths;
4. add operator-visible metrics/alerts;
5. define retention/deletion behavior for persisted redacted evidence.

## Phase 1 — Report provenance and export

Priority: high.

Goal: make completed reviews durable, understandable, and eventually signable without launching public signed reports yet.

Tasks:

- Surface report digest, report schema version, deterministic rules version, and generated timestamp in scan detail.
- Add a provenance section: package name, staged version, selected baseline, stage ID or workflow gate ID, artifact digests, review limitations, and AI availability/model metadata when applicable.
- Add canonical report JSON export.
- Add digest tests for stable canonical ordering and evidence changes.
- Add human-readable report export, initially HTML.
- Keep public signed report URLs deferred until access controls, revocation semantics, and report payload stability are ready.

Exit criteria:

- A completed scan can be exported and archived.
- A user can verify whether two report artifacts describe the same evidence.
- Reports clearly distinguish deterministic findings from AI commentary and unavailable AI review.

## Phase 2 — Maintainer-grade review UX

Priority: high.

Goal: turn scan detail into a release decision cockpit that helps a maintainer decide whether to manually approve publication.

Tasks:

- Refine top-level recommendation copy with maintainer feedback.
- Improve finding grouping by severity/source while preserving release-delta vs package-context distinction.
- Add dedicated evidence sections for install scripts, entrypoint changes, dependency changes, new binaries/native files, network-capable code, obfuscation, and secret access.
- Render the persisted scan-event lifecycle timeline.
- Add retry failed scan and cancel pending/running scan flows where platform semantics allow it.
- Improve file explorer ergonomics beyond the shipped file filter, changed-files-only default, and lazy previous-file diff.
- Add first-run onboarding around connecting npm, validating access, using “Check npm”, and reading the first report.

Exit criteria:

- A maintainer can understand release risk in under a minute.
- Failure and recovery paths are clear.
- The UI reinforces that approval remains manual outside Drydock.

## Phase 3 — PyPI byte-continuity hardening

Priority: high before broader PyPI use.

Goal: make workflow-gate mode preserve the same invariant as npm mode: the publish job uploads the exact artifacts Drydock reviewed.

Current gap:

- Drydock derives wheel/sdist SHA-256 digests from the GitHub Actions artifact bundle.
- Those digests are not yet persisted into the report payload.
- There is no publish-side digest verification contract today, so byte continuity rests on GitHub artifact immutability plus workflow discipline.

Tasks:

- Persist reviewed wheel/sdist SHA-256 digests in the report payload and scan-detail API.
- Render those digests in the report provenance section.
- Provide a recommended GitHub Actions snippet that verifies reviewed digests immediately before PyPI upload.
- Validate hosted GitHub App installation, webhook delivery, artifact fetch, review, decision callback, and PyPI trusted-publishing upload against a real project.
- Add operator alerts for gate artifact rejection, webhook/callback failures, and notification failures.

Exit criteria:

- A GitHub Actions PyPI publish job waits on Drydock through a GitHub Environment gate.
- Drydock reviews every candidate wheel/sdist and records their SHA-256 digests.
- The publish job verifies and uploads the reviewed wheel/sdist bytes after gate approval.

## Phase 4 — Production operations and retention

Priority: high for private beta.

Goal: make production failures visible and data handling explicit.

Tasks:

- Validate exhausted retryable failures land in the DLQ and are visible to operators.
- Build dashboards/alerts from structured operational events: scan duration, failure rate by safe code, queue retries/exhaustion, staged-publish discovery, notification failures, GitHub webhook failures, workflow-gate callback failures, and AI failures when enabled.
- Add deployment checklist and incident-response notes to existing production docs as production findings are validated.
- Add D1/R2 retention controls for persisted redacted text samples and derived artifacts.
- Decide TTL/eviction expectations for `COMPARE_CACHE`.
- Add scan/report deletion and account/organization data deletion/export workflows.
- Add custom-registry abuse controls before letting arbitrary registries into broad self-serve use.

Exit criteria:

- Operators can tell whether scans, queues, notifications, and workflow gates are healthy without direct database access.
- Retention/deletion behavior is documented and implemented.
- Private-beta incidents have explicit runbooks.

## Phase 5 — R2 derived artifacts

Priority: medium; high before larger reports, exports, or signing.

Goal: keep D1 metadata-focused while preserving useful redacted evidence.

Tasks:

- Add R2 binding and bucket provisioning docs.
- Store derived/redacted artifacts in R2: canonical report JSON, manifest JSON, redacted changed-file samples, and diff JSON.
- Store R2 object references in D1.
- Add retention cleanup that removes both D1 metadata and R2 objects.
- Document object key format, access rules, and expected object sizes.

Exit criteria:

- D1 remains metadata-focused.
- Report artifacts are retrievable for persisted scans.
- Artifact storage follows the no-raw-tarball default.

## Phase 6 — Detection defensibility

Priority: ongoing.

Goal: make security claims measurable and improve detection without weakening sandbox or credential boundaries.

Tasks:

- Expand the golden corpus of malicious, benign, and hard-negative npm/PyPI package patterns.
- Add archive parser fuzzing or property-based tests.
- Add package intelligence signals where they are actionable: new maintainers, package transfer indicators, suspicious dependency additions, binary/native code, minified bundles, and external endpoints.
- Add OpenSSF/package reputation integrations only if they produce concrete release-review signal.
- Add incident-response playbooks for credential exposure, false negatives, false positives, and registry API changes.
- Later, add signed reports and user-signed review decisions.

Exit criteria:

- Detection changes are evaluated before release.
- Security claims are backed by tests, fixtures, and documented limitations.
- Drydock earns trust as a release-security tool, not just a scanner UI.

## Phase 7 — Team and commercial readiness

Priority: medium after private beta proves value.

Goal: support multi-maintainer teams and paid usage without rewriting core ownership boundaries.

Tasks:

- Add multiple npm connections per organization for package/scope segmentation.
- Add per-scan npm connection selection and organization-level defaults.
- Add audit log UI for npm credential events, scan events, report exports, and review decisions.
- Add organization usage, quota, billing, account deletion, and organization deletion/export workflows.
- Add internal operator admin tools for support and abuse response.

Exit criteria:

- Multiple maintainers can collaborate safely in one organization.
- Usage, billing, and audit data are visible to customers and operators.
- Support can diagnose common tenant issues without direct database access.

## Deferred

- Public signed report URLs.
- User-signed review decisions.
- Optional raw tarball retention.
- Multiple AI provider abstraction.
- Deep native/binary malware analysis.
- Automated publish approval. This remains intentionally out of scope.
- Additional ecosystems beyond npm/PyPI until one private-beta path is polished and the workflow-gate byte-continuity contract is proven.

## Suggested next implementation slice

Report/workbench polish plus PyPI digest persistence: render scan-event timeline and report provenance, persist reviewed PyPI artifact digests, and tighten finding grouping around the release decision.
