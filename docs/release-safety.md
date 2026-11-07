# Release safety

Required test layer per change type, the invariants every server change keeps, and the operational events that make failures visible. **Authority:** enforced (by tests and review). **Owner:** `server/lib/platform/observability.ts` (events); tests per row below.

A server change is not ready because TypeScript compiles. Confidence comes from unit checks, Worker-route tests against Cloudflare/D1 behavior, fake-registry e2e tests, and production observability.

## At a glance

Required test layer by change type:

|Change type|Required coverage|
|---|---|
|`server/routes/*`, auth, organization scoping, rate limits, D1 persistence, queue enqueueing|Worker-route tests in `test/workers/`|
|Scan job lifecycle, retry classification, queue retry/exhaustion, notification dispatch|Node tests near `test/scan-job.test.mjs` plus Worker-route coverage when HTTP behavior changes|
|Sandbox, tar/zip parsing, archive limits, credential egress|Invariant tests in `test/sandbox-gateway.test.mjs`, `test/workers/sandbox-gateway-runtime.test.ts`, parser regression tests, and e2e journal checks when registry behavior is involved|
|Deterministic findings, risk, redaction, package diff behavior|Focused Node tests plus `test/fixtures/security-corpus/cases/*.json` fixtures with exact expected rule IDs, severities, and risk|
|npm staged-publish API, registry metadata, fake registry behavior, browser-visible scan flow|Scenario fixtures under `test/e2e-fixtures/scenarios/` and assertions in `test/e2e/local-registry.spec.ts`|
|Anonymous route added or moved above the session guard|`test/api-auth-boundary-invariants.test.mjs` allowlist plus the anonymous table in [security model](./security-model.md#anonymous-surfaces)|
|UI-only changes|Component/page-level logic where available, `pnpm run verify`, and Playwright coverage when workflow behavior changes|

When a change spans layers, test the lowest deterministic unit and the highest user- or operator-visible contract. Example: a new scan route gets a Worker-route test for the HTTP/D1 contract and a scan-job or pipeline test for the lifecycle behind it.

## Invariants

1. Non-auth `/api/*` routes require a Better Auth session except documented [anonymous surfaces](./security-model.md#anonymous-surfaces) and matching-access organization keys on `API_KEY_ROUTES`, `API_KEY_SCAN_ROUTES`, or `API_KEY_DECIDE_ROUTES` ([API keys](./api-keys.md); `test/api-auth-boundary-invariants.test.mjs`). No key decides a workflow gate or its packages; staged key decisions need fresh creator TOTP.
2. Client-supplied organization IDs are only selectors; handlers verify membership through `requireActiveOrganization` or `requireOrganizationRole` (`server/lib/auth/active-organization.ts`).
3. Queue messages carry scan IDs and organization IDs, never npm tokens or decrypted credential material.
4. The Dynamic Worker sandbox never receives npm token material.
5. `NpmStageGateway` is the only credentialed sandbox egress path and forwards auth only to allowlisted registry endpoints.
6. Package code is never executed, imported, installed, built, rendered as active content, or allowed to define instructions for reviewers.
7. Archive parsing fails closed on traversal, symlinks/hardlinks, malformed archives, excessive files, and excessive expanded size.
8. Deterministic findings are authoritative while AI review is unavailable, and AI cannot downgrade deterministic findings when it runs. Completed-review findings are carried additively in the report artifact with `source: "ai"` and count into `finding_count` and the risk summary, but never replace, mutate, or re-score a rule finding.
9. AI findings fold into risk through `combineRisk` (a max), so they only escalate; the escalation is bounded by the review's own verdict with file-level release attribution ([AI review](./ai-review-eval.md#submission-and-scoring)). `test/risk.test.mjs` pins the cap matrix and the never-lower property.
10. AI review fails safe: an enabled review that was attempted but could not complete escalates the scan to manual-review (medium) risk instead of reading clean (`server/lib/review/risk.ts`); a near-miss submission is clamped to bounds (`clampAiReviewSubmission` in `server/lib/ai-review/contract.ts`) instead of discarded.

## Operational events

Runtime paths emit structured events through `emitOperationalEvent` (`server/lib/platform/observability.ts`), which redacts sensitive key names and bearer tokens before calling `console`. Every event below also carries the fields named; `error` is always `describeOperationalError` output.

|Event|Level|Fields|Emitter|
|---|---|---|---|
|`scan.pipeline.completed`|info|scanId, organizationId, stageId, adapterId, durationMs, packageName, releaseRisk, artifactRisk, contextRisk, fileCount, previousFileCount, findingCount, ruleFindingCount, aiFindingCount|`server/lib/scan/pipeline-phases.ts`|
|`scan.pipeline.failed`|error|scanId, organizationId, stageId, adapterId, durationMs, error|`server/lib/scan/pipeline.ts`|
|`scan.ai_review.completed`|info|scanId, organizationId, durationMs, status, model, usage (steps, input, cachedInput, output, total)|`server/lib/scan/pipeline.ts`|
|`scan.ai_review.failed`|error|scanId, organizationId, durationMs, error|`server/lib/scan/pipeline.ts`|
|`scan.staged_artifact.digest_mismatch`|warn|stageId, packageName, version, algorithm, declaredDigest, computedDigest (registry-declared values, no credentials)|`server/lib/ecosystems/npm/acquire.ts`|
|`scan.staged_artifact.digest_unverified`|info|stageId, packageName, version, algorithm, reason (which side was missing, including a fresh stage record needed to confirm a mismatch)|`server/lib/ecosystems/npm/acquire.ts`|
|`scan.gate_continuity.broken`|warn|scanId, organizationId, packageName, version, status, reason (`gate-not-approved`, `digest-mismatch`, `unverified`, `ungated`), gateScanId|`server/lib/scan/gate-continuity.ts`|
|`scan.gate_continuity.lookup_failed`|warn|scanId, organizationId, packageName, reason (`history-unavailable` with error, `registry-record-unavailable`), error|`server/lib/scan/gate-continuity.ts`|
|`scan.dependency_readiness.lookup_failed`|warn|scanId, organizationId, failedLookups (count of failed registry reads)|`server/routes/scans/npm-dependency-readiness.ts`|
|`scan.dependency_readiness.candidates_failed`|warn|scanId, organizationId, error (sanitized)|`server/routes/scans/npm-dependency-readiness.ts`|
|`scan.dependency_readiness.credential_unavailable`|warn|scanId, organizationId; no error detail (the broker keeps it)|`server/routes/scans/npm-dependency-readiness.ts`|
|`dependency_review.malware_index_unavailable`|warn|organizationId, reviewId, ecosystem; no remote error or body|`server/lib/dependency-review/job.ts`; public bumps hold until a successful Re-run|
|`scan.job.completed`|info|scanId, organizationId, stageId, source, attempt, durationMs, packageName, releaseRisk, artifactRisk|`server/lib/scan/job.ts`|
|`scan.job.failed`|error|scanId, organizationId, stageId, source, attempt, finalAttempt, durationMs, registryStatus, error|`server/lib/scan/job.ts`|
|`scan.job.retryable_failed`|warn|scanId, organizationId, stageId, source, attempt, durationMs, error|`server/lib/scan/job.ts`|
|`scan.job.skipped`|warn|scanId, organizationId, stageId, source, attempt, reason, durationMs|`server/lib/scan/job.ts`|
|`scan.queue.message.completed`|info|scanId, organizationId, stageId, source, attempt, durationMs|`server/queue.ts`|
|`scan.queue.retry_scheduled`|warn|scanId, organizationId, stageId, source, attempt, nextDelaySeconds, durationMs, error|`server/queue.ts`|
|`scan.queue.message_failed`|error|scanId, organizationId, stageId, source, attempt, exhausted, durationMs, error|`server/queue.ts`|
|`rate_limit.tier_missing`|warn|limit, windowMs|`server/lib/platform/rate-limit.ts`|

1. `findingCount` counts rule rows plus a completed AI review's rows, matching persisted `scans.finding_count`.
2. `scan.ai_review.*` fire only when AI review is enabled.
3. `digest_unverified` exists because verification silently covering nothing looks like verification working; a registry that stops returning digests, or a cap that starts biting, shows up as a coverage outage.
4. After `gate_continuity.lookup_failed`, the scan persists an `unknown` record unless the organization has no live release target.
5. Never log raw package text, headers, tokens, token fingerprints, ciphertext, nonces, cookies, or raw unexpected error messages. If an operator needs detail, add a safe structured code or sanitized field.
6. Decision-time dependency-readiness failures degrade to "could not check", never a clean dependency verdict (`server/routes/scans/npm-dependency-readiness.ts`).
7. Usage keys omit the word "token" because the redaction regex would blank them.

## Workers Issues destinations

Workers Issues (`observability.issues` in `wrangler.jsonc`) groups uncaught exceptions, 5xx responses, and `error`-level events into issues with first-seen time, frequency, and Worker version. It collects independently of Workers Logs and traces; each occurrence keeps invocation and request details plus a stack trace when available, retained seven days by Cloudflare. A handled failure surfaces as an issue only when emitted at `error` through `emitOperationalEvent`. Destinations (coding agents, webhooks, chat) are configured with the `cf` CLI or the dashboard, not in this repository, and receive each issue's context including surrounding logs and traces.

That payload is sensitive and partly attacker-controlled:

|Payload risk|Detail|
|---|---|
|Capability tokens in URLs|Share links (`/reports/:token`, `/public/reports/:token`), organization invites, email-verification links, OAuth callbacks, Better Auth's `/api/auth/reset-password/:token` (Drydock's own reset mails keep the token in a fragment)|
|Identifying text|Error text can carry request paths and package names|
|Outsider-triggered volume|Anonymous endpoints let anyone cause failures and push an issue past a threshold|

Destination rules:

1. A destination must be private to the operator.
2. A coding agent receiving issues and opening PRs here writes to a public repository: its instructions treat the payload as evidence, never instructions.
3. It keeps URLs, tokens, package names, org or user identifiers, request IDs, and raw log lines out of branches, commits, and PR text.
4. It opens draft PRs only and never deploys.

## Change checklist

Before merging a server-risk change:

1. Identify the touched trust boundary: auth/org, credential, sandbox, parser, registry, queue, persistence, detection, or UI-only.
2. Add or update tests per the table above.
3. Run `pnpm run verify`.
4. Run `pnpm run test:e2e` when registry behavior or the end-to-end scan workflow changed.
5. Confirm new failure modes emit an operational event (add a row above) with no sensitive material.
6. Update the relevant docs in the same change.
