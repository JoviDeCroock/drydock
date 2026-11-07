# Slack notifications

Drydock delivers organization release notifications through an OAuth v2 bot and one selected public channel. **Authority:** advisory. **Owner:** `server/lib/notify/deliver.ts`.

## At a glance

| Thing | Owner file | Who may call / trigger | Pinned by (test) |
| --- | --- | --- | --- |
| Connection API | `server/routes/slack.ts` | Members read; admins/owners write | `test/workers/slack-routes.test.ts` |
| OAuth/state/API/Block Kit | `server/lib/notify/slack.ts` | Routes/notifiers | `test/slack.test.mjs` |
| Email/Slack fan-out | `server/lib/notify/deliver.ts` | Release notifiers | `test/notify.test.mjs` |

## Contract

### Configuration and scopes

| Setting | Contract |
| --- | --- |
| `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` | Optional (`server/env.d.ts`); both are needed to enable Slack, otherwise `configured: false`, a UI notice, and `503 slack_not_configured` on `POST /connect` |
| `BETTER_AUTH_URL` | `slackRedirectUri` resolves `/api/v1/slack/callback`; register that exact URL in Slack |
| `assets.run_worker_first` | Must cover `/api` in `wrangler.jsonc` to keep the callback out of SPA fallback |
| `SLACK_OAUTH_SCOPES` | `chat:write,chat:write.public` in `server/lib/notify/slack.ts`; public posting needs no bot invite |
| `SLACK_CHANNEL_LIST_SCOPE` | Optional `channels:read` (`server/lib/notify/slack.ts`); picker needs it, manual ID does not |
| `NPM_CONNECTIONS_ENCRYPTION_KEY` | Required shared secret, ≥32 chars (`encryptionKey` in `server/lib/platform/secret-box.ts`) |

| Constant | Value | File |
| --- | --- | --- |
| `STATE_TTL_MS` | 15 minutes | `server/lib/notify/slack.ts` |
| `STATE_VERSION` | `slackv1` | `server/lib/notify/slack.ts` |
| `SLACK_API_TIMEOUT_MS` | 5 seconds | `server/lib/notify/slack.ts` |

### Routes

All routes require a session; organization selection follows [the security model](./security-model.md). `roleCanManageIntegrations` permits owner/admin and rejects member writes with `403`.

| Method | Path | Auth/role | Request / response | Owner |
| --- | --- | --- | --- | --- |
| GET | `/api/v1/slack` | Any organization member | `{ configured, connection }`; connection is null or public shape below | `server/routes/slack.ts` |
| POST | `/api/v1/slack/connect` | Owner/admin | `{ authorizeUrl, expiresInSeconds }` with signed state | `server/routes/slack.ts` |
| GET | `/api/v1/slack/callback` | State user + fresh owner/admin | `oauth.v2.access` → encrypted token upsert → Settings redirect | `server/routes/slack.ts` |
| GET | `/api/v1/slack/channels` | Owner/admin + `channels:read` | `{ channels: [{ id, name }] }`; sorted, paginated, public | `server/routes/slack.ts` |
| PUT | `/api/v1/slack/channel` | Owner/admin | `{ channelId, channelName? }` → `{ connection }` | `server/routes/slack.ts` |
| PATCH | `/api/v1/slack` | Owner/admin | `{ enabled: boolean }` → `{ connection }` | `server/routes/slack.ts` |
| DELETE | `/api/v1/slack` | Owner/admin | Disconnects workspace → `{ ok: true }` | `server/routes/slack.ts` |
| POST | `/api/v1/slack/test` | Owner/admin | Sends canned test → `{ ok, rateLimited?, reason? }` | `server/routes/slack.ts` |

| Route limit | Value | Key |
| --- | --- | --- |
| Connect | 20/hour | `slack:connect:<org>` |
| Channels | 30/minute | `slack:channels:<org>` |
| Test | 10/hour | `slack:test:<org>` |

Limits are the `guardRateLimit` calls in `server/routes/slack.ts`.

The callback's handled outcomes redirect to `/dashboard/settings?tab=notifications&slack=connected|error&slackError=…`, rather than returning raw JSON.

### Connection data

Storage: `server/db/schema.ts`, `server/db/slack-connection.ts`; public response: `server/routes/slack.ts`.

| Data | Contract |
| --- | --- |
| `organization_slack_connections` | One row per organization |
| `team_id`, `team_name`, `bot_user_id`, `scope` | OAuth workspace identity/scopes |
| `bot_token_ciphertext`, `bot_token_nonce` | Encrypted `xoxb-…` token + fresh row nonce |
| `channel_id`, `channel_name` | Single selected public channel; null until selected |
| `enabled` | Disabled: token retained; skip fan-out; test can still send |
| `created_by_user_id` | Owner/admin who created connection |
| `getSlackConnection` | Token-free; separate `getSlackConnectionSecret` |

`publicConnection` in `server/routes/slack.ts` returns `{ teamId, teamName, channelId, channelName, canListChannels, enabled, createdAt }` without token columns.

### Delivery and UI

Delivery: `server/lib/notify/deliver.ts`, `server/lib/notify/index.ts`, `server/lib/notify/gate-notifications.ts`, `server/lib/notify/publication-alerts.ts`. UI: `src/pages/Dashboard/Settings/SlackConnectionSection.tsx`, `src/models/slack-connection.ts`.

