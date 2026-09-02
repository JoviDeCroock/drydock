# Two-factor authentication

Drydock supports opt-in two-factor authentication (2FA) using TOTP (time-based one-time
passwords from an authenticator app) plus single-use backup recovery codes. It is built on
Better Auth's first-party [`two-factor`](https://www.better-auth.com/docs/plugins/2fa) plugin,
registered in `server/lib/auth/index.ts`:

```ts
plugins: [twoFactor({ issuer: "Drydock" })];
```

The `issuer` (and `appName: "Drydock"`) is the label authenticator apps display next to the
account. Backup codes use the plugin default: 10 single-use codes.

## User flows

### Enrollment (Account settings)

`src/pages/Dashboard/Account/TwoFactorSection.tsx` drives a dialog:

1. Confirm the current password (`POST /api/auth/two-factor/enable`). The response carries the
   `totpURI` and the freshly generated `backupCodes`.
2. The UI renders the `totpURI` as a QR code (PNG data-URL via `qrcode`) plus the raw base32
   secret as copyable text for manual entry. The user scans it and submits a 6-digit code
   (`POST /api/auth/two-factor/verify-totp`), which finalizes enrollment and flips
   `user.twoFactorEnabled` to `true`.
3. The backup codes are shown once behind an "I've saved these codes" confirmation, with a
   download-to-`.txt` option. The setup dialog cannot be dismissed from this step until that
   confirmation is checked, because 2FA is already enabled and these recovery codes are not shown
   again.

### Sign-in challenge

When an enrolled user signs in, `POST /api/auth/sign-in/email` returns
`{ twoFactorRedirect: true }` instead of an authenticated session. `src/pages/Auth/Login.tsx`
swaps to a "Verify it's you" step that accepts either:

- a TOTP code → `POST /api/auth/two-factor/verify-totp`, or
- a backup recovery code → `POST /api/auth/two-factor/verify-backup-code`.

