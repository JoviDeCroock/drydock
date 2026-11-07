# Two-factor authentication

Opt-in TOTP plus single-use backup codes for sign-in, and TOTP step-ups for gate decisions and API-key staged decisions. **Authority:** enforced. **Owner:** `server/lib/auth/index.ts` (Better Auth [`two-factor`](https://www.better-auth.com/docs/plugins/2fa) plugin, `twoFactor({ issuer: "Drydock" })`).

## At a glance

|Thing|Owner file|Who may call / trigger|Pinned by|
|---|---|---|---|
|Enrollment, sign-in challenge|`server/lib/auth/index.ts`; UI `src/pages/Dashboard/Account/TwoFactorSection.tsx`, `src/pages/Auth/Login.tsx`|Any signed-in user with a password|`test/workers/two-factor-routes.test.ts`, `test/e2e/two-factor.spec.ts`|
|Gate decision step-up|`server/routes/github-app/workflow-gates.ts`|Any org member|`test/workers/github-gate-two-factor.test.ts`|
|Org release two-factor policy|`server/routes/organizations.ts`; UI `src/pages/Dashboard/Settings/ReleaseSecuritySection.tsx`|Owner only|`test/workers/organizations-routes.test.ts`, `test/workers/organizations-release-two-factor.test.ts`|
|First password for GitHub-only|`src/pages/Dashboard/Account/SetPasswordPrompt.tsx`; flow in [security model](./security-model.md#password-reset)|Account's own session, verified address|`test/workers/password-reset.test.ts`|
|Client model|`src/models/auth.ts` (`signIn` → `{ twoFactorRequired }`, `completeTwoFactorSignIn`), `src/models/two-factor.ts`|—|—|

## Contract

### Endpoints

All Better Auth endpoints under `/api/auth`, handled by `auth.handler`:

|Method|Path|Purpose|Auth|
|---|---|---|---|
|POST|`/api/auth/two-factor/enable`|Begin enrollment; returns `totpURI` + `backupCodes`|Session + password|
|POST|`/api/auth/two-factor/verify-totp`|Confirm enrollment or pass sign-in challenge|Session or pending 2FA|
|POST|`/api/auth/two-factor/verify-backup-code`|Pass sign-in challenge with a recovery code|Pending 2FA|
|POST|`/api/auth/two-factor/disable`|Turn off 2FA|Session + password|
|POST|`/api/auth/two-factor/generate-backup-codes`|Issue a fresh set of recovery codes|Session + password|

Drydock routes that use the factor:

|Method|Path|Role|Step-up rule|
|---|---|---|---|
|POST|`/api/v1/github-app/workflow-gates/:gateId/decision`|Any member|[Gate decision](#gate-decision-step-up)|
|POST|`/api/v1/scans/:id/decision`|`decide_staged` API key|Fresh creator TOTP every decision; staged npm outside every gate only ([API keys](./api-keys.md#recording-staged-decisions))|
|PUT|`/api/v1/organizations/:id/release-two-factor`|Owner|[Org policy](#organization-policy)|

### Enrollment

1. `POST /api/auth/two-factor/enable` with the current password returns `totpURI` and freshly generated `backupCodes` (plugin default: 10 single-use codes).
2. The UI renders `totpURI` as a QR code (PNG data URL via `qrcode`) plus the base32 secret for manual entry. `appName`/`issuer` "Drydock" is the label authenticator apps show.
3. A 6-digit code to `POST /api/auth/two-factor/verify-totp` finalizes enrollment and sets `user.twoFactorEnabled`.
4. Backup codes are shown once behind an "I've saved these codes" confirmation, with a `.txt` download. The dialog cannot be dismissed at this step until confirmed, because 2FA is already on and the codes are never shown again.

### Sign-in challenge

1. For an enrolled user, `POST /api/auth/sign-in/email` returns `{ twoFactorRedirect: true }` instead of a session.
2. The "Verify it's you" step accepts a TOTP (`verify-totp`) or a backup code (`verify-backup-code`). Only then is the full session cookie set.
3. The challenge guards password sign-ins only. GitHub sign-in is authenticated by GitHub, including GitHub's own 2FA ([self-hosting](./self-hosting.md)). The gate step-up applies regardless of how the session was created.
4. All account linking is disabled: a social sign-in can never attach to an existing password account, implicitly or through Better Auth's link endpoint, so it cannot skip an enrolled TOTP challenge.
5. Email verification is a separate axis: it gates actions, not sign-in ([email verification](./security-model.md#email-verification)), so an unverified enrolled user completes TOTP normally; a verification link never signs anyone in.

### Management

|Action|Endpoint|Gate|
|---|---|---|
|Regenerate backup codes|`POST /api/auth/two-factor/generate-backup-codes`|Password|
|Disable 2FA|`POST /api/auth/two-factor/disable`|Password|

**A GitHub-only account sets a password first.** Every two-factor endpoint reauthenticates with a password against the user's `credential` account row, which a GitHub sign-up lacks, so `enable` fails with `INVALID_PASSWORD`. `TwoFactorSection` calls `GET /api/auth/list-accounts` on mount and, with no `credential` row, shows `SetPasswordPrompt`:

1. "Email me a link to set a password" posts the session's own address to `POST /api/auth/request-password-reset`.
2. The link opens `/reset-password`; `POST /api/auth/reset-password` creates the `credential` row (or updates it) and signs out every session.
3. The user signs back in (GitHub or password) and enrolls. After that, a password sign-in meets the TOTP challenge, a GitHub sign-in does not, and the gate step-up applies to both.

|Requirement for a first password|Why|
|---|---|
|Request signed in as the account|An anonymous "Forgot password?" for a GitHub-only address mails nothing, so inbox access alone cannot add a password and skip GitHub's second factor|
|Address already verified|An address GitHub reported unverified gets a "verify first" prompt and no mail|
|Email round-trip|Proves the person owns the address; no route sets a password from a session alone (`setPassword` is server-only)|
|Redeem notice|The owner is mailed "your password was set"|

This needs a deployment that can mail the link (`GET /api/auth/config` → `passwordReset: true`). Where it cannot, the prompt says so, a GitHub-signup member cannot satisfy an org that requires 2FA for release decisions, and a GitHub-signup owner cannot turn that policy on. Do not combine GitHub sign-in with that policy on a deployment without email.

### Gate decision step-up

Approving a gate releases the held Actions job and publishing proceeds over Trusted Publishing/OIDC, which cannot be reversed, so a session alone is not enough for an enrolled maintainer.

|Condition|Response|
|---|---|
|Org policy on, member not enrolled|`403 { code: "two_factor_enrollment_required" }`|
|Enrolled (or policy on), no `totpCode`|`401 { code: "two_factor_required" }`|
|Wrong code|`401 { code: "two_factor_invalid" }`|
|Valid fresh code|Decision proceeds; `github_workflow_gate.approved`/`.rejected` event stamps `twoFactor`, `twoFactorMethod: "totp"`, `twoFactorRequiredByOrg`|
|Not enrolled, policy off|Decides without a code|

1. `userHasTwoFactor` checks enrollment and `verifyTotpStepUp` (both `server/lib/auth/index.ts`) delegates to Better Auth's `verifyTOTP` against the request's session user; app code never decrypts the secret.
2. The step-up runs only after the decision is confirmed actionable, so nobody is prompted for a code on a decision that would `409`.
3. A failed or missing step-up never mutates the gate (it stays `pending`) and never posts to GitHub.
4. Limits: `github-app:gate-decision-2fa:<userId>` 10 per 15 min on top of `github-app:gate-decision:<orgId>` 60/min.
5. The gate's public shape carries `organizationRequiresTwoFactor`; `GateDecisionDialog` shows the code field (or the "enable 2FA in Settings" blocker) to match what the route enforces.
6. A session staged-publish decision (`POST /api/v1/scans/:id/decision`, batch `POST /api/v1/scans/batch-approval`) is an advisory audit record; it never publishes or cancels on npm and has no step-up. Neither form accepts a workflow-gate package: the route answers `409` ("decide a gated release on its workflow gate"), so gate package verdicts come only from the gate route with its step-up.
7. A `decide_staged` key records that same staged decision for `drydock approve`, but needs fresh creator TOTP on every decision; only an enrolled member creates one. Every workflow-gate package is refused (`server/routes/scans/decisions.ts`; [API keys](./api-keys.md#recording-staged-decisions)).

Staged-publish decision UI (no step-up bearing):

|Element|Contract|
|---|---|
|"Open npm" checkbox|Opens npm's staged-packages page with `filterPackage` set; sticky per browser (`drydock:open-npm-after-decision`, `src/models/publish-preferences.ts`); no server state|
|`StageCommandDialog`|When the npm tab is not opened (checkbox off or popup blocked), shows `npm stage approve\|reject <stage-id>` from `src/lib/npm-stage-command.ts` as copyable text|
|Stage id|Validated against npm's stage-id shape before it enters the string, so registry text cannot inject shell metacharacters|
|Authority|Display only: The browser UI never runs npm; npm still asks the maintainer for its own 2FA|

### Organization policy

`organizations.require_two_factor_for_release_decisions` (Settings → General → Release security) makes the gate step-up mandatory for every member; checked by `organizationRequiresTwoFactorForReleaseDecisions` (`server/db/organizations.ts`).

|Request to `PUT /api/v1/organizations/:id/release-two-factor`|Response|
|---|---|
|Caller is not the owner (admin, member, stranger)|`404`|
|`enabled` not a boolean|`400`|
|Over `organizations:release-two-factor:<userId>` (30/hour)|`429`|
|Owner not enrolled (either direction)|`403 { code: "two_factor_enrollment_required" }`|
|Enable|Allowed with enrollment alone|
|Disable without `totpCode`|`401 { code: "two_factor_required" }`; policy untouched|
|Disable with wrong code|`401 { code: "two_factor_invalid" }`; policy untouched|
|Disable with valid code|Policy off|

1. Owner-only so an admin cannot weaken a gate the owner hardened.
2. An owner cannot mandate a control they have not adopted (it would also lock them out of their own decisions).
3. `organization.release_two_factor_changed` records `enabled` plus `twoFactor`/`twoFactorMethod`; the step-up is recorded only on a relax, the weakening direction.
4. `ReleaseSecuritySection` blocks an unenrolled owner with an enroll link and asks for a code before relaxing.

### Data model

`server/db/schema.ts`; migrations come from `pnpm db:generate` (`drizzle/0016_lovely_madrox.sql`), never hand-written.

|Column / table|Type|Meaning|
|---|---|---|
|`user.two_factor_enabled`|integer, boolean mode, nullable|True once TOTP enrollment is verified|
|`organizations.require_two_factor_for_release_decisions`|integer, boolean mode, not null, default false|Org policy above|
|`two_factor.id`|text, PK|—|
|`two_factor.secret`|text|Encrypted by Better Auth, never raw base32|
|`two_factor.backup_codes`|text|Encrypted by Better Auth|
|`two_factor.verified`|integer, boolean mode|True after first TOTP verification; plugin requires it|
|`two_factor.user_id`|text, FK → `user.id`, `ON DELETE CASCADE`|One row per enrolled user|

## Invariants

1. Everything under `/api/auth/two-factor` shares the per-IP `two-factor` bucket, 10 per 15 minutes (`authIpLimit` in `server/middleware/auth-rate-limit.ts`); the 11th returns `429`. It is counted in D1 behind a native per-minute burst guard ([rate limiting](./security-model.md#rate-limiting)). The origin/CSRF check covers these POSTs.
2. `userHasTwoFactor`, the org policy, the encrypted TOTP secret, and membership/role are D1 reads on every request, so enrolling, un-enrolling, or changing policy takes effect immediately.
3. The session a step-up runs against may come from the cookie cache, so a session revoked in the last few minutes can still complete a step-up ([session posture](./security-model.md#session-posture)).
4. A password reset does not remove an enrolled second factor.

## Tests

|Test|Pins|
|---|---|
|`test/workers/two-factor-routes.test.ts`|Real Better Auth handler: enroll, verify TOTP, `twoFactorEnabled`, `twoFactorRedirect`, backup-code sign-in, disable, rate-limit bucket (30 s timeout for scrypt; see [tooling](./tooling.md))|
|`test/e2e/two-factor.spec.ts`|Register, enable in Account settings (TOTP via `otpauth`), sign out, sign in through the challenge|
|`test/workers/github-gate-two-factor.test.ts`|No code / wrong code keep the gate `pending` and post nothing; fresh code posts once; unenrolled decides freely; org policy blocks unenrolled and still needs a code from enrolled|
|`test/workers/organizations-routes.test.ts`|Policy toggle: admin/stranger `404`, non-boolean `400`, unenrolled owner blocked, enrolled owner enables without code, relax without code stops at `two_factor_required`|
|`test/workers/organizations-release-two-factor.test.ts`|Enrolled owner enables without a code and relaxes with one; missing/wrong code and unenrolled owner never change the policy|
|`test/workers/password-reset.test.ts`|GitHub-only first password (own session only, verified only), `credential` row created, sessions deleted, notice mailed, enrollment works; redeem verifies address; 3 mails/hour per address; no `/api/auth/set-password`; URL-borne tokens refused; reset keeps 2FA; expired link fails|

## Change checklist

- Changing a step-up code path → update the response tables above and run `test/workers/github-gate-two-factor.test.ts` and `test/workers/organizations-release-two-factor.test.ts`.
- Adding another release-authorizing action → decide its step-up explicitly and add a row to the Drydock routes table.
- Changing the `two_factor` schema → `pnpm db:generate`, never hand-written SQL.
