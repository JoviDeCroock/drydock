# Observability

Drydock observability is a versioned product data contract. D1 remains the exact
domain truth, the organization audit log remains a curated customer-visible
record, Workers Logs and traces carry restricted diagnostic evidence, and
Workers Analytics Engine receives bounded aggregate dimensions.

The design and remaining roadmap are in
[`observability-proposal.md`](./observability-proposal.md).

## Runtime event contract

All operational producers call `emitOperationalEvent` through
[`server/lib/observability.ts`](../server/lib/observability.ts). Event names are
registered in `server/lib/telemetry/events.ts`; an unregistered name fails
typechecking.

Each console call receives one JSON object containing:

- an opaque event ID, registered name, schema version, and occurrence time;
- severity plus service version and environment from the Worker version binding;
- request, journey, scan, gate, delivery, and organization correlation where
  available;
- a bounded surface, ecosystem, and phase;
- a success, failure, retry, or skipped outcome;
- a stable error code, class, fingerprint, retryability, customer visibility,
  owner, runbook, and opaque support reference for customer-visible failures;
- allowlisted numeric measurements and bounded scalar dimensions.

Unknown exceptions become `internal.unclassified`. Arbitrary exception messages
are not copied to telemetry. Cloudflare's source-mapped runtime stack is the
restricted diagnostic evidence for an uncaught exception.

## Data safety

The log and Analytics Engine projectors use explicit allowlists. They reject
package names, stage IDs, paths, URLs, headers, bodies, external response detail,
free-form reasons and messages, identities, credentials, token fingerprints,
package contents, manifests, evidence, AI prompts, and AI responses. Recursive
sanitization is retained as a final defense.

Opaque organization IDs exist only in restricted operational logs. Analytics
Engine uses a SHA-256 pseudonym keyed by `TELEMETRY_HASH_KEY`; no analytics write
occurs when that secret is absent. Rotating or deleting the key breaks the link
to an organization.

Contract tests in `test/observability.test.mjs` include representative denied
fields and secrets. Add a test whenever a producer needs a new field; do not
weaken the denied-key policy to make a free-form value convenient.

## Correlation and traces

The Worker creates a request ID for HTTP, scheduled, and queue invocations.
Authenticated browser journeys may send an opaque `x-drydock-journey-id` in the
form `jny_<8-128 safe characters>`; invalid values are discarded. Queue and
domain events continue to use durable scan and gate IDs across invocations.

Automatic traces run at a 10% production head sample. Source-map upload is
enabled. Custom spans wrap baseline resolution, diffing, deterministic review,
AI review, release-memory lookup, report persistence, gate loading, candidate
preparation, and package review. Span attributes contain only bounded ecosystem,
count, and opaque internal IDs.

Use a separate staging Wrangler configuration with
`observability.traces.head_sampling_rate` set to `1` when full staging traces are
required.

## Analytics Engine schema

`TELEMETRY_ANALYTICS` writes one point per operational event. Columns are ordered
and append-only:

- blobs: event name, deployment, environment, severity, surface, ecosystem,
  phase, outcome, error code, error class, retryable, customer-visible;
- doubles: duration milliseconds, attempt, count;
- index: keyed organization pseudonym, or `anonymous` when no organization is
  associated with the event.

Do not reorder columns. Analytics Engine is for funnels, rates, durations, and
deployment comparisons, not billing, audit, or exact lifetime facts.

## Exact organization milestones

`organization_milestones` is a bounded D1 projection with one row per
organization and milestone. Each row records exact `first_at`, `last_at`, and
`count` values and cascades with organization deletion. Current durable
milestones are:

- organization created;
- integration validated;
- artifact observed;
- review completed;
- protected release completed.

A manual scan becomes a protected release when its decision is recorded. A
workflow gate becomes one only after GitHub accepts the callback. The gate row's
`callback_delivered_at` CAS prevents retries and redeliveries from double
counting the milestone. Manual decisions use the equivalent
`protected_release_recorded_at` CAS, so editing a recorded decision does not
create another value event.

The midnight UTC scheduled tick reconciles the projection from organizations,
current valid npm connections, completed scans, decisions, and delivered
workflow-gate callbacks. This populates existing tenants after migration and
repairs missed writes. Validation history older than the current connection row
cannot be reconstructed, so reconciliation never replaces a richer live
validation count.

## Operator setup

Create the pseudonym key as a secret:

```sh
openssl rand -base64 32 | pnpm exec wrangler secret put TELEMETRY_HASH_KEY
```

The checked-in Wrangler configs enable logs, 10% traces, source maps, version
metadata, and the `drydock_telemetry` Analytics Engine dataset. Deploy only after
applying the checked-in D1 migrations.

Start investigations from a support reference, scan ID, gate ID, request ID, or
deployment version. Treat logs and analytics as sampled evidence; use D1 domain
state and milestones for exact customer lifecycle facts.
