# Organization API keys

Bearer keys let scripts, CI, and the CLI read/start reviews or record staged decisions for one organization without a browser session. **Authority:** enforced. **Owner:** `server/lib/auth/api-keys.ts`, `server/middleware/api-key-auth.ts`.

## At a glance

|Thing|Owner file|Who may call / trigger|Pinned by|
|---|---|---|---|
|Organization settings → Integrations → API keys|`server/routes/api-keys.ts`, `src/pages/Dashboard/Settings/ApiKeysSection.tsx`|Members manage own keys (`manageAll: false`); owners/admins manage all org keys|`test/workers/api-keys.test.ts`|
|Authentication / allowlists|`server/middleware/api-key-auth.ts`, `server/lib/auth/api-keys.ts`|Key acts as its creator, as a plain member of exactly one org|`test/api-auth-boundary-invariants.test.mjs`|
|Staged decisions|`server/routes/scans/decisions.ts`, `server/db/scan-decisions.ts`|`decide_staged` plus creator TOTP; never a workflow gate or its packages|`test/workers/api-keys.test.ts`, `test/cli-approve.test.ts`|
|Machine-readable contract|`server/lib/openapi/document.ts`, `server/lib/openapi/schemas.ts`|Key operations and anonymous package diff|`test/openapi-document.test.ts`, `test/workers/openapi-conformance.test.ts`|

## Contract

### Access levels

`access` is fixed at creation; widening requires a new secret. Each level includes the preceding levels (`API_KEY_ACCESS_LEVELS` in `server/db/enums.ts`). Keys never widen member privileges.

