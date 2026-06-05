# Slack notifications

Drydock posts release events to Slack through the **"Add to Slack" OAuth v2 bot
flow**. Each organization connects one Slack workspace and picks exactly one
**public** channel; a completed/failed staged-publish scan and a workflow-gate
"review ready" transition post to that channel. Slack delivery runs alongside the
email recipients, is best-effort, and never blocks scan or gate processing.

Webhook-URL destinations are gone — Slack steers integrators toward OAuth, and a
bot token plus an in-app channel picker is a better fit than asking users to mint
and paste an incoming-webhook URL.

## OAuth scopes

`SLACK_OAUTH_SCOPES` (`server/lib/slack.ts`) requests the minimum for a single
public channel:

- `chat:write` — post messages.
- `chat:write.public` — post to any _public_ channel without first inviting the
  bot. This is why we restrict the picker to public channels: delivery always
  works without an invite step.
- `channels:read` — list public channels for the in-app picker.

## Data model

`organization_slack_connections` (`server/db/schema.ts`, migration
`drizzle/0018_*`) holds one row per organization:

- `team_id` / `team_name` / `bot_user_id` / `scope` — workspace identity returned
  by the OAuth exchange.
- `bot_token_ciphertext` / `bot_token_nonce` — the AES-GCM-encrypted bot token
  (`xoxb-…`) and its per-row nonce. The plaintext token is **never** stored,
  logged, or returned.
- `channel_id` / `channel_name` — the chosen public channel; null until the user
  picks one.
- `enabled` — a disabled connection keeps its token but is skipped by the
  delivery fan-out (`Test` still works after re-enable).
- `created_by_user_id` — the owner/admin who connected the workspace.

Public reads (`getSlackConnection`, `publicConnection`) project only
`{ teamId, teamName, channelId, channelName, enabled, createdAt }`; the token
columns never reach a client. `getSlackConnectionSecret` keeps the
token-bearing read (used by the notifier and the test send) separate from the
public status read.

## Secret handling

`server/lib/secret-box.ts` (`encryptSlackBotToken` / `decryptSlackBotToken`)
mirrors the npm-token scheme: AES-GCM-256 with an HKDF-derived key off the shared
`NPM_CONNECTIONS_ENCRYPTION_KEY` (≥32 chars required), but a **domain-separated**
HKDF salt (`drydock:slack-bot-token:salt:v1`) so the bot-token key can never
decrypt npm tokens and vice-versa. Ciphertext is versioned (`v1:` prefix) for
future rotation. The token is decrypted only in-memory for the POST to Slack.

## OAuth state (CSRF)

There is no `x-organization-id` header on the top-level browser redirect Slack
sends back, so the org binding travels in a signed state token.
`signSlackState` / `verifySlackState` (`server/lib/slack.ts`) HMAC-sign
`{ organizationId, userId, nonce, expiresAt }` with `BETTER_AUTH_SECRET`
(version-tagged `slackv1`, 15-minute TTL). The callback verifies the signature,
that the state's `userId` matches the session, and re-checks the caller's role
against a fresh `getOrganizationRole` lookup before persisting anything.

## Routes

Under `/api/v1/slack` (`server/routes/slack.ts`):

- `GET /` — any member reads `{ configured, connection }` (public shape).
  `configured` reflects whether `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET` are set.
- `POST /connect` — owner/admin. Returns `{ authorizeUrl, expiresInSeconds }`
  carrying the signed state; `503` if Slack is not configured; rate-limited at
  20/hour (`slack:connect:<org>`).
- `GET /callback` — the browser redirect target. Verifies state + session +
  role, exchanges the code via `oauth.v2.access`, encrypts and upserts the token,
  then **always redirects** back to
  `/dashboard/settings?tab=notifications&slack=connected|error&slackError=…` so
  the user never sees raw JSON.
- `GET /channels` — owner/admin. Lists public channels via `conversations.list`
  for the picker; `404` if not connected; rate-limited at 30/min
  (`slack:channels:<org>`).
- `PUT /channel` — owner/admin, body `{ channelId, channelName? }`.
- `PATCH /` — owner/admin, body `{ enabled: boolean }`.
- `DELETE /` — owner/admin. Disconnects the workspace.
- `POST /test` — owner/admin, rate-limited at 10/hour (`slack:test:<org>`).
  Posts a canned message to the chosen channel; `400` if no channel is set,
  `404` if not connected. Returns `{ ok, rateLimited?, reason? }`.

