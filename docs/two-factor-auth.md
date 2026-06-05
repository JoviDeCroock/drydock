# Two-factor authentication

Drydock supports opt-in two-factor authentication (2FA) using TOTP (time-based one-time
passwords from an authenticator app) plus single-use backup recovery codes. It is built on
Better Auth's first-party [`two-factor`](https://www.better-auth.com/docs/plugins/2fa) plugin,
registered in `server/lib/auth.ts`:

```ts
plugins: [twoFactor({ issuer: "Drydock" })];
```

The `issuer` (and `appName: "Drydock"`) is the label authenticator apps display next to the
account. Backup codes use the plugin default: 10 single-use codes.

## User flows

### Enrollment (Settings → General)

`src/pages/Dashboard/Settings/TwoFactorSection.tsx` drives a dialog:

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

Only after the second factor succeeds is a full session cookie set. The client model logic lives
in `src/models/auth.ts` (`signIn` returns `{ twoFactorRequired }`; `completeTwoFactorSignIn`)
and `src/models/two-factor.ts`.

### Management

Enrolled users can regenerate backup codes
(`POST /api/auth/two-factor/generate-backup-codes`, password-gated) or disable 2FA
(`POST /api/auth/two-factor/disable`, password-gated) from Settings → General.

### Step-up: deciding a workflow gate (issue #162)

Two-factor is also a **step-up** factor for the highest-trust action in the product:
releasing or blocking a held GitHub deployment gate (`POST
/api/v1/github-app/workflow-gates/:gateId/decision`). Approving a gate immediately
releases the held Actions job and publishing proceeds over Trusted Publishing/OIDC,
which cannot be reversed — so an existing session alone is not enough.

When the deciding maintainer has 2FA enabled, the request must carry a **fresh**
`totpCode`. The route checks enrollment with `userHasTwoFactor` and verifies the code
with `verifyTotpStepUp` (both in `server/lib/auth.ts`), which delegates to Better
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
release on npm — and intentionally does **not** require a step-up. Maintainers without
2FA enabled decide gates without a code, as before.

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

## Tests

- `test/workers/two-factor-routes.test.ts` — drives the real Better Auth handler via
  `worker.fetch`: enroll → verify TOTP → assert `twoFactorEnabled`, sign-in challenge
  (`twoFactorRedirect`), backup-code sign-in, disable, and the rate-limit bucket. (The full TOTP
  flow runs several scrypt hashes, so the test sets a 30s timeout.)
- `test/e2e/two-factor.spec.ts` — Playwright flow: register → enable 2FA in Settings (reads the
  secret, computes a TOTP with `otpauth`) → sign out → sign in through the challenge step.
- `test/workers/github-gate-two-factor.test.ts` — drives the real worker for the gate-decision
  step-up: an enrolled maintainer is rejected without a code (`two_factor_required`) and with a
  wrong code (`two_factor_invalid`) — the gate stays `pending` and nothing is posted to GitHub — a
  fresh TOTP releases the gate and posts the decision exactly once, and a maintainer without 2FA
  decides without a code.