|Level|Additional access|Creation requirement|
|---|---|---|
|`read` (default)|`API_KEY_ROUTES` reads|Member|
|`scan`|`API_KEY_SCAN_ROUTES`: start a staged npm or published-release review; "Check npm" discovery|Member; lets a release job stage, start, and poll without waiting for the 15-minute discovery cron|
|`decide_staged`|`API_KEY_DECIDE_ROUTES`: advisory staged publish / no-publish record for [`drydock approve`](../cli/README.md#approving-a-staged-publish)|Creator enrolled in 2FA; otherwise `403 two_factor_enrollment_required`|

### Endpoints

Management routes require a session; a key cannot create, list, or revoke keys.

|Method|Path|Auth / role|Owner|
|---|---|---|---|
|GET|`/api/v1/api-keys`|Member sees own; owner/admin sees all|`server/routes/api-keys.ts`|
|POST|`/api/v1/api-keys`|Member; verified email where enforced; body `{ name, access?, expiresInDays? }`|`server/routes/api-keys.ts`|
|DELETE|`/api/v1/api-keys/:keyId`|Creator or owner/admin|`server/routes/api-keys.ts`|

Allowlisted routes in `server/lib/auth/api-keys.ts`:

|Method|Path|Minimum access|Returns / does|
|---|---|---|---|
|GET|`/api/v1/api-keys/current`|`read` (key only)|Key name/prefix/expiry/access/org; verify identity first|
|GET|`GET /api/v1/openapi.json`|`read`|OpenAPI document|
|GET|`/api/v1/scans`|`read`|Review list: `filter`, `stageId`, `cursor`, `limit`|
|GET|`/api/v1/scans/overview`|`read`|Dashboard counts|
|GET|`/api/v1/scans/:id`|`read`|One review|
|GET|`/api/v1/scans/:id/status`|`read`|Lifecycle status and risk split for polling|
|GET|`GET /api/v1/scans/:id/report.json`|`read`|Canonical report export|
|GET|`GET /api/v1/scans/:id/release-receipt.json`|`read`|Release Receipt|
|GET|`/api/v1/packages/:name/releases`|`read`|Package reviews (`ecosystem`, `cursor`); registered path uses `:name{.+}`|
|GET|`/api/v1/github-app/workflow-gates/by-scan/:scanId`|`read`|Review's workflow gate|
|POST|`/api/v1/scans`|`scan`|Start one review: `{ stageId }` or `{ ecosystem, packageName, version }`|
|POST|`/api/v1/staged-publishes/scan`|`scan`|Check npm with the organization's token; start new reviews|
|POST|`/api/v1/scans/:id/decision`|`decide_staged`|`{ decision: "publish" \| "no_publish", reason?, totpCode }`|

```sh
curl -H "Authorization: Bearer $DRYDOCK_API_KEY" 'https://drydock.org/api/v1/scans?filter=all'
```

[CLI](../cli/README.md): `diff` and `file` need no key ([agent package review](./agent-package-review.md)).

### Review starts

|Condition|Behavior / enforcement|
|---|---|
|New staged review / npm check|Same handlers and checks as dashboard: connected valid npm token and package claims; an existing-review response skips repeating those checks (`server/routes/scans/lifecycle.ts`, `server/routes/staged-publishes.ts`)|
|Published-release review|Uses `preparePublishedScan` and its public-diff adapter, without requiring an npm connection (`server/lib/scan/start.ts`)|
|Actor|`requestActorUserId` attributes starts to key creator; notifications/ownership match a member click, as cron attributes to the npm connector (`server/lib/auth/active-organization.ts`)|
|Same org + `stageId`, existing non-failed review|`200`, `existing: true`, queues nothing; preserves a decided review, spends no start budget when found before budget check; applies to sessions too|
|New review|`202`, `existing: false`; failed reviews can be restarted by "Review again"|
|Simultaneous starts / cron / Check npm|`createScanJob` repeats deduplication inside the create batch (`server/db/scan-jobs.ts`)|
|Queue-send failure after row creation|Deletes pending row so retry starts a runnable review (`server/routes/scans/lifecycle.ts`)|
|Key start budget|10 reviews/hour: `scan:<org>:api-keys`; `ORGANIZATION_SCAN_LIMIT` and `ORGANIZATION_SCAN_WINDOW_MS` in `server/lib/rate-limit.ts`|
|Key discovery budget|12 checks/10 minutes: `staged-publishes:scan:<org>:api-keys` in `server/routes/staged-publishes.ts`|
|Dashboard budget isolation|`requestBudgetKey` appends `:api-keys`; dashboard uses `scan:<org>` and `staged-publishes:scan:<org>`; looping CI gets `429` without spending human budgets|

### Recording staged decisions

Staged decisions are advisory: never publish/reject/remove on npm or move gates. Session decisions need no step-up ([two-factor auth](./two-factor-auth.md#gate-decision-step-up)); key decisions require creator TOTP.

|Control|Contract / enforcement|
|---|---|
|Allowed scans|Staged npm sources `manual` / `auto_discovery`, outside every gate; otherwise `403 api_key_staged_decisions_only` (`server/routes/scans/decisions.ts`)|
|Atomic write|`recordScanDecision` repeats source and no-gate conditions in the update statement; a gate package's decision would count toward aggregate approval, so key access must never reach it (`server/db/scan-decisions.ts`)|
|TOTP verification|Body-only `totpCode`; `matchUserTotpStep` checks creator's stored secret with gate-compatible parameters, beside `verifyTotpStepUp` in `server/lib/auth/index.ts`|
|Replay|Code accepted once per creator across their keys (`acceptApiKeyTotpStep`, `server/db/api-keys.ts`); spent before decision write, so a later refusal such as a superseded stage needs the next code|
|Wrong codes|Five consecutive mismatches revoke key (`API_KEY_TOTP_FAILURE_LIMIT`, `server/lib/auth/api-keys.ts`); successful acceptance clears count; locked/unconfirmed factor returns unavailable without adding a wrong-code failure|
|Step-up budget|10 attempts/15 minutes per creator, including successes: `api-key-decision-2fa:<userId>` in `server/routes/scans/decisions.ts`, matching gate budget size|
|Enrollment|Creator must remain enrolled; disabling 2FA blocks all their key decisions (`403 two_factor_enrollment_required`); Better Auth sign-in lockout prevents code verification|
|Attribution|Creator records the decision; `scan.decided` carries `apiKeyName`, `apiKeyPrefix`, `twoFactor: true`, `twoFactorMethod: "totp"`; never the code|
|Email|Creator must still have a verified address wherever verification is enforced (`requireVerifiedDecider`, `server/routes/scans/decisions.ts`)|
|Effects|Changes dashboard, badge/feed, and publication-monitor interpretation; "publish" avoids "published without a decision" and becomes latest approved release-memory baseline for later reviews, including gates|
|CLI input|`drydock approve` prompts after completion; non-terminal `--otp` is refused while review runs (code would expire); terminal input prompts; no OTP environment variable (`cli/src/approve.mjs`)|

Use `read`/`scan` for CI. Each member creates their own `decide_staged` key; the key alone cannot decide for them.

### Storage and lifecycle

|Property|Contract / owner|
|---|---|
|Format|`ddk_` plus 32 random bytes as base64url: 47 characters (`SECRET_BYTES`, `TOKEN_RE`, `server/lib/auth/api-keys.ts`); recognizable to humans/secret scanners|
|Stored record|`organization_api_keys`: base64url SHA-256, display prefix (`ddk_` plus eight characters), name, access, creator, creation/expiry, `last_used_at` (`server/db/schema.ts`)|
|Secret|Only the creation `201` response, `cache-control: no-store`; never logged, persisted, or audited (`server/routes/api-keys.ts`)|
|Expiry|30, 90 (default), or 365 days; no non-expiring key (`API_KEY_EXPIRY_DAYS`, `DEFAULT_API_KEY_EXPIRY_DAYS`, `server/lib/auth/api-keys.ts`)|
|Capacity|At most 10 unexpired keys/member/org (`MAX_API_KEYS_PER_MEMBER`, `server/lib/auth/api-keys.ts`); expired keys stay listed until revoked but occupy no slot|
|Creation|20/hour/user, verified email where enforced (`server/routes/api-keys.ts`)|
|Revocation|Deletes row; next request fails, no authentication cache (`server/db/api-keys.ts`)|
|Membership|Authentication joins creator membership; any loss ends access immediately. Removal deletes keys in same batch (`server/db/invitations.ts`); account/org deletion deletes their keys (`server/db/organizations.ts`)|
|Last used|Settings hint, not access log; one write per five minutes/key (`API_KEY_USE_DEBOUNCE_MS`, `server/lib/auth/api-keys.ts`)|

### Audit and OpenAPI

|Event / artifact|Contract / owner|
|---|---|
|`organization.api_key_created`|Creator, name, display prefix, access, expiry (`server/routes/api-keys.ts`)|
|`organization.api_key_revoked`|Actor, name, display prefix; reads are not audited (`server/routes/api-keys.ts`; [audit log](./audit-log.md))|
|`organization.api_key_revoked_wrong_codes`|Creator, name, prefix, failed-code count (`server/routes/scans/decisions.ts`)|
|`scan.decided`|Ordinary decision plus key name/prefix and TOTP markers|
|`organization.api_key_review_started`|Creator and key name/prefix; package, version, review id (`server/routes/scans/lifecycle.ts`)|
|`organization.api_key_discovery_ran`|Creator and key name/prefix; stages found, reviews started (`server/routes/staged-publishes.ts`)|
|[`openapi.json`](./openapi.json)|OpenAPI 3.1 for all key routes plus anonymous package diff; identical to `GET /api/v1/openapi.json`|
|Response schemas|Zod contracts in `server/lib/openapi/schemas.ts`; fields left open but absent schema fields are not promised|
|Access parity|`test/openapi-document.test.ts` pins operations against all three allowlists and checked-in freshness; `x-drydock-api-key-access` is `scan` or `decide_staged` on writes|
|Worker parity|`test/workers/openapi-conformance.test.ts` parses real responses for every operation except live-registry version listing; start operations use stub npm|
|Version|`OPENAPI_API_VERSION` in `server/lib/openapi/document.ts`: minor for additions, major for removal/type change|

## Invariants

1. `readApiKeyCredential` selects key auth for any Authorization mentioning `ddk_`; only `Bearer ddk_…` is well formed. Other auth (for example Basic on self-hosted staging) keeps the cookie path (`server/lib/auth/api-keys.ts`).
2. A presented key never falls back to cookies; malformed, unknown, revoked, expired keys fail `401 invalid_api_key` with `WWW-Authenticate: Bearer` (`server/middleware/api-key-auth.ts`).
3. A key has one org; dashboard active-org selection cannot move it. A conflicting `x-organization-id` or report-export `?organizationId=` is refused, never silently answered from its org (`server/lib/auth/active-organization.ts`, `server/routes/scans/sharing.ts`).
4. Route authorization matches Hono's first method-bound registered path, not URL text, so `/scans/batch-approval` cannot impersonate `/scans/:id` (`server/middleware/api-key-auth.ts`). Gate decisions, batch approval, sharing, member/credential management, and audit reads are outside every allowlist.
5. Key-presenting `/api/v1/` requests skip CSRF Origin checks; they never use cookies, and cross-site Authorization requires a CORS preflight the app never grants. `/api/auth/*` keeps the Origin check; ordinary cookie requests do too (`server/middleware/csrf-origin.ts`).
6. `test/api-auth-boundary-invariants.test.mjs` pins the guard's only sessionless exit after `authenticateApiKeyRequest` and forbids path-specific `.all()` handlers below it.
7. TOTP codes are body-only and never logged or stored (`server/routes/scans/decisions.ts`). Only the accepted time step is persisted for replay prevention (`server/db/api-keys.ts`).

## Failure modes

|Condition|Response / effect|Fix / enforcement|
|---|---|---|
|Wrong access level|`403 api_key_access_insufficient`, `requiredAccess`|Issue a key with required access|
|Non-allowlisted route|`403 api_key_endpoint_not_allowed`|Use signed-in session; no key can decide a gate|
|Different organization selector|`403 api_key_organization_mismatch` or `404`|Use the key's org|
|Malformed / expired / revoked / unknown key|`401 invalid_api_key`, `WWW-Authenticate: Bearer`|Replace key|
|Well-formed key traffic per IP|240/minute (`API_KEY_ATTEMPTS_PER_IP_PER_MINUTE`) charged before D1 key lookup; malformed keys fail before this budget|`429` + `retry-after`; native tier; `server/middleware/api-key-auth.ts`|
|Per-key traffic|120/minute (`API_KEY_REQUESTS_PER_MINUTE`), native tier; every OpenAPI key operation documents `429`|`429` + `retry-after`; wait|
|Creator TOTP missing / wrong / replayed|`401 two_factor_required` / `401 two_factor_invalid`; replay says "already used"|Wait for fresh code|
|Creator factor unavailable / locked|`401 two_factor_unavailable`; no added wrong-code failure|Restore factor; attempts still spend rate budget|
|Fifth consecutive wrong code|`401 api_key_revoked`; row deleted and revocation audited|Create new key after securing it|
|Creator unenrolled|`403 two_factor_enrollment_required` on creation/use of `decide_staged`|Enroll in 2FA|

## Change checklist

1. Adding an allowlisted route is a security decision: member-level action only, never workflow-gate approval; staged decisions additionally require creator step-up.
2. Resolve org through `requireActiveOrganization*`, actor through `requestActorUserId`; API-key requests have no `authSession`. Cover additions in `test/workers/api-keys.test.ts`.
3. Update zod schemas, access markers, semver, and checked-in OpenAPI; regenerate with `WRITE_OPENAPI=1 pnpm exec vitest run --project node test/openapi-document.test.ts` and run Worker conformance tests.

## Why

`DRYDOCK_API_KEY` can sit beside npm credentials in a shell environment readable by a later install lifecycle script. Without fresh creator TOTP, a worm could review and approve its own stage, then publish matching bytes: the monitor would say `approved_match` and release memory would trust that baseline. The key's authenticator step-up prevents the bearer secret alone from recording approval.