Role gating uses `roleCanManageIntegrations` (owner/admin), matching npm
connections and notification recipients. Members are read-only (`403` on write).

## Delivery

`server/lib/notify.ts` runs email and Slack concurrently. `notifyScanCompletion`
and `notifyWorkflowGateReview` build a `SlackNotificationPayload`, then
`deliverToSlackConnection` loads the org's `getSlackConnectionSecret`, and — only
if the connection exists, is enabled, and has a channel — decrypts the token,
renders one Block Kit message (`renderSlackMessage`), and POSTs it with
`chat.postMessage`. It is isolated from email: a missing connection or a failing
post only records a `notification_failed` event and **never throws**, so it
cannot block scan completion or gate processing. Slack delivery is decoupled from
email recipients — it still fires when no email recipients resolve.

`postSlackMessage` (`server/lib/slack.ts`) is self-contained and best-effort:
Slack returns HTTP 200 with `{ ok: false, error }` for app errors (keyed off
`ok`, not the status), a `429` is surfaced as `rateLimited` with the
`Retry-After` seconds (no automatic retry in v1), the 5s timeout bounds the call,
and the bot token and channel id are never returned in `reason` or thrown.

## Audit events

Recorded via `recordScanEvent` into `scan_events`, all carrying
`metadata.channel = "slack"` plus `channelName` (and `statusClass` /
`rateLimited` / `reason` on failure) — never the token or ciphertext.
`botToken`, `botTokenCiphertext`, `botTokenNonce`, and `accessToken` are in
`SENSITIVE_EVENT_METADATA_KEYS` (`server/db/events.ts`) as belt-and-suspenders
redaction.

- Management: `organization.slack_connected` / `_channel_set` / `_enabled` /
  `_disabled` / `_disconnected` / `_tested` / `_test_failed`.
- Delivery: `scan.notification_sent` / `_failed` and
  `github_workflow_gate.notification_sent` / `_failed` (shared with email,
  distinguished by `metadata.channel`).

## Configuration

The operator registers a Slack app and sets `SLACK_CLIENT_ID` /
`SLACK_CLIENT_SECRET` (`server/env.d.ts`). The OAuth redirect URL resolves from
`BETTER_AUTH_URL` as `/api/v1/slack/callback` (`slackRedirectUri`) and must match
a redirect URL registered in the Slack app. Until both client credentials are
set, `GET /api/v1/slack` reports `configured: false` and the UI explains that
Slack is not configured on this instance.

Because the Worker also serves the Preact app with static-asset SPA fallback,
`wrangler.jsonc` must keep `/api` and `/api/*` in `assets.run_worker_first`.
Otherwise Slack's top-level browser redirect can be claimed by `index.html` and
shown as the client 404 instead of reaching `GET /api/v1/slack/callback`.

## Front end

`src/models/slack-connection.ts` (`SlackConnectionModel`) handles
load/connect/loadChannels/selectChannel/setEnabled/disconnect/test and surfaces
the OAuth callback notice. `SlackConnectionSection.tsx` renders the connection
state — "Add to Slack" when disconnected, the channel picker plus
Test/Pause-Resume/Disconnect controls when connected (owner/admin only) — under
the Settings **notifications** tab next to the email recipients section.

## Tests

- `test/slack.test.mjs` — OAuth config read, redirect-URI/authorize-URL builders,
  `signSlackState` / `verifySlackState` (round-trip, wrong secret, tamper,
  expiry), `exchangeSlackOAuthCode`, `listSlackPublicChannels` (pagination +
  sort, no token echo), `renderSlackMessage` / `renderSlackTestMessage`, and
  `postSlackMessage` success / `ok:false` / 429 / network-error, asserting the
  token never leaks into the result.
- `test/secret-box.test.mjs` — encrypt/decrypt round-trip, whitespace trim,
  fresh-nonce non-determinism, empty/short-key/wrong-key failures.
- `test/notify.test.mjs` — Slack fan-out for scans and gates: redacted events,
  failure/429 metadata, `delivery_error` on decryption failure, silent skip when
  disabled or channel-less, and delivery decoupled from email recipients.
- `test/workers/slack-routes.test.ts` — every route end-to-end with a mocked
  Slack `fetch`: connect/callback/channels/channel/patch/delete/test, OAuth state
  CSRF (forged state, user mismatch, forbidden role), encryption-at-rest, event
  redaction, and the test-send rate limit.
