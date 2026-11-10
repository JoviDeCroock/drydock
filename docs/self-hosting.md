# Self-hosting

Run Drydock on your own Cloudflare account as one Worker with static assets. **Authority:** internal (operator guide). **Owner:** `docs/examples/wrangler.self-host.jsonc` (template) and `server/env.d.ts` (binding types).

The checked-in `wrangler.jsonc` targets the maintainers' production deployment. **Never deploy from it.** Every remote `wrangler` command below selects your config explicitly: `--config wrangler.self-host.jsonc` before the build, or the generated `dist/staged_publish_review/wrangler.json` after it.

## Requirements

| Need | Detail |
| --- | --- |
| Node | `>=22.14.0` (`package.json` `engines`) |
| pnpm | `11.1.1` (`packageManager`) |
| Cloudflare | Workers, D1, R2, and Worker Loaders; Workers AI for AI review; other services per the [bindings table](#bindings) |
| npm access token | One per organization that reviews staged npm publishes ([npm-trusted-publishing.md](./npm-trusted-publishing.md)) |
| Optional | GitHub App (workflow gates), classic GitHub OAuth app (sign-in), Slack app (notifications) |

## Local development

```sh
pnpm install
cp .dev.vars.example .dev.vars
pnpm run test
pnpm run dev
```

1. Generate secrets with `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"` or `openssl rand -base64 32`.
2. Set in `.dev.vars`: `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL=http://localhost:5173`, `NPM_CONNECTIONS_ENCRYPTION_KEY`.
3. The Worker serves UI and API at `http://localhost:5173`. Sign in, create or select an organization, and add an npm connection in Settings before scanning.
4. Validate your self-host config locally: `CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH=wrangler.self-host.jsonc pnpm run dev`.
5. No credentials at all: `pnpm run e2e:dev:seed` ([e2e-test-environment.md](./e2e-test-environment.md)).

Never commit `.dev.vars`, private keys, tokens, or generated credential material.

## Bindings

Must match `server/env.d.ts`; `test/env-binding-parity.test.mjs` checks the template against it.

| Binding | Type | Required? | Feature / behavior when absent |
| --- | --- | --- | --- |
| `DB` | D1 | Yes | All durable state. |
| `ARTIFACTS` | R2 | **Yes** | Scan bodies and publisher-setup payloads; without it completed scans fail closed (note 1). |
| `LOADER` | Worker Loader | Yes | Dynamic Worker sandbox that parses package bytes (`server/lib/sandbox.ts`). |
| `AI` | Workers AI | Yes (typed required) | AI review and publisher setup. |
| `ASSETS` | Static assets | Yes in production | SPA and prerendered pages; template keeps `run_worker_first: true`. |
| `FLAGS` | Flagship | Optional | Feature flags incl. the `ai-review` killswitch. **Without it AI review and setup drafting are off** (note 2). |
| `SCAN_QUEUE` | Queue producer + consumer | Optional | Scan jobs; without it scans run in a `waitUntil()` fallback (note 3). |
| `COMPARE_CACHE` | KV | Optional | Public-diff and compare result cache. |
| `AUTH_SESSIONS` | KV | Optional | Better Auth secondary session store (D1 stays the durable record); without it, D1 only. |
| `RATE_LIMIT_{10,20,30,60,120,240}_PER_MINUTE` | Rate Limiting | Optional | Native per-minute tiers; without them limits fall back to the D1 `rate_limits` counter (note 4). |
| `PRODUCT_ANALYTICS` | Analytics Engine | Optional | Aggregate product counters; every call is a no-op without it ([product-analytics.md](./product-analytics.md)). |
| `SEND_EMAIL` | Send Email | Optional | Notifications, verification links, password reset. |
| `PUBLISHER_SETUP_WORKFLOW` | Workflow (`PublisherSetupWorkflow`) | Optional | Repository-agent PR preparation; drafting returns `503` without it. |

1. A completed scan's body lives only in R2 (canonical report JSON, redacted samples, generated diffs, manifests); D1 keeps the metadata row. Without `ARTIFACTS` the scan fails closed at persist time (`scan.artifacts.binding_missing`, `server/lib/scan/artifacts/write.ts`) instead of storing a reviewable scan with no diff ([artifact-storage.md](./artifact-storage.md)).
2. With `FLAGS` wired, AI review is on by default per organization and the `ai-review` flag switches it off per org or globally. The same Flagship app holds `clef-injection-screen` (default off, no extra secret), `out-of-band-watch`, and `dependency-review` (default off; offers [dependency review](./dependency-review.md) to an organization, and without `FLAGS` every organization is offered it).
3. Keep the queue consumer `max_retries` and `dead_letter_queue` aligned with `MAX_SCAN_JOB_ATTEMPTS` in `server/lib/scan/job.ts`.
4. Tiers are `NATIVE_TIERS` in `server/lib/platform/rate-limit.ts`; they need no provisioning ([security-model.md](./security-model.md#rate-limiting)).
5. A custom registry signals a private deployment: `/api/public/v1/package-diff` (including PyPI mode) and `/og/*` return 404.

### Secrets

Set with `pnpm exec wrangler secret put <NAME> --config wrangler.self-host.jsonc`. Never put them in a config file.

| Secret | Required? | Effect |
| --- | --- | --- |
| `BETTER_AUTH_SECRET` | Yes | Session signing; also the fallback for `GITHUB_APP_STATE_SECRET`. |
| `NPM_CONNECTIONS_ENCRYPTION_KEY` | Yes for npm connections | Encrypts stored npm tokens; `server/lib/platform/secret-box.ts` throws if absent or under 32 characters. |
| `ATTESTATION_SIGNING_KEY_JWK` | Optional | Ed25519 private JWK (kty OKP) for report attestations; absent → attestation endpoints `503`, sharing still works. |
| `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_WEBHOOK_SECRET` | For workflow gates | GitHub App. |
| `GITHUB_APP_STATE_SECRET` | Optional | Defaults to `BETTER_AUTH_SECRET`. |
| `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET` | For GitHub sign-in | See [GitHub sign-in](#github-sign-in). |
| `SLACK_CLIENT_SECRET` | For Slack | [slack-notifications.md](./slack-notifications.md). |

### Vars

| Var | Required? | Effect |
| --- | --- | --- |
| `BETTER_AUTH_URL` | Yes | Canonical deployed origin; reset links are built from it. |
| `NPM_REGISTRY` | Yes | Defaults to `https://registry.npmjs.org`; any other value disables the public diff API and `/og/*` (bindings note 5). |
| `AI_CACHE_AFFINITY` | Yes in template | Stable Workers AI prefix-cache affinity string. |
| `PNPM_VERSION` | Template | Mirrors `packageManager` for operators; the Worker never reads it. |
| `EMAIL_FROM_ADDRESS`, `EMAIL_FROM_NAME` | With `SEND_EMAIL` | Sender. |
| `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_CLIENT_ID` | For workflow gates | Public GitHub App identifiers. |
| `SLACK_CLIENT_ID` | For Slack | Public Slack client id. |
| `WORKFLOW_GATE_CALLBACK_WINDOW_MS` | Optional | Overrides GitHub's 30-day protection-rule callback window used to flag lapsed gates (`server/lib/workflow-gate-job.ts`). |
| `SCAN_ARTIFACT_READS_DISABLED` | Optional | `true`/`1` is an R2 read kill-switch (`server/lib/scan/artifacts/read.ts`). |
| `ALLOW_INSECURE_LOCAL_REGISTRY` | Never in production | Loopback HTTP registries for the e2e harness only. |
| `DISABLE_SECURITY_HEADERS` | Never deployed | `.dev.vars`-only escape hatch; production keeps the full header policy. |
| `AUTH_REQUIRED` | — | Declared in `server/env.d.ts`; no server code reads it. |

## Deploy checklist

1. Copy the template to the gitignored path and keep it local (account IDs, domains, client IDs must never replace upstream config in a PR):

   ```sh
   cp docs/examples/wrangler.self-host.jsonc wrangler.self-host.jsonc
   ```

2. Create resources:

   ```sh
   pnpm exec wrangler d1 create staged-publish-review --config wrangler.self-host.jsonc
   pnpm exec wrangler r2 bucket create staged-publish-review-artifacts --config wrangler.self-host.jsonc
   pnpm exec wrangler queues create staged-publish-review-scans --config wrangler.self-host.jsonc
   pnpm exec wrangler queues create staged-publish-review-scans-dlq --config wrangler.self-host.jsonc
   pnpm exec wrangler kv namespace create COMPARE_CACHE --config wrangler.self-host.jsonc
   pnpm exec wrangler kv namespace create AUTH_SESSIONS --config wrangler.self-host.jsonc
   ```

   Optional resources may be skipped by removing their binding blocks instead.

3. Replace every `REPLACE_*` placeholder:

   | Field | Value |
   | --- | --- |
   | `d1_databases[].database_id`, each `kv_namespaces[].id` | IDs from step 2 |
   | each `ratelimits[].namespace_id` | A positive integer unique across your Cloudflare account (no provisioning) |
   | `routes` | Your custom domain, or remove `routes` and use the `workers_dev` subdomain |
   | `flagship[].app_id` | Your Flagship app (or remove the block: AI review off) |
   | `vars` | `BETTER_AUTH_URL`, `EMAIL_FROM_ADDRESS`, `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_CLIENT_ID`, `SLACK_CLIENT_ID` |

4. Apply migrations after the D1 ID is set:

   ```sh
   pnpm exec wrangler d1 migrations apply staged-publish-review --remote --config wrangler.self-host.jsonc
   ```

5. Set secrets:

   ```sh
   pnpm exec wrangler secret put BETTER_AUTH_SECRET --config wrangler.self-host.jsonc
   pnpm exec wrangler secret put NPM_CONNECTIONS_ENCRYPTION_KEY --config wrangler.self-host.jsonc
   pnpm exec wrangler secret put ATTESTATION_SIGNING_KEY_JWK --config wrangler.self-host.jsonc   # optional
   ```

6. Build and deploy the generated config (deploying `wrangler.self-host.jsonc` directly omits the Vite build output). If you rename the Worker, use the matching normalized directory under `dist/`.

   ```sh
   CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH=wrangler.self-host.jsonc pnpm run build
   pnpm exec wrangler deploy --config dist/staged_publish_review/wrangler.json
   ```

7. Verify: `BETTER_AUTH_URL` matches the deployed origin; migrations are applied; sign in and create an organization; add and validate an npm connection; run a test staged-publish review; check Worker logs and Agent Traces show structured events without raw package contents or secrets.

Keep the `*/15 * * * *` cron trigger: it runs staged-publish discovery, the publication monitor, and retention pruning (audit events, auth rows, rate-limit buckets, expired publisher-setup payloads).

## Observability

| Template block | Default | Change |
| --- | --- | --- |
| `observability.logs` | On, with invocation logs | — |
| `observability.traces` | Every trace persisted (`head_sampling_rate: 1`); the reviewer wrapper disables message and tool payload storage | Lower `head_sampling_rate` as span volume grows, or remove the block. |
| `observability.issues` | On: groups exceptions, 5xx responses, error logs, with its own request details | Removing logs or traces does not disable it; set `observability.issues.enabled` to `false`. Any automation destination receives token-bearing URLs; keep it private. |

## Integrations

### Email

`SEND_EMAIL` + `EMAIL_FROM_ADDRESS` + `EMAIL_FROM_NAME` enable notifications, verification links, and password reset ("Forgot password?" on login; "set a password" for GitHub-only accounts). Reset stays off when `BETTER_AUTH_URL` is unset or loopback (`GET /api/auth/config` reports `passwordReset`). Links expire after an hour, work once, and sign the account out everywhere ([security-model.md](./security-model.md#password-reset)).

### GitHub sign-in

1. Use a **classic OAuth app, not the workflow-gate GitHub App**. Register `${BETTER_AUTH_URL}/api/auth/callback/github` as the Authorization callback URL, then set `GITHUB_OAUTH_CLIENT_ID` and `GITHUB_OAUTH_CLIENT_SECRET`. With both set, login and register offer "Continue with GitHub" (`GET /api/auth/config` reports availability).
2. Identity only: profile and verified email via `read:user user:email`, no repo scopes, never installs the GitHub App. Request-level scope overrides are rejected server-side.
3. GitHub App client IDs (the `Iv` prefix, legacy and current) are rejected even with a secret: Apps ignore OAuth scopes, their user tokens can carry installation permissions, and Better Auth exposes token retrieval endpoints.
4. Drydock does not use the token after the callback; `account.encryptOAuthTokens` keeps what Better Auth stores encrypted.
5. A GitHub sign-in is verified when GitHub reports the address verified, which satisfies the per-action verified-email checks (npm token, decision, share link, invitation, GitHub install; [security-model.md](./security-model.md#email-verification)).
6. Implicit account linking is disabled, including Better Auth's link endpoint: a GitHub sign-in whose email belongs to a password account fails back to login, because the TOTP challenge guards only password sign-ins. The TOTP step-up on release decisions applies to every sign-in method.
7. A GitHub-only account has no password, and every two-factor endpoint reauthenticates with one. With email, Account settings mails a set-password link once the address is verified. **Without email it cannot enrol, so do not offer GitHub sign-in on an email-less deployment whose organizations require two-factor for decisions** ([two-factor-auth.md](./two-factor-auth.md#management)).

### Workflow gates

Needs a GitHub App with deployment-protection webhooks and the GitHub App secrets and vars above; map repositories and environments in Settings. The publish workflow builds artifacts before the gate and publishes the reviewed bundle after approval ([workflow-gates.md](./workflow-gates.md)).

### Dependency review

Uses the same GitHub App. Add the **Checks: read and write**, **Pull requests: read**, and **Contents: read** repository permissions and subscribe to the **Pull request**, **Check run**, and **Check suite** events. Check suite events deliver GitHub's **Re-run all checks** action. GitHub asks each installation's owner to accept the new permissions; until they do, reviews in that installation fail to create their check run. With `FLAGS` wired, roll it out per organization with the `dependency-review` flag; each organization then turns it on in Settings → Integrations ([dependency-review.md](./dependency-review.md)).

A custom `NPM_REGISTRY` also cuts dependency review off from the public registries: nothing is diffed, no lockfile pin is proven, and no publish time is known, so under the default policy every public bump holds until a repository writer approves it. To let those updates pass unreviewed instead, each organization turns the minimum age for unread updates off (an empty field) and leaves "has no Drydock verdict" off. A review needs several queue invocations when its diffs are not cached; it continues on its own through `SCAN_QUEUE`, so no extra binding is needed.

### Publisher setup assistant

1. Optional ([publisher-setup.md](./publisher-setup.md)): inspects an installed repository and prepares a draft PR with Workers AI (`AI_MODEL` in `server/lib/ai-review/index.ts`). The explicit start action authorizes drafting, validation, independent review, and automatic PR creation.
2. Uses the organization's `ai-review` flag; preflights the installation's Contents, Pull requests, and Workflows write permissions before calling the model; never expands installed grants. A read-only installation still supports inspection and manual setup.
3. Requires `PUBLISHER_SETUP_WORKFLOW` with `PublisherSetupWorkflow` exported from the same Worker; deploy it with the Worker and apply migrations before enabling the UI. Without it drafting returns `503`; manual guides and existing gates keep working.
4. Repository files, transcripts, proposed edits, and judge evidence stay in private R2 (`ARTIFACTS`), not Workflow step history. Every model turn is checkpointed; agents have pinned read/edit proposal tools and no code-execution or GitHub mutation tools. Expired payloads are pruned by the cron.
5. Before testing a release, enable the environment's Drydock protection rule and map its release target; the status check reports configuration and observed review independently.

### Slack

Register `https://YOUR_ORIGIN/api/v1/slack/callback` as the redirect URL, then set `SLACK_CLIENT_ID` and `SLACK_CLIENT_SECRET` ([slack-notifications.md](./slack-notifications.md)).

## Operating rules

1. Do not retain raw tarballs by default.
2. Keep organization npm tokens narrowly scoped (read-only is sufficient) and rotated.
3. Treat all package contents as sensitive, even after redaction.
4. Run `pnpm run verify` before deploying; run `pnpm run test:e2e` for registry, staged-publish, credential-forwarding, and scan-workflow changes.
5. Review [security-model.md](./security-model.md) before changing trust boundaries.

## Change checklist

| If you change | Also |
| --- | --- |
| A binding or var | `server/env.d.ts`, `wrangler.jsonc`, `docs/examples/wrangler.self-host.jsonc`, the [bindings table](#bindings); run `pnpm exec vitest run --project node test/env-binding-parity.test.mjs`. |
| Queue retry policy | `MAX_SCAN_JOB_ATTEMPTS` and the template consumer settings. |
| A cron task | The cron note in [Deploy checklist](#deploy-checklist). |