The challenge guards password sign-ins. GitHub sign-in (when the operator
configures it, see [`self-hosting.md`](./self-hosting.md)) is authenticated by
GitHub itself, including any 2FA on the GitHub account; the release-decision
TOTP step-up below applies regardless of how the session was created. To keep
this split safe, all account linking is disabled: a social sign-in can never
attach to an existing password account, implicitly or through Better Auth's
link endpoint, so it cannot be used to skip an enrolled TOTP challenge. A
GitHub-only account cannot enrol in Drydock two-factor at all — see
[Management](#management) for why, and for what that costs an organization that
mandates it.

Email verification is a separate axis and never part of this challenge: it gates
individual actions rather than sign-in (see
[`security-model.md`](./security-model.md#email-verification)), so an enrolled
user with an unverified address still completes the TOTP step normally.

Only after the second factor succeeds is a full session cookie set. The client model logic lives
in `src/models/auth.ts` (`signIn` returns `{ twoFactorRequired }`; `completeTwoFactorSignIn`)
and `src/models/two-factor.ts`.

### Management

Enrolled users can regenerate backup codes
(`POST /api/auth/two-factor/generate-backup-codes`, password-gated) or disable 2FA
(`POST /api/auth/two-factor/disable`, password-gated) from Account settings.

**A GitHub-only account cannot enrol.** Every two-factor endpoint reauthenticates
with a password, and Better Auth validates that against the user's `credential`
account row — which an account created by GitHub sign-in does not have, so
`enable` fails with `INVALID_PASSWORD` and there is nothing the user can correct.
Drydock also wires no password-reset email (`emailAndPassword.sendResetPassword`
is unset), so `forget-password` — the one Better Auth path that would mint a
missing `credential` row — is not reachable either. `TwoFactorSection` therefore
asks `GET /api/auth/list-accounts` on mount and, when no `credential` row exists,
replaces the enrol button with an explanation instead of dead-ending on an
uncorrectable password error.

The consequence for the org policy below is real and currently unresolved: a
member who signed up with GitHub is permanently blocked from release decisions in
an organization that requires two-factor for them, and a GitHub-signup owner can
never turn that policy on (enabling it requires the owner's own enrollment).
Offering GitHub sign-in on a deployment that uses the policy needs a way to add a
password to a social account first — a "set a password" flow, or password-reset
email wiring. Until then, treat the two as mutually exclusive.

### Step-up: deciding a workflow gate (issue #162)

Two-factor is also a **step-up** factor for the highest-trust action in the product:
releasing or blocking a held GitHub deployment gate (`POST
/api/v1/github-app/workflow-gates/:gateId/decision`). Approving a gate immediately
releases the held Actions job and publishing proceeds over Trusted Publishing/OIDC,
which cannot be reversed — so an existing session alone is not enough.

When the deciding maintainer has 2FA enabled, the request must carry a **fresh**
`totpCode`. The route checks enrollment with `userHasTwoFactor` and verifies the code
with `verifyTotpStepUp` (both in `server/lib/auth/index.ts`), which delegates to Better
Auth's own `verifyTOTP` so the code is checked against the request's session user and
the encrypted secret is never decrypted in app code. Outcomes:

- no code → `401 { code: "two_factor_required" }`
- wrong code → `401 { code: "two_factor_invalid" }`
- valid code → the decision proceeds and the verified method is stamped on the
  `github_workflow_gate.approved` / `.rejected` scan event (`twoFactor`,
  `twoFactorMethod: "totp"`).

A failed/missing step-up never mutates the gate (it stays `pending`) and never posts
to GitHub. Step-up attempts have their own rate-limit bucket
(`github-app:gate-decision-2fa:<userId>`, 10 per 15 min) on top of the route's
60/min-per-org limit. The dialog (`GateDecisionDialog`) only shows the code field when
the signed-in user has `twoFactorEnabled`.

This is scoped to the approval gate. The **staged-publish** decision (`POST
/api/v1/scans/:id/decision`) is an audit record only — it never publishes or cancels a
release on npm — and intentionally does **not** require a step-up. The decision dialog can open npm's staged-packages page in a new tab with
`filterPackage` set to the reviewed package; the maintainer still approves or declines
in npm with npm's own 2FA. That checkbox is sticky per browser
(`drydock:open-npm-after-decision` in localStorage, `src/models/publish-preferences.ts`)
so reviewers who always finish in npm opt in once — it is a UI convenience with no
server state and no bearing on the step-up rules.
Maintainers without 2FA enabled decide gates without a code, as before.

When that npm tab is _not_ opened (the checkbox is off, or the browser blocked the
popup), a follow-up dialog (`StageCommandDialog`) shows the equivalent CLI command for
the stage — `npm stage approve|reject <stage-id>`, built by
`src/lib/npm-stage-command.ts` — as copyable text. It is display only: Drydock never
runs npm, and npm still asks the maintainer for proof-of-presence. The stage id is
validated against npm's stage-id shape before it is placed in that string, so
registry-supplied text cannot smuggle shell metacharacters into a copy-paste.

### Org-enforced step-up (organization policy)

By default the step-up is per-user: enrolled maintainers step up, others decide without a
code. An organization owner can make it mandatory for **every** member via
`organizations.require_two_factor_for_release_decisions` (Settings → General → "Release
security", `PUT /api/v1/organizations/:id/release-two-factor`, owner-only). When the policy
is on, the gate decision route (`organizationRequiresTwoFactorForReleaseDecisions` in
`server/db/organizations.ts`) layers two extra rules on top of the per-user check:

- a member who has **not** enrolled in 2FA is blocked outright →
  `403 { code: "two_factor_enrollment_required" }` (they must enroll first; the gate is
  untouched and nothing is posted to GitHub),
- an enrolled member must still present a fresh `totpCode`, exactly as above.

The gate's public shape carries `organizationRequiresTwoFactor` so `GateDecisionDialog`
prompts for a code (or shows the "enable 2FA in Settings" blocker) before the member
submits, matching what the route enforces. The decision audit event records
`twoFactorRequiredByOrg` alongside `twoFactor`/`twoFactorMethod`. Only the owner can change
the policy — an admin cannot weaken a gate the owner hardened.

**Changing the policy is itself 2FA-guarded** (it mirrors the gate decision it governs, so
an owner cannot mandate a control they have not adopted, nor silently relax it from a
hijacked session). The `PUT /api/v1/organizations/:id/release-two-factor` route, after the
owner check, applies:

- the owner must have **enrolled** in 2FA, regardless of direction → otherwise
  `403 { code: "two_factor_enrollment_required" }` (you cannot enforce a control you have not
  adopted, and it would otherwise lock the owner out of their own release decisions);
- **enabling** then needs nothing more — hardening the gate is allowed with enrollment alone;
- **disabling** (relaxing the control) additionally requires a fresh `totpCode` →
  `401 { code: "two_factor_required" }` when absent, `401 { code: "two_factor_invalid" }` when
  wrong. A failed step-up leaves the policy untouched.

The `organization.release_two_factor_changed` audit event records `enabled` plus
`twoFactor`/`twoFactorMethod` (the step-up is recorded only on a relax, the
security-weakening direction). `ReleaseSecuritySection` mirrors this: it blocks an unenrolled
owner with a link to enroll, and asks for an authenticator code before letting them stop
requiring 2FA.

## Endpoints

All under the Better Auth base path `/api/auth` and handled by `auth.handler`:

| Endpoint                                          | Purpose                                             | Auth required          |
| ------------------------------------------------- | --------------------------------------------------- | ---------------------- |
| `POST /api/auth/two-factor/enable`                | Begin enrollment; returns `totpURI` + `backupCodes` | Session + password     |
| `POST /api/auth/two-factor/verify-totp`           | Confirm enrollment / pass sign-in challenge         | Session or pending 2FA |
| `POST /api/auth/two-factor/verify-backup-code`    | Pass sign-in challenge with a recovery code         | Pending 2FA            |
| `POST /api/auth/two-factor/disable`               | Turn off 2FA                                        | Session + password     |
| `POST /api/auth/two-factor/generate-backup-codes` | Issue a fresh set of recovery codes                 | Session + password     |

## Data model

`server/db/schema.ts`:

- `user.two_factor_enabled` (`integer`, boolean mode, nullable) — set `true` once TOTP enrollment
  is verified.
- `organizations.require_two_factor_for_release_decisions` (`integer`, boolean mode, not null,
  default `false`) — the org-level policy that forces a step-up for every member on release-gate
  decisions (see the org-enforced step-up section above).
- `two_factor` table — one row per enrolled user:
  - `id` (text, PK)
  - `secret` (text) — symmetrically encrypted by Better Auth, never the raw base32
  - `backup_codes` (text) — symmetrically encrypted by Better Auth
  - `verified` (integer, boolean mode) — `true` after the first successful TOTP verification;
    the plugin requires this column
  - `user_id` (text, FK → `user.id`, `ON DELETE CASCADE`)

Migrations are generated with `pnpm db:generate` (see `drizzle/0016_lovely_madrox.sql`),
never hand-written.

## Rate limiting

The verify endpoints are brute-force targets, so `authIpLimit()` in `server/index.ts` adds a
dedicated bucket for everything under `/api/auth/two-factor`:

```
{ bucket: "two-factor", max: 10, windowMs: 15 * 60 * 1000 }
```

10 requests per IP per 15-minute window; the 11th returns `429`. The existing origin/CSRF check
already covers these POSTs.

A 15-minute window is longer than Cloudflare's Rate Limiting binding can express, so this bucket
is counted in D1 behind a native per-minute burst guard — the 15-minute budget stays the
authority. See [`security-model.md`](./security-model.md#rate-limiting).

The step-up itself is not cached, but the session it runs against can be: `verifyTotpStepUp`
resolves the caller's session through Better Auth, which may answer from the session cookie cache.
What that cache never covers is the material the step-up decides on — `userHasTwoFactor`, the
organization's `requireTwoFactorForReleaseDecisions` policy, the encrypted TOTP secret, and the
membership/role check are all D1 reads on every request, so enrolling, un-enrolling, or changing
the org policy takes effect immediately. The residual window is the same bounded revocation lag
that applies to every authenticated request: a session revoked in the last few minutes can still
complete a step-up. See [`security-model.md`](./security-model.md#session-posture).

## Tests

- `test/workers/two-factor-routes.test.ts` — drives the real Better Auth handler via
  `worker.fetch`: enroll → verify TOTP → assert `twoFactorEnabled`, sign-in challenge
  (`twoFactorRedirect`), backup-code sign-in, disable, and the rate-limit bucket. (The full TOTP
  flow runs several scrypt hashes; the test keeps a generous 30s timeout even though
  `auth.ts` now uses native scrypt — see [`tooling.md`](./tooling.md#worker-suite-performance).)
- `test/e2e/two-factor.spec.ts` — Playwright flow: register → enable 2FA in Account settings (reads
  the secret, computes a TOTP with `otpauth`) → sign out → sign in through the challenge step.
- `test/workers/github-gate-two-factor.test.ts` — drives the real worker for the gate-decision
  step-up: an enrolled maintainer is rejected without a code (`two_factor_required`) and with a
  wrong code (`two_factor_invalid`) — the gate stays `pending` and nothing is posted to GitHub — a
  fresh TOTP releases the gate and posts the decision exactly once, and a maintainer without 2FA
  decides without a code. The org-enforced policy adds: an unenrolled member is blocked
  (`two_factor_enrollment_required`), and an enrolled member still needs a fresh code.
- `test/workers/organizations-routes.test.ts` — covers the owner-only
  `PUT /api/v1/organizations/:id/release-two-factor` toggle that needs no real authenticator:
  rejected for admins/strangers (404) and a non-boolean body (400); an unenrolled owner is
  blocked from enabling (`two_factor_enrollment_required`) while an enrolled owner enables with
  no code; and relaxing without a code stops at `two_factor_required` with the policy left on.
- `test/workers/organizations-release-two-factor.test.ts` — drives the real worker for the
  toggle's step-up: an enrolled owner enables without a code and relaxes with a fresh code, but
  cannot relax without one (`two_factor_required`) or with a wrong one (`two_factor_invalid`),
  and an owner without 2FA cannot enable (`two_factor_enrollment_required`) — a failed step-up
  never changes the stored policy.
