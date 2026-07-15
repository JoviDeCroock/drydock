# Notification telemetry runbook

Notification delivery is best effort and must not change deterministic review or
release-gate state.

1. Resolve the event to its organization and scan/gate correlation ID.
2. Check provider operation, stable code, retryability, and recent organization
   impact without exposing recipient addresses or message content.
3. Confirm the underlying review or decision remains visible in Drydock.
4. Retry only through the bounded notification path; never replay arbitrary
   provider payloads.
