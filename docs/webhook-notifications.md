# Webhook notifications

Organizations can configure one outbound HTTPS webhook alongside email and Slack
in **Settings → Notifications**. Owners and admins can save, replace, pause, test,
or remove it; other members can see its hostname and enabled state. This is a
custom JSON integration, suitable for a receiver that forwards alerts to other
services. It does not post Slack or Discord's native message format.

Enter the destination URL and a signing secret of at least 32 characters shared
with your receiver. Use a randomly generated secret. Both values are encrypted
at rest with AES-GCM and a webhook-specific HKDF key derived from
`NPM_CONNECTIONS_ENCRYPTION_KEY`; neither value is returned by the API. Saving a
replacement requires both values again. The receiver must use a public HTTPS
hostname on port 443. URL credentials, fragments, IP literals, and local or
reserved hostnames are rejected. Redirects are never followed. DNS resolution
and network routing remain the Cloudflare Workers platform's boundary, as with
other public-host fetches.

## Events and delivery

The first version sends:

- `scan.completed`: a staged scan completed.
- `scan.failed`: a staged scan failed, with its safe error code.
- `workflow_gate.review_ready`: a GitHub workflow gate is ready for review.
- `notification.test`: a test requested from Settings or the API.

Delivery runs alongside the existing channels even when there are no email
recipients. It is best-effort with a five-second request timeout and no automatic
retries or delivery queue. Any HTTP 2xx response counts as success. HTTP failures,
redirects, timeouts, and network failures do not change a scan or gate decision.
The receiver's response body is not consumed or logged. Pause skips release
notifications while retaining the encrypted configuration.

Each request is a JSON POST with this envelope:

```json
{
  "version": 1,
  "id": "a-unique-delivery-id",
  "type": "scan.completed",
  "createdAt": "2026-09-13T12:00:00.000Z",
  "organizationId": "organization-id",
  "data": {
    "scanId": "scan-id",
    "packageName": "example-package",
    "version": "1.2.0",
    "releaseRisk": "low",
    "dashboardUrl": "https://your-drydock.example/dashboard/scans/scan-id?org=organization-id"
  }
}
```

Failed scans also carry `data.errorCode`; raw failure messages and package
contents are excluded. Workflow events include `gateId`, `scanId`,
`repositoryFullName`, `environment`, `packageName`, `version`, `packageCount`,
`releaseRisk`, and `dashboardUrl`. Release risk is the release-delta risk, matching
the review surface. Package count lets receivers distinguish a bundle from its
headline package. Nullable fields remain null when unavailable. Receivers should
ignore additional fields so future additive changes remain compatible.

## Verify the signature

`X-Drydock-Timestamp` contains the Unix timestamp in seconds.
`X-Drydock-Signature` is `v1=` followed by the hexadecimal HMAC-SHA256 of
`<timestamp>.<raw request body>`, using the configured signing secret.

Verify the signature against the exact received bytes before parsing the JSON.
Use a constant-time comparison, reject stale timestamps (for example, more than
five minutes old), and deduplicate event IDs to prevent replay. Return a 2xx
response promptly after accepting the event. Secret rotation means updating both
Drydock's configuration and your receiver.

## API and audit

The authenticated organization-scoped endpoint is
`/api/v1/notification-webhook`:

| Method       | Body              | Result                                                                       |
| ------------ | ----------------- | ---------------------------------------------------------------------------- |
| GET          | —                 | `{ connection: { hostname, enabled, createdAt } }` or `{ connection: null }` |
| PUT          | `{ url, secret }` | Saves or replaces the encrypted connection                                   |
| PATCH        | `{ enabled }`     | Pauses or resumes delivery                                                   |
| DELETE       | —                 | Removes the connection                                                       |
| POST `/test` | —                 | `{ ok, reason? }`; limited to ten tests per organization per hour            |

Writes and test sends require owner/admin access. Management changes appear in
the organization audit log. Release delivery records use
`scan.notification_sent` / `scan.notification_failed` and
`github_workflow_gate.notification_sent` / `github_workflow_gate.notification_failed`
with `channel: "webhook"`, an event ID and event type, and a safe failure reason.
Endpoint paths, query strings, secrets, signatures, ciphertext, and response
bodies are excluded from event metadata.

## Implementation and checks

- `server/routes/notification-webhook.ts` and `server/db/webhook-connection.ts`
  own configuration and organization-scoped persistence.
- `server/lib/notify/webhook.ts` owns the versioned envelope and signed POST.
- `server/lib/notify/webhook-credentials.ts` owns encryption at rest.
- `server/lib/notify/index.ts` fans out scan and gate events.
- `test/webhook.test.mjs`, `test/notify.test.mjs`, and
  `test/workers/notification-webhook-routes.test.ts` cover signing, destination
  policy, isolation, credentials, authorization, and persistence.
