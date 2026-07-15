# Scanner telemetry runbook

Use this runbook for artifact acquisition, archive parsing, deterministic review,
report persistence, and release-memory failures.

1. Resolve the event to the organization-scoped scan or workflow gate.
2. Check the stable error code, phase, retryability, and fail-closed state.
3. Confirm that no credential entered the sandbox and that no package-derived
   text entered telemetry.
4. Retry only errors classified as retryable. Archive limits, malformed evidence,
   and policy blocks require customer remediation or out-of-band verification.
5. Validate any parser fix with the narrow regression, security corpus, and fake
   registry path before deployment.
