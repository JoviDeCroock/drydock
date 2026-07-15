# Integration telemetry runbook

Use this runbook for npm registry, GitHub App, workflow callback, Slack, email,
and other external-provider failures.

1. Group by stable error code, provider operation, status class, and deployment.
2. Separate customer configuration from a provider outage or Drydock regression.
3. Verify the durable gate/scan state before retrying. Never approve or publish as
   a recovery action.
4. For callback failures, keep the release held and use the existing idempotent
   redelivery path. Confirm `callback_delivered_at` before declaring recovery.
5. Never attach provider response bodies, callback URLs, tokens, headers, or
   customer package identity to telemetry or support notes.
