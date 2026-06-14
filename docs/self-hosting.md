# Self-hosting

This guide covers running your own Drydock deployment on Cloudflare. The
committed `wrangler.jsonc` currently drives the production deployment, so forks
should edit it for their own account rather than expecting it to be generic out
of the box.

## Prerequisites

- Node 22+ and pnpm via Corepack.
- A Cloudflare account with Workers Paid features needed by this app: Workers,
  D1, KV, R2, Queues, Worker Loaders, Send Email, and optionally Workers AI /
  Flagship.
- A GitHub App if you want workflow gates for PyPI/npm release jobs.
- A Slack app if you want Slack notifications.
- npm access tokens supplied by each organization inside the app; do not put npm
  tokens in `wrangler.jsonc` or `.dev.vars`.

## Local development

```bash
pnpm install
cp .dev.vars.example .dev.vars
pnpm run dev
```

Generate local secrets:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Use separate values for `BETTER_AUTH_SECRET` and
`NPM_CONNECTIONS_ENCRYPTION_KEY`.

## Cloudflare resources

Create resources in the target Cloudflare account, then copy the resulting IDs
or names into `wrangler.jsonc`.

```bash
wrangler d1 create drydock
wrangler kv namespace create COMPARE_CACHE
wrangler r2 bucket create drydock-artifacts
wrangler queues create drydock-scans
wrangler queues create drydock-scans-dlq
```

Update these sections in `wrangler.jsonc`:

- `d1_databases[0].database_id`
- `kv_namespaces[0].id`
- `r2_buckets[0].bucket_name`
- `queues.producers[0].queue`
- `queues.consumers[0].queue`
- `queues.consumers[0].dead_letter_queue`
- `routes`
- `vars.BETTER_AUTH_URL`
- `vars.APP_NAME`
- `vars.APP_TAGLINE`
- `vars.BRAND_WORDMARK`
- `vars.CONTACT_EMAIL`
- `vars.EMAIL_FROM_ADDRESS`
- `vars.EMAIL_FROM_NAME`

`APP_NAME`, `APP_TAGLINE`, `BRAND_WORDMARK`, and `CONTACT_EMAIL` are public
display settings. Vite reads them from `wrangler.jsonc` at build time for the
static UI and HTML metadata. `EMAIL_FROM_ADDRESS` / `EMAIL_FROM_NAME` are the
server-side sender settings for Cloudflare Email.

If you use Cloudflare Flagship for AI review, replace the `flagship.app_id` with
your own app id. The `ai-review` flag must stay default-off unless you are
intentionally enabling the advisory AI reviewer for an organization.

## Secrets

Set production secrets with Wrangler, never in `wrangler.jsonc`:

```bash
wrangler secret put BETTER_AUTH_SECRET
wrangler secret put NPM_CONNECTIONS_ENCRYPTION_KEY
```

Optional integrations:

```bash
wrangler secret put GITHUB_APP_PRIVATE_KEY
wrangler secret put GITHUB_APP_WEBHOOK_SECRET
wrangler secret put GITHUB_APP_CLIENT_SECRET
wrangler secret put GITHUB_APP_STATE_SECRET
wrangler secret put SLACK_CLIENT_SECRET
```

The public IDs for those integrations live in `wrangler.jsonc`:

- `GITHUB_APP_ID`
- `GITHUB_APP_SLUG`
- `GITHUB_APP_CLIENT_ID`
- `SLACK_CLIENT_ID`

## GitHub App

Create a GitHub App owned by the account that will install it on release
repositories.

Recommended callback URLs:

- User authorization callback:
  `https://<your-domain>/api/v1/github-app/callback`
- Webhook URL: `https://<your-domain>/webhooks/github`

Use the webhook secret from `GITHUB_APP_WEBHOOK_SECRET`. Store the private key as
`GITHUB_APP_PRIVATE_KEY`; preserve newlines when entering it through Wrangler.

For workflow gates, enable deployment protection rule events and install the app
on repositories that use GitHub Environments for publishing. See
[`workflow-gates.md`](workflow-gates.md) and
[`npm-workflow-gate.md`](npm-workflow-gate.md).

## Slack app

Create a Slack OAuth app only if you need Slack notifications.

Set the redirect URL to:

```text
https://<your-domain>/api/v1/slack/callback
```

Put the client id in `wrangler.jsonc` as `SLACK_CLIENT_ID`, and put the client
secret in `SLACK_CLIENT_SECRET`.

## Email

The Worker uses Cloudflare's `send_email` binding for account verification,
scan notifications, token-expiry alerts, organization invites, and workflow-gate
review prompts.

Configure:

- `send_email` binding named `SEND_EMAIL`
- `EMAIL_FROM_ADDRESS`
- `EMAIL_FROM_NAME`
- SPF, DKIM, and DMARC for the sending domain

If `SEND_EMAIL` is not bound, local/dev sign-ups do not require email
verification because the link cannot be delivered.

## Database setup

Apply migrations after configuring the D1 binding:

```bash
pnpm run db:migrate:remote
```

For local development:

```bash
pnpm run db:migrate:local
```

Never hand-write migrations. Change `server/db/schema.ts`, then run
`pnpm db:generate`.

## Deploy

Run the local gate first:

```bash
pnpm run verify
pnpm run deploy
```

After deployment, create an account, add an organization npm connection in the
dashboard, and validate that staged-publish discovery can reach the registry.

## Operational boundaries

- The Dynamic Worker sandbox must never receive npm token material.
- `NpmStageGateway` must remain the only credentialed egress path for staged npm
  tarball access.
- The app must never run package code, install dependencies, or approve a
  release automatically.
- AI review is advisory, gated off by default, and cannot downgrade
  deterministic findings.
- Do not retain raw package tarballs by default.

Read [`security-model.md`](security-model.md) before changing those boundaries.
