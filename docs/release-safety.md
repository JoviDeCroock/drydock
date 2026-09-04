# Release safety

Drydock is a security-grade service, so confidence comes from layered evidence:
small unit checks, Worker-route tests that exercise Cloudflare/D1 behavior,
fake-registry e2e tests, and production observability. A server change is not
ready just because TypeScript compiles.

## Required test layer by change type

| Change type                                                                                  | Required coverage                                                                                                                                                                                     |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server/routes/*`, auth, organization scoping, rate limits, D1 persistence, queue enqueueing | Worker-route tests in `test/workers/`                                                                                                                                                                 |
| Scan job lifecycle, retry classification, queue retry/exhaustion, notification dispatch      | Node tests near `test/scan-job.test.mjs` plus Worker-route coverage when HTTP behavior changes                                                                                                        |
| Sandbox, tar/zip parsing, archive limits, credential egress                                  | Invariant tests in `test/sandbox-gateway.test.mjs`, `test/workers/sandbox-gateway-runtime.test.ts`, parser regression tests, and e2e journal checks when registry behavior is involved                |
| Deterministic findings, risk, redaction, package diff behavior                               | Focused Node tests plus `test/fixtures/security-corpus/cases/*.json` fixtures with exact expected rule IDs, severities, and risk                                                                      |
| Dependency-artifact review (selection, resolution, deterministic scanning, coverage gaps)    | Focused Node tests plus `test/fixtures/security-corpus/cases/dependency-artifact-*.json`, eval/frontier coverage, and the fake-registry journal assertion for credential-free public-registry fetches |
| npm staged-publish API, registry metadata, fake registry behavior, browser-visible scan flow | Scenario fixtures under `test/e2e-fixtures/scenarios/` and assertions in `test/e2e/local-registry.spec.ts`                                                                                            |
| UI-only changes                                                                              | Component/page-level logic where available, `pnpm run verify`, and Playwright coverage when workflow behavior changes                                                                                 |

When a change spans layers, test the lowest deterministic unit and the highest
user- or operator-visible contract. For example, a new scan route should usually
have a Worker-route test for the HTTP/D1 contract and a scan-job or pipeline test
for the lifecycle behavior behind it.

## Non-negotiable invariants

- Every non-auth `/api/*` route requires a Better Auth session.
- Client-supplied organization IDs are only selectors; route handlers must verify
  membership through `requireActiveOrganization`.
- Queue messages carry scan IDs and organization IDs, not npm tokens or decrypted
  credential material.
- The Dynamic Worker sandbox never receives npm token material.
- `NpmStageGateway` is the only credentialed sandbox egress path and only forwards
  auth to allowlisted registry endpoints.
- Dependency-artifact fetches carry no credential at all. A dependency an
  anonymous request cannot reach is recorded as an uninspected coverage gap,
  never retried with the organization's npm token.
- Package code is never executed, imported, installed, built, rendered as active
  content, or allowed to define instructions for reviewers.
- Archive parsing fails closed on traversal, symlinks/hardlinks, malformed
  archives, excessive files, and excessive expanded size.
- Deterministic findings are authoritative while AI review is unavailable, and AI
  cannot downgrade deterministic findings when it runs. A completed review's
  findings are carried additively in the report artifact with `source: "ai"` (and
  count into `finding_count` / the risk summary), but they never replace, mutate,
  or re-score a rule finding, and they fold into risk through `combineRisk` — a
  max — so they can only escalate.
- AI review fails safe: an enabled review that was attempted but could not complete
  escalates the scan to manual-review risk rather than reading as clean, and a
  near-miss submission is clamped to bounds instead of discarded. See
  [`docs/security-model.md`](security-model.md).

## Operational observability

Runtime paths should emit structured events through
`server/lib/platform/observability.ts`. The helper redacts sensitive key names and bearer
tokens before calling `console`, which keeps Cloudflare logs useful without
turning them into a credential sink.

Current structured events cover:

- `scan.pipeline.completed` / `scan.pipeline.failed` with adapter, duration,
  file counts, finding count, and risk. `findingCount` counts rule rows plus a
  completed AI review's rows (matching persisted `scans.finding_count`), with
  `ruleFindingCount` / `aiFindingCount` emitted alongside for the split.
- `scan.ai_review.completed` / `scan.ai_review.failed` when AI review is enabled.
- `scan.staged_artifact.digest_mismatch` when a staged npm tarball's bytes do not
  hash to the digest the registry recorded for the stage (stage id, package,
  version, and both digests — all registry-declared values, no credentials).
- `scan.staged_artifact.digest_unverified` when a scan could not be bound to the
  registry's record at all (stage id, package, version, and which side was
  missing, including a fresh stage record needed to confirm a mismatch).
  Verification silently covering nothing looks exactly like
  verification working, so a registry that stops returning digests — or a cap
  that starts biting — is visible as a coverage outage rather than silence.
- `scan.job.completed`, `scan.job.failed`, `scan.job.retryable_failed`, and
  `scan.job.skipped` with scan ID, organization ID, source, attempt, duration,
  and safe error code.
- `scan.queue.message.completed`, `scan.queue.retry_scheduled`, and
  `scan.queue.message_failed` with attempt, delay/exhaustion, duration, and safe
  error code.

Do not log raw package text, headers, tokens, token fingerprints, ciphertext,
nonces, cookies, or raw unexpected error messages. If an operator needs detail,
add a safe structured code or sanitized metadata field instead.

## Release checklist

Before merging server-risk changes:

1. Identify the touched trust boundary: auth/org, credential, sandbox, parser,
   registry, queue, persistence, detection, or UI-only.
2. Add or update tests in the table above.
3. Run `pnpm run verify`.
4. Run `pnpm run test:e2e` when registry behavior or end-to-end scan workflow
   changed.
5. Confirm operational events exist for new failure modes and do not include
   sensitive material.
6. Update the relevant docs in the same change.
