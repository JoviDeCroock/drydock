# Platform telemetry runbook

Use this runbook for `product_bug` events, request failures, queue exhaustion,
cron failures, persistence failures, and telemetry-sink failures.

1. Locate the event by support reference, event ID, request ID, scan/gate ID, or
   deployment version.
2. Compare the error fingerprint and rate with the previous deployment.
3. Follow the correlated custom spans and find the first failing application
   phase. Do not copy raw request, package, or provider content into an incident.
4. Confirm whether durable D1 state is complete, retryable, or fail-closed.
5. Roll back or disable the affected optional path when the new deployment is
   causal; preserve deterministic scanning and release holds.

Escalate any missing deployment ID, unclassified error spike, or telemetry event
containing a denied field as an observability incident.
