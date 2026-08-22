# Self-hosting

This guide covers running Drydock on your own Cloudflare account. The default
deployment target is a Cloudflare Worker with static assets, D1, R2, KV, Queues,
Workers AI, a Dynamic Worker loader, and optional email, Slack, and GitHub App
integrations.

## Requirements

- Node `22.14.0+`
- pnpm `11.1.1`
- A Cloudflare account with Workers, D1, and Worker Loaders available
- Optional Cloudflare services for the corresponding features: R2, KV, Queues,
  Workers AI, Analytics Engine, Email Routing, and Flagship
- An npm access token for each organization that will review staged npm
  publishes
- Optional: a GitHub App for workflow gates
- Optional: a Slack app for notifications

## Local development

```sh
pnpm install
cp .dev.vars.example .dev.vars
pnpm run test
pnpm run dev
```

Generate local secrets:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
openssl rand -base64 32
```

Set these in `.dev.vars`:

- `BETTER_AUTH_SECRET`
- `BETTER_AUTH_URL=http://localhost:5173`
- `NPM_CONNECTIONS_ENCRYPTION_KEY`

The local Worker serves the UI and API at `http://localhost:5173`. After signing
in, create or select an organization and add an npm connection from Settings
before scanning staged publishes.

## Cloudflare resources

Create the required D1 database:

```sh
pnpm exec wrangler d1 create staged-publish-review
```

The template also enables the optional queue, KV cache, and R2 artifact store.
Create those resources for the full configuration, or remove their binding
blocks from your self-host config:

```sh
pnpm exec wrangler queues create staged-publish-review-scans
pnpm exec wrangler queues create staged-publish-review-scans-dlq
pnpm exec wrangler queues create staged-publish-review-discovery
pnpm exec wrangler kv namespace create COMPARE_CACHE
pnpm exec wrangler kv namespace create AUTH_SESSIONS
pnpm exec wrangler r2 bucket create staged-publish-review-artifacts
```