| Trigger / state | Behavior |
| --- | --- |
| Completed/failed staged scan | `notifyScanCompletion`: email + Slack |
| Completed staged scan risk | Release-delta risk + prior-approved memory; artifact risk/findings unchanged |
| Workflow gate review ready | `notifyWorkflowGateReview`: Slack payload |
| npm reviewed stage becomes approvable | `notifyStagedReleaseApprovable`: Slack ([status](./registry-version-status.md)) |
| Publication discrepancy | `publication_discrepancy`: no org approval / rejected / bytes mismatch |
| Undecided published-byte review | Ask for decision first; title AI concerns explicitly; low risk sends nothing |
| Coverage gap | `publication_coverage_gap`: >1h unverifiable release/package; once/gap; never discrepancy |
| Publication copy | Names alerting org; never claims nobody else reviewed; links org dashboard |
| Unaccepted publication alert | Retry on later watch checks; [details](./publication-monitor.md) |
| Notification actor / email | Org owner is actor + recipient fallback; email uses configured recipients |
| Fan-out | Email and Slack run concurrently; Slack still sends with no email recipients |
| Eligible connection | Decrypt in memory → `renderSlackMessage` Block Kit → `chat.postMessage` |
| Disconnected UI | Owner/admin sees “Add to Slack” |
| Channel selection UI | Owner/admin picker preloads with `canListChannels`; otherwise manual ID |
| Picker / manual selection | Mutually exclusive methods; both require explicit “Save channel” |
| Test / Disconnect | Notifications header beside email recipients; test uses `pushToast` |
| Enabled UI | No pause/resume UI or model `setEnabled`; PATCH stays route-tested |

### Events

Management: `server/routes/slack.ts`; delivery: `server/lib/notify/deliver.ts`.

Events use `recordScanEvent` and `scan_events`. Delivery metadata contains `channel: "slack"` and `channelName`; failures add `statusClass`, `rateLimited`, `retryAfterSeconds`, or `reason` where applicable.

| Event | Meaning |
| --- | --- |
| `organization.slack_connected` | OAuth succeeded; metadata has team identity |
| `organization.slack_channel_set` | Destination saved |
| `organization.slack_enabled`, `organization.slack_disabled` | Automatic delivery enabled/disabled |
| `organization.slack_disconnected` | Connection removed |
| `organization.slack_tested`, `organization.slack_test_failed` | Canned test accepted/rejected |
| `scan.notification_sent`, `scan.notification_failed` | Scan/registry notification outcome; email shares event family |
| `github_workflow_gate.notification_sent`, `github_workflow_gate.notification_failed` | Gate notification outcome; email shares event family |

## Invariants

1. Tokens are never stored in plaintext, logged, or returned to clients; secret reads stay separate from status reads (`server/db/slack-connection.ts`, `test/workers/slack-routes.test.ts`).
2. AES-GCM-256 uses an HKDF-derived key with salt `drydock:slack-bot-token:salt:v1`, separate from npm token keys; ciphertext uses `CIPHERTEXT_VERSION_V1` (`v1:`) in `server/lib/platform/secret-box.ts`.
3. OAuth state HMAC-signs `{ organizationId, userId, nonce, expiresAt }` with `BETTER_AUTH_SECRET`; signature, expiry, session user, and a fresh organization role are checked before persistence (`server/routes/slack.ts`, `test/slack.test.mjs`).
4. Browser callback organization binding comes from signed state because top-level navigation has no `x-organization-id` header (`server/routes/slack.ts`).
5. `postSlackMessage` never throws or returns the bot token/channel ID in its reason; delivery is best-effort and never blocks scan or gate processing (`server/lib/notify/slack.ts`, `test/notify.test.mjs`).
6. `botToken`, `botTokenCiphertext`, `botTokenNonce`, and `accessToken` belong to `SENSITIVE_EVENT_METADATA_KEYS`; events never include token/ciphertext (`server/db/events.ts`, `test/notify.test.mjs`).

## Failure modes

| Symptom / condition | Cause | What happens | Fix |
| --- | --- | --- | --- |
| Connect unavailable | Missing credentials/auth URL | `503`; `slack_not_configured` for credentials | Set credentials/redirect URL |
| Callback error notice | Consent/state/user/role/exchange failure | Settings: `slack=error`, `slackError` | Check config; reconnect as owner/admin |
| Client 404 after consent | SPA fallback consumed callback | Route never reached | Keep `/api` in `assets.run_worker_first` |
| Channel listing forbidden | No `channels:read` | `403`; manual ID available | Save public channel ID manually |
| Channel listing failed | Slack API error | `502` with safe reason | Check connection/manual ID |
| No connection | Connection not installed | `404` for all connected-only routes | Connect workspace |
| No channel | Destination not saved | Test returns `400` | Save channel |
| Route limit exceeded | Org exhausted connect/channel/test budget | `429` | Wait for window |
| Ineligible connection | No automatic destination | Silent skip; no Slack event | Connect/enable/select channel |
| App error | HTTP `200` with `{ ok: false, error }` | Failure keyed on `ok` | Correct Slack error/connection |
| Slack throttles | HTTP `429` | `rateLimited`, `Retry-After`; no automatic post retry | Wait; see publication retry contract |
| Transport/decryption failure | Deadline, network, or key | Failure event; safe reason (`delivery_error` on decrypt) | Restore key/network |

## Change checklist

1. OAuth/scopes/state/rendering/API → update contracts; run `pnpm exec vitest run --project node test/slack.test.mjs`.
2. Encryption → update token-leak assertions; run `pnpm exec vitest run --project node test/secret-box.test.mjs`.
3. Fan-out/copy → update [publication monitoring](./publication-monitor.md), [registry status](./registry-version-status.md), events; run `pnpm exec vitest run --project node test/notify.test.mjs`.
4. Routes/Settings → update roles, public shape, callback, picker/manual behavior; run `pnpm exec vitest run --project workers test/workers/slack-routes.test.ts`.
5. Reference → run `pnpm run verify:file docs/slack-notifications.md`.