`AUTH_SESSIONS` is Better Auth's secondary session store: it keeps the
per-request session lookup off D1 while D1 stays the durable record. It is
optional — drop the binding to read and write sessions in D1 only. The
`ratelimits` bindings in the template need no provisioning; replace each
`namespace_id` with a positive integer that is unique across your Cloudflare
account. Dropping them makes every rate limit fall back to the D1 `rate_limits`
counter. See
[`security-model.md`](./security-model.md#rate-limiting).

The checked-in `wrangler.jsonc` targets the maintainers' production deployment.
Do not deploy from it. Copy the public template to the gitignored self-host path
and fill in your account values:

```sh
cp docs/examples/wrangler.self-host.jsonc wrangler.self-host.jsonc
```

Keep `wrangler.self-host.jsonc` local. It is ignored by git so account IDs,
domains, integration client IDs, and deployment choices cannot accidentally
replace the upstream production configuration in a pull request.

`docs/examples/wrangler.self-host.jsonc` keeps the default resource names and marks every
account-owned value with a `REPLACE_*` placeholder. Replace at least:

- `d1_databases[].database_id`, every `kv_namespaces[].id`, and every
  `ratelimits[].namespace_id`;
- custom `routes` with your own custom domain, or remove `routes` and use the
  generated `workers_dev` subdomain instead;
- the `flagship` app id to wire the `ai-review` killswitch (with Flagship wired,
  the AI reviewer is on by default per organization and can be switched off per
  org or globally), or remove the `flagship` block to keep AI review disabled;
- public integration vars such as `BETTER_AUTH_URL`, `EMAIL_FROM_ADDRESS`,
  `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_CLIENT_ID`, and
  `SLACK_CLIENT_ID`.

Keep the scan queue consumer's `max_retries` and `dead_letter_queue` settings
aligned with `MAX_SCAN_JOB_ATTEMPTS` in `server/lib/scan/job.ts`.

`staged-publish-review-discovery` carries one staged-publish discovery sweep per
organization, produced by the 15-minute cron tick (see "Scheduled discovery" in
[`architecture.md`](./architecture.md)). It is separate from the scan queue so a
discovery burst cannot starve scan execution, and it needs no dead-letter queue:
sweeps are idempotent and every tick re-enqueues them. Dropping the
`DISCOVERY_QUEUE` producer/consumer pair is supported — the cron then sweeps
inline inside its own invocation, which is fine for a handful of organizations
but is what the queue exists to replace at scale.
With the queue configured, large per-organization staged listings are listed
once and fanned into independent 50-candidate messages so scan-row preparation
cannot exhaust one Worker's subrequest budget or form a recursive queue chain.

Apply migrations after the D1 database ID is configured, always passing the
self-host config explicitly:

```sh
pnpm exec wrangler d1 migrations apply staged-publish-review --remote \
  --config wrangler.self-host.jsonc
```

## Secrets and vars

Set required secrets with Wrangler:

```sh
pnpm exec wrangler secret put BETTER_AUTH_SECRET --config wrangler.self-host.jsonc
pnpm exec wrangler secret put NPM_CONNECTIONS_ENCRYPTION_KEY \
  --config wrangler.self-host.jsonc
```

Optional secrets:

```sh
# Ed25519 private JWK for public report attestations (docs/public-reports.md).
# Without it, report sharing works but attestation endpoints return 503.
pnpm exec wrangler secret put ATTESTATION_SIGNING_KEY_JWK
```

Required non-secret vars:

- `BETTER_AUTH_URL` — canonical deployed origin
- `NPM_REGISTRY` — defaults to `https://registry.npmjs.org`
- `AI_CACHE_AFFINITY` — stable prefix-cache affinity string for Workers AI
- `PNPM_VERSION` — used by the runtime where npm tooling parity matters

Optional integrations:

- Email: `SEND_EMAIL` binding plus `EMAIL_FROM_ADDRESS` and `EMAIL_FROM_NAME`
- GitHub App: `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_CLIENT_ID`,
  `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_WEBHOOK_SECRET`,
  and optional `GITHUB_APP_STATE_SECRET` (otherwise `BETTER_AUTH_SECRET` is used)
- Slack: `SLACK_CLIENT_ID` and `SLACK_CLIENT_SECRET`

Do not commit `.dev.vars`, private keys, tokens, or generated credential
material.

## Run with the self-host config

Use the same explicit config for local validation:

```sh
CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH=wrangler.self-host.jsonc pnpm run dev
```

## Deploy

Build with the self-host source config. The Cloudflare Vite plugin writes a
deployable config containing the compiled Worker modules and static asset
directory under `dist/staged_publish_review/`. Deploy that generated config;
deploying `wrangler.self-host.jsonc` directly omits the Vite build output.

```sh
CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH=wrangler.self-host.jsonc pnpm run build
pnpm exec wrangler deploy --config dist/staged_publish_review/wrangler.json
```

If you change the Worker `name` in `wrangler.self-host.jsonc`, use the matching
normalized directory name under `dist/` for the generated config.

After deploying:

1. Confirm `BETTER_AUTH_URL` matches the deployed origin.
2. Confirm D1 migrations are applied.
3. Sign in and create an organization.
4. Add and validate an npm connection.
5. Run a test staged-publish review.
6. Check Worker logs and sampled Agent Traces for structured events without raw
   package contents or secrets. The template persists 10% of traces while the
   reviewer wrapper disables message and tool payload storage; remove the
   `observability.traces` block if you do not want persisted traces at all.

## GitHub workflow gates

Workflow gates require a GitHub App with deployment-protection webhooks. Configure
the App, set its secrets and vars, then map repositories and environments from
Settings. The target publish workflow must build artifacts before the gate and
publish the reviewed artifact bundle after approval. See
[`workflow-gates.md`](workflow-gates.md) and
[`npm-workflow-gate.md`](npm-workflow-gate.md).

## Slack notifications

Slack notifications require a Slack OAuth app. Register the redirect URL:

```text
https://YOUR_ORIGIN/api/v1/slack/callback
```

Then set `SLACK_CLIENT_ID` and `SLACK_CLIENT_SECRET`. See
[`slack-notifications.md`](slack-notifications.md).

## Artifact storage and backfill

R2 stores canonical report JSON, redacted file samples, generated diffs, and
manifests for completed scans. New scans write artifacts when the `ARTIFACTS`
binding is present. Legacy scans can be backfilled:

```sh
pnpm run scan-artifacts:backfill -- --all-organizations --limit 50
```

See [`artifact-storage.md`](artifact-storage.md) for object layout, rollback, and
compaction behavior.

## Operational notes

- Do not retain raw tarballs by default.
- Keep organization-scoped npm tokens narrowly scoped and rotated.
- Treat all package contents as sensitive, even after redaction.
- Run `pnpm run verify` before deploying changes.
- Run `pnpm run test:e2e` for registry, staged-publish, credential-forwarding,
  and scan-workflow changes.
- Review [`security-model.md`](security-model.md) before changing trust
  boundaries.
