# Drydock observability proposal

**Status:** proposal  
**Date:** 2026-07-14  
**Scope:** runtime reliability, customer pain, adoption, user journeys, support, and safe LLM access

## Executive recommendation

Drydock should treat observability as a versioned product data contract, not as a collection of log statements.

The goal is that a person or an authorized LLM can answer these questions in minutes, with evidence:

- Is Drydock working for customers right now?
- Which customers are blocked, at what step, and by which stable error code?
- What changed after a deployment?
- Where do organizations abandon setup?
- How long does it take an organization to reach its first protected release?
- Which product paths create repeated value and retention?
- What exactly happened for a support reference, scan, workflow gate, or organization?

The recommended stack is:

1. **D1 remains the exact domain truth.** Add a compact organization-milestone projection for exact first/last value timestamps and counts. Do not turn the organization audit log into product analytics.
2. **Cloudflare Workers Logs and traces hold diagnostic evidence.** Emit one structured JSON object per event, enable source maps and sampled traces, and add custom spans around the scan and workflow-gate phases.
3. **Workers Analytics Engine holds high-cardinality product and service aggregates.** It is appropriate for funnels, rates, durations, and per-organization health trends, but not audit, billing, or exact lifetime facts because it can sample and currently retains data for three months.
4. **A hosted issue tracker is optional, not canonical.** If Cloudflare's error investigation is insufficient, export logs and traces over OTLP to Sentry or an equivalent provider for issue grouping, regressions, ownership, and alerting. Keep the event contract provider-neutral and require an approved data-processing agreement, region, retention policy, and deletion path.
5. **LLMs receive tools, not a log dump.** Use Cloudflare's official Workers Observability MCP for runtime investigation and add a narrow, read-only Drydock tool service for customer health, timelines, funnels, release comparisons, and support-reference lookup.
6. **Production session replay is deferred.** Drydock renders hostile package evidence, so replay creates disproportionate privacy and leakage risk. Start with semantic journey events and the existing local Playwright/agent-tour traces. If replay is added later, use an explicit page allowlist; never record scan/detail, diff, credential, account, 2FA, or organization-settings surfaces; and mask all text and inputs by default.

This produces a useful first version without introducing a warehouse or a large analytics SDK into the critical Worker path.

## What exists today

Drydock already has strong pieces to build on:

- [`server/lib/observability.ts`](../server/lib/observability.ts) emits structured operational events and recursively redacts sensitive-looking keys and bearer values.
- The scan pipeline, queue, scheduled discovery, GitHub webhook, workflow-gate, artifact-storage, and AI-review paths already emit named events.
- [`wrangler.jsonc`](../wrangler.jsonc) enables Workers Logs and invocation logs.
- D1 stores scans, gates, release decisions, integrations, and a 90-day organization audit log in `scan_events`.
- Scan records already contain timestamps, source, status, risk, findings, decisions, safe error JSON, and artifact metadata.
- The UI already shows safe error codes in important paths and exposes a feedback mail link.

The current gaps are structural:

- Operational event payloads are not a typed or versioned contract.
- `console.log(event, payload)` does not make the sanitized payload the sole top-level structured log object.
- Events do not consistently include an event ID, deployment/release, request or journey ID, phase, outcome, customer visibility, or error fingerprint.
- `describeOperationalError()` includes arbitrary error messages. Key-based token redaction is valuable but cannot prove that registry responses, package names, URLs, or package-derived text never enter telemetry.
- Runtime events are rich around scan execution but sparse around setup, activation, collaboration, feedback, and customer recovery.
- There is no exact organization-milestone projection, adoption funnel, health view, or support timeline.
- Logs can correlate by `scanId`, `gateId`, and `organizationId` in some paths, but there is no single correlation model across browser requests, queue work, webhooks, scheduled discovery, and notifications.
- Logs are enabled, but traces and source-map upload are not configured.
- The audit log is intentionally curated for customer-visible administrative history. Reusing it for high-volume telemetry would weaken both purposes.

## Principles

### Observe customer value, not page views

The primary adoption signals should be server-confirmed domain outcomes: an integration validated, a release target created, a scan completed, a gate review became ready, a release decision was delivered, or a teammate accepted an invitation.

UI events are useful for finding friction between those outcomes, but should not define activation or retention.

### Preserve four distinct records

| Record                | Purpose                                      | Store                            | Exact?                        | Customer-visible?      |
| --------------------- | -------------------------------------------- | -------------------------------- | ----------------------------- | ---------------------- |
| Domain state          | What is true now                             | D1 core tables                   | Yes                           | Through product UI/API |
| Audit event           | Who changed an important setting or decision | D1 `scan_events`                 | Yes, within retention         | Yes, curated           |
| Operational telemetry | Why and where execution succeeded or failed  | Workers Logs/traces              | Subject to retention/sampling | No                     |
| Product analytics     | How cohorts adopt and receive value          | Analytics Engine + D1 milestones | Aggregate; milestones exact   | No                     |

One action may update more than one record, but each record has a different schema and retention policy.

### Make every failure classifiable

Every customer-visible failure should have:

- a stable `error.code` from a registry;
- `error.class`: `product_bug`, `customer_configuration`, `external_dependency`, `policy_block`, or `expected_control_flow`;
- `error.phase`, such as `auth`, `integration_validation`, `artifact_acquisition`, `archive_parse`, `deterministic_review`, `ai_review`, `persistence`, `notification`, or `decision_callback`;
- `error.retryable` and `error.customer_visible`;
- a deterministic `error.fingerprint`;
- an opaque support `reference_id` shown to the user;
- an owner/runbook mapping.

Raw exception messages are diagnostic input, not identifiers. Unknown exceptions should become `internal.unclassified` plus a source-mapped stack in the restricted error sink; they should not send arbitrary messages or local variables to product analytics.

### Make telemetry safe by construction

Use explicit event schemas and per-sink allowlists rather than attempting to redact arbitrary objects after the fact. Sanitization remains a final defense.

Never emit:

- authorization, cookies, tokens, secrets, ciphertext, nonces, or token fingerprints;
- package file contents, diffs, manifests, AI prompts/responses, or finding evidence;
- request/response bodies or headers;
- package-derived error text or unbounded external-provider responses;
- email addresses, names, IP addresses, or raw user-agent strings;
- full registry or artifact URLs;
- free-form release decision reasons or customer feedback text;
- third-party trace baggage containing organization or user identity.

Opaque internal `organizationId`, `scanId`, and `gateId` values may appear in restricted operational telemetry for correlation. Product analytics should use a separately keyed pseudonymous organization identifier. User identifiers should be one-way pseudonyms outside D1.

## Canonical event contract

Create a discriminated TypeScript union under `server/lib/telemetry/` and make all sinks accept only that union. The shape below is conceptual; the implementation should flatten fields where the destination queries more efficiently.

```json
{
  "event": {
    "id": "evt_01...",
    "name": "scan.pipeline.failed",
    "version": 1,
    "occurred_at": "2026-07-14T09:42:11.120Z"
  },
  "severity": "error",
  "service": {
    "name": "drydock-worker",
    "version": "git-sha-or-worker-version",
    "environment": "production"
  },
  "correlation": {
    "request_id": "req_01...",
    "journey_id": "jny_01...",
    "scan_id": "scan_01...",
    "gate_id": null,
    "delivery_id": null
  },
  "tenant": {
    "organization_id": "org_01..."
  },
  "actor": {
    "kind": "user",
    "id_hash": "usrh_..."
  },
  "product": {
    "surface": "manual_scan",
    "ecosystem": "npm",
    "phase": "artifact_acquisition"
  },
  "outcome": {
    "status": "failure",
    "error_code": "registry.auth.insufficient_scope",
    "error_class": "customer_configuration",
    "error_fingerprint": "v1:...",
    "retryable": false,
    "customer_visible": true
  },
  "measurements": {
    "duration_ms": 412,
    "attempt": 1
  }
}
```

Contract rules:

- Event names use `domain.object.past_tense_outcome` and never embed values.
- Every event declares its schema version; incompatible changes create a new version.
- Dimensions are enumerated strings with bounded cardinality, except explicitly documented opaque correlation IDs.
- Durations use milliseconds and counts are numeric.
- The deployment identifier is present on every event so release regressions are queryable.
- Error fingerprints are produced by code, never by an LLM.
- The typed schema defines the fields allowed in each sink: logs, traces, Analytics Engine, audit, and support.
- Contract tests serialize every event variant and assert that denied keys and representative secrets cannot escape.

Suggested layout:

```text
server/lib/telemetry/
  context.ts       request, organization, actor, release, and correlation context
  events.ts        versioned event union and event-name registry
  errors.ts        stable error catalog, classification, ownership, and fingerprints
  emit.ts          sink projection and final sanitization
  analytics.ts     Analytics Engine ordered-column mapping
  milestones.ts    exact D1 milestone upserts
test/telemetry-contract.test.mjs
docs/observability.md
docs/runbooks/
```

## Correlation and tracing

Use two complementary correlation mechanisms.

### Platform trace

Enable Cloudflare tracing with a conservative production head sample, initially 10%, and 100% in staging. Cloudflare automatically traces handler invocations and supported binding/fetch operations. Add custom spans around meaningful phases:

```text
request
  authenticate
  resolve_active_organization
  enqueue_scan

queue scan job
  claim_scan
  acquire_staged_artifact
  acquire_baseline
  parse_archive
  deterministic_review
  release_memory_lookup
  ai_review
  persist_report
  notify

workflow gate job
  load_gate
  download_artifact_bundle
  prepare_release_candidates
  review_packages
  await_human_decision
  deliver_github_callback
```

Only attach bounded attributes such as adapter, ecosystem, source, phase, result, counts, safe error code, and opaque IDs. Do not attach package names, paths, evidence, URLs, or free text.

### Application journey

Platform traces cannot represent a multi-day setup journey, and Cloudflare's current custom-span API does not expose manual trace-ID wiring across arbitrary boundaries. Add an application-owned `journey_id` and carry it through authenticated UI requests, queued messages, webhook-created gates, notifications, and feedback references where meaningful.

Use the most specific durable correlation key:

- request: `request_id`;
- scan lifecycle: `scan_id`;
- workflow-gate lifecycle: `gate_id` and GitHub `delivery_id`;
- organization setup: `journey_id` scoped to the setup path;
- support: `reference_id` resolving to the safe event/timeline context.

Do not put organization or user identity in generic OpenTelemetry baggage. Baggage can be propagated to third parties; use explicit application fields and destination allowlists instead.

## Customer journey model

The first journey model should be small enough that every event has a clear decision attached to it.

### Acquisition and account creation

- registration completed;
- email verified;
- first organization created;
- invited member accepted.

Anonymous marketing attribution should remain separate from authenticated product telemetry. Do not weaken the repository rule that non-auth `/api/*` endpoints require authentication. If anonymous attribution becomes important, add a separately threat-modeled, rate-limited, allowlisted collector or privacy-preserving web analytics product.

### Setup

- setup path selected: npm staged publish or GitHub workflow gate;
- npm connection save attempted, validated, failed, or deleted;
- GitHub App installation started and completed;
- release target created and first webhook observed;
- Slack connected and test notification delivered;
- notification recipient added;
- 2FA requirement enabled.

Each failed setup event needs an actionable error code and a link to the exact remediation shown in the UI.

### Activation

Define activation as the first **protected release**, not sign-up or first page view.

An organization is activated when it reaches either:

1. a completed manual/auto-discovery scan that a maintainer views and records a release decision against; or
2. a workflow-gate review that reaches `review_ready` and successfully delivers a decision callback to GitHub.

Track:

- time from account creation to valid integration;
- time from valid integration to first artifact observed;
- time from first artifact to first completed review;
- time from completed review to decision;
- total time to first protected release;
- activation within 1 day and 7 days.

### Repeated value and retention

The value event is `protected_release.completed`. It should be emitted only from server-confirmed state and include path, ecosystem, source, outcome, risk band, finding-count band, and duration—not package identity or evidence.

Measure:

- weekly organizations with at least one protected release;
- protected releases per active organization;
- organizations with protected releases in 2, 4, and 8 distinct weeks;
- week-1 and week-4 retained organizations by acquisition cohort and setup path;
- median and p95 decision latency;
- expansion into a second release target, ecosystem, or teammate;
- automation share: scheduled discovery/workflow gate versus manual scans.

### Friction and recovery

Track these as first-class journey events:

- repeated integration validation failures;
- artifact observed but no review completed;
- completed review never viewed or decided;
- workflow gate timed out or callback delivery failed;
- three consecutive customer-visible failures;
- feedback opened/submitted;
- support reference created;
- the next successful value event after a failure (`customer.recovered`).

Recovery is as important as failure count. It tells us whether remediation actually works.

## Adoption and customer-health metrics

### North star

**Weekly protected-release organizations:** distinct organizations that completed at least one review-to-decision or gate-to-callback loop in the last seven days.

This measures delivered customer value while avoiding vanity activity. Keep the raw protected-release count as a supporting throughput metric.

### Funnel

```text
organization created
  -> integration valid
  -> first artifact observed
  -> first review completed
  -> first protected release
  -> second active week
  -> fourth active week
```

Break the funnel down by setup path, ecosystem, acquisition cohort, organization size band, and deployment version. Do not use package identity as an analytics dimension.

### Transparent customer-health state

Do not begin with an opaque ML or LLM health score. Materialize a small set of facts and a rule-based state that people and agents can explain:

```text
setup:
  npm_connection_valid
  github_installation_active
  release_target_count
  notifications_configured

value:
  first_protected_release_at
  last_protected_release_at
  protected_releases_7d / 28d
  active_weeks_8w

friction:
  customer_visible_failures_7d
  consecutive_failed_value_attempts
  blocked_since
  last_error_code

collaboration:
  member_count
  accepted_invites_28d
```

Suggested states:

- `onboarding`: created but not activated;
- `activated`: first protected release within the last seven days;
- `healthy`: repeated value and no unresolved blocking signal;
- `blocked`: last three value attempts failed or a gate decision cannot be delivered;
- `at_risk`: previously active but no value event for 14 days, or error rate materially increased;
- `dormant`: no value event for 30 days.

Expose the facts and the matched rule whenever a state is shown. An LLM may summarize the state; it must not invent the state.

### Exact milestone projection

Create an `organization_milestones` D1 table keyed by `(organization_id, milestone)` with `first_at`, `last_at`, and `count`. Update it idempotently in the same domain functions that create the underlying durable state, in the same D1 batch where possible. Treat it as a rebuildable projection rather than a second source of truth; add backfill and periodic reconciliation from the core tables.

Use it for exact activation, support, and lifecycle queries. Use Analytics Engine for time-series breakdowns and rates. Generate daily cohort rollups into D1 if trends longer than Analytics Engine's three-month retention are needed.

## Data retention and pruning

Telemetry must not flood D1. Every store this proposal adds declares a retention window and a pruning path up front; no telemetry table is allowed to grow unbounded. The existing precedent is `pruneAuditEventsOlderThan` running on each scheduled tick ([`docs/audit-log.md`](./audit-log.md)); new stores follow the same pattern.

| Store | Growth shape | Retention | Wipe mechanism |
| --- | --- | --- | --- |
| D1 domain state (scans, gates, decisions) | Product data | Product lifecycle | Existing org/scan cascade and account deletion |
| D1 `scan_events` (audit) | Append-only | 90 days (existing) | Existing scheduled prune |
| D1 `organization_milestones` | One row per (organization, milestone) — bounded by design | Lifetime of the organization | Org cascade delete; no age prune needed |
| D1 daily cohort/health rollups | One row per org/cohort per day | 13 months (one year of trends plus comparison margin) | Age prune on scheduled tick |
| D1 support references / incident bundles | Append-only | 90 days, matching the audit window | Age prune on scheduled tick |
| Workers Logs / traces | Platform-managed | Platform retention | None needed |
| Analytics Engine | Platform-managed | 3 months, platform-enforced | None needed |

Rules:

- Pruning piggybacks on the existing `scheduled` handler: age-based `DELETE` in bounded batches (`LIMIT`) so a large backlog can never stall a tick, emitting a `telemetry.pruned` event with row counts, and an error event if a prune fails.
- Add a cheap row-count guard per telemetry table on a daily tick with an alert threshold. A runaway writer (the `file.outside-files-list`-style flood, but in telemetry) should page before it becomes a storage or query-latency problem, not after.
- All org-keyed telemetry participates in organization cascade delete and the account-deletion path ([`docs/account-deletion.md`](./account-deletion.md)); pseudonymous product-analytics identifiers are unlinkable after key deletion.
- The schema PR for any new telemetry table must state its retention window and include prune coverage in tests; add this to the [`docs/release-safety.md`](./release-safety.md) checklist alongside the existing "operational events exist and carry no sensitive material" item.

## Reliability, SLOs, and alerts

Define success from the maintainer's perspective. A fail-closed, actionable verdict on a malformed or unsafe artifact can be a successful product outcome even though the release is blocked.

Initial service-level indicators:

| Indicator              | Good event                                                                     | Initial objective                                  |
| ---------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------- |
| API availability       | authenticated request completes without a product-bug/5xx outcome              | 99.9% over 28 days                                 |
| Review completion      | accepted scan reaches completed review or actionable fail-closed verdict       | 99.5% over 28 days                                 |
| Review latency         | enqueue to terminal review                                                     | p95 under 2 minutes; validate with production data |
| Gate callback delivery | recorded decision is accepted by GitHub                                        | 99.9% over 28 days                                 |
| Discovery continuity   | eligible npm connection receives a completed sweep                             | within 30 minutes                                  |
| Notification delivery  | requested notification reaches provider or returns an actionable provider code | 99% over 28 days                                   |

Keep AI-review availability separate. It is advisory and its killswitch/fail-safe behavior must not make the deterministic scanner's SLO misleading.

Alert on impact rather than individual exceptions:

- fast and slow multi-window burn alerts for the first four SLIs;
- any credential/sandbox security invariant violation immediately;
- a new `product_bug` fingerprint after a deployment;
- an error-code rate or p95 latency regression by deployment version;
- a customer-visible error affecting multiple organizations in a short window;
- one organization blocked on three consecutive value attempts;
- a cron without its matching completion event;
- queue retries exhausted or messages reaching the dead-letter queue;
- telemetry sink health, schema rejections, or missing deployment identifiers.

During the early customer phase, alert on every newly blocked organization. Revisit thresholds only after volume makes that noisy.

## Error and support workflow

### User experience

Every error surface should show:

- a plain-language explanation;
- a stable error code;
- the next action the customer can take;
- a copyable support reference;
- retry status when relevant.

The support reference must not encode an organization, user, scan, or secret. It resolves server-side for authorized staff.

Replace the context-free feedback mail link on authenticated pages with a small feedback flow that attaches only safe context: reference ID, route name, client release, organization ID, scan/gate ID, and recent stable event codes. Free-text feedback is stored or sent as support content, never copied into operational telemetry or LLM prompts by default.

### Issue grouping

Group deterministic fingerprints such as:

```text
error.code + error.phase + service.version + top_application_frame
```

For external dependencies, prefer:

```text
error.code + provider + status_class + operation
```

Track per issue:

- first and last seen;
- first and last affected deployment;
- occurrence count;
- distinct impacted organizations;
- blocked value attempts;
- owner and runbook;
- triage status;
- fixed deployment;
- recovered organizations.

This can live in Sentry or an equivalent issue product if adopted. Drydock's stable code, fingerprint, and impact fields remain the source contract so provider replacement is possible.

### Customer timeline

Support should have one chronological, sanitized view that combines:

- milestone and integration state from D1;
- curated audit actions;
- scans, gates, decisions, and notifications;
- customer-visible operational errors;
- deployment changes;
- feedback/support references;
- subsequent recovery.

Do not copy package contents or raw log lines into this timeline.

## LLM-ready observability

An LLM works best with bounded, typed, correlated evidence. It works poorly with screenshots, arbitrary log strings, unexplained fields, and unconstrained SQL.

### Tool layer 1: Cloudflare Workers Observability MCP

Connect authorized engineering agents to Cloudflare's official Workers Observability MCP. It can discover log fields and values, query events, calculate metrics, and locate invocations. This is the fastest path to questions such as:

- What errors appeared after the latest deployment?
- Which phase dominates p95 scan time?
- Find the invocation for this support reference.
- Compare error rates between two Worker versions.

This becomes substantially more useful after events are emitted as a single structured object with stable fields.

### Tool layer 2: Drydock observability tools

Add a read-only internal service or MCP server with parameterized tools:

- `get_service_health(window)`
- `get_customer_health(organization_id)`
- `get_customer_timeline(organization_id, start, end)`
- `explain_support_reference(reference_id)`
- `get_adoption_funnel(start, end, cohort, path)`
- `get_retention(cohort, interval)`
- `list_customer_pain(window, minimum_organizations)`
- `compare_deployments(before_version, after_version, window)`
- `get_scan_or_gate_timeline(id)`
- `get_runbook(error_code)`

Do not expose arbitrary SQL, raw D1, raw R2, package evidence, or unrestricted log search to the LLM. Tool authorization must be staff-only, organization-aware where appropriate, read-only, audited, rate-limited, and able to redact fields again at the response boundary.

Every tool response should include:

```json
{
  "generated_at": "...",
  "window": { "start": "...", "end": "..." },
  "freshness_seconds": 42,
  "sampled": false,
  "sources": ["d1", "workers_logs"],
  "query_id": "qry_01...",
  "facts": [],
  "missing_evidence": [],
  "links": []
}
```

The LLM must cite `query_id`, event/reference IDs, and deployment versions in incident summaries. It should say when evidence is sampled, stale, missing, or conflicting.

### Deterministic incident bundle before prose

For a support reference or alert, produce a compact incident bundle in code:

```text
identity        support ref, organization, scan/gate, deployment
impact          affected organizations and blocked value events
timeline        ordered event IDs and stable codes
first change    deployment/configuration boundary before the issue
current state   active, recovered, or unknown
runbook         owner and next deterministic checks
evidence gaps   missing/sampled/unavailable sources
```

Let the model explain this bundle. Do not ask the model to discover facts by reading an unbounded log stream.

### Golden-question eval

Add fixtures and an automated eval for questions the system must answer correctly:

- Why did this scan fail?
- Did the customer recover?
- Which organizations are blocked by the same issue?
- Did deployment B regress against deployment A?
- Where does the npm setup funnel lose organizations?
- Was the gate reviewed but the callback not delivered?
- Is a rise in failures a product bug, customer configuration problem, external outage, or expected fail-closed behavior?

Fixtures should contain distractor events and forbidden data. The eval must check evidence selection, uncertainty, authorization, and redaction—not just prose quality.

## Dashboards and operating cadence

Start with five views:

1. **Service health:** request/review/gate SLOs, error budget, queue depth/retries, p50/p95 duration by phase and deployment.
2. **Customer pain:** blocked organizations, customer-visible error codes, consecutive failures, unresolved support references, and recovery rate.
3. **Adoption:** funnel, time to first protected release, weekly protected-release organizations, cohort retention, automation share, and expansion.
4. **Journey explorer:** one organization's sanitized chronological path across setup, artifact, review, decision, notification, and recovery.
5. **Release comparison:** before/after deployment volume, failure rate, error fingerprints, latency, and affected organizations.

Operating rhythm:

- real-time: invariant, SLO-burn, blocked-customer, and new-regression alerts;
- daily: LLM-drafted digest of new issues, affected customers, recoveries, and funnel anomalies, approved from linked evidence;
- weekly: product/reliability review of north-star, activation, retention, top pain, and error-budget burn;
- per deployment: automatic 30-minute and 24-hour comparison against the prior version;
- monthly: telemetry-schema review, redaction tests, retention/deletion audit, and unused-event cleanup.

## Delivery plan

### Phase 0: make current telemetry queryable (2-3 days)

- Change operational logging to emit one top-level JSON object.
- Add `event.id`, schema version, deployment version, environment, outcome, phase, and stable error code fields.
- Remove arbitrary error messages from normal telemetry; retain source-mapped exceptions only in the restricted diagnostic path.
- Enable source-map upload.
- Enable traces at 100% in staging and an initial 10% in production.
- Add custom spans around the existing scan pipeline and workflow-gate phases.
- Connect the Cloudflare Workers Observability MCP for authorized engineers.
- Save the first service-health, release-regression, and customer-error queries.
- Add telemetry contract/redaction tests.

Exit criterion: an engineer or agent can locate a failed scan by support reference and produce a phase-by-phase evidence trail without changing instrumentation.

### Phase 1: customer value and adoption (about 1 week)

- Add the typed event and error registries.
- Add the Analytics Engine binding and explicit ordered schema mapping.
- Add `organization_milestones` with idempotent domain-level updates.
- Instrument integration validation, first artifact, review, decision/callback, invitation, notification, and recovery events.
- Add an authenticated, allowlisted UI-event endpoint only for the few interaction gaps the server cannot observe.
- Build the adoption funnel, north-star, customer-pain, and journey views.
- Add support references to customer-visible errors and feedback.

Exit criterion: activation, time-to-value, retention, top customer pain, and one organization's journey are answerable from server-confirmed data.

### Phase 2: proactive operations and LLM tools (about 1 week)

- Define SLIs/SLOs and multi-window alerts.
- Add blocked-customer and silent-cron/queue monitors.
- Implement the narrow Drydock read-only tool service.
- Add incident-bundle generation and golden-question evals.
- Add release comparison and daily evidence-linked digest.
- Decide whether Cloudflare investigation is sufficient or an OTLP issue backend is justified.

Exit criterion: the system detects a regression, identifies affected organizations, links the deployment, and drafts an evidence-backed triage summary without raw data access.

### Phase 3: learn and deepen

- Tune sampling and retention from measured volume and cost.
- Add longer-term D1 daily cohort rollups.
- Add privacy-reviewed anonymous attribution only if it changes acquisition decisions.
- Consider restricted session replay only for explicitly allowlisted, non-sensitive surfaces.
- Add automated customer recovery follow-up and product experiments with explicit success metrics.

## Success criteria

Within one month of implementation:

- at least 95% of customer-visible failures carry a stable code, phase, classification, support reference, and owner;
- 100% of scans and workflow gates have a queryable end-to-end application timeline;
- activation and retention are computed from server-confirmed value events;
- support can answer “what happened?” from a reference in under two minutes;
- deployment regressions are attributable by version within five minutes of alerting;
- customer health always shows its underlying facts and matched rule;
- no telemetry contract test can emit a representative secret, package content, external response body, or free-form decision reason;
- LLM eval answers cite evidence and refuse or qualify conclusions when data is missing or sampled.

## Explicit non-goals

- Do not replace the organization audit log with analytics.
- Do not store package evidence in analytics or error vendors.
- Do not make the AI reviewer responsible for operational triage.
- Do not let an LLM assign canonical error classes, fingerprints, customer-health states, or incident severity.
- Do not give an LLM arbitrary production SQL, R2 access, or mutation tools.
- Do not use page views as the north star.
- Do not add production session replay to scan/diff surfaces.
- Do not build a large data warehouse before the event contract and operating questions are stable.

## References

Current Drydock implementation:

- [`server/lib/observability.ts`](../server/lib/observability.ts)
- [`server/lib/scan-pipeline.ts`](../server/lib/scan-pipeline.ts)
- [`server/lib/scan-job.ts`](../server/lib/scan-job.ts)
- [`server/lib/workflow-gate-job.ts`](../server/lib/workflow-gate-job.ts)
- [`server/db/schema.ts`](../server/db/schema.ts)
- [`docs/release-safety.md`](./release-safety.md)
- [`docs/audit-log.md`](./audit-log.md)

Platform references:

- [Cloudflare Workers observability](https://developers.cloudflare.com/workers/observability/)
- [Cloudflare Workers structured logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
- [Cloudflare Workers custom spans](https://developers.cloudflare.com/workers/observability/traces/custom-spans/)
- [Cloudflare Workers source maps](https://developers.cloudflare.com/workers/observability/source-maps/)
- [Cloudflare OpenTelemetry export](https://developers.cloudflare.com/workers/observability/exporting-opentelemetry-data/)
- [Cloudflare Workers Analytics Engine](https://developers.cloudflare.com/analytics/analytics-engine/)
- [Cloudflare Analytics Engine limits and retention](https://developers.cloudflare.com/analytics/analytics-engine/limits/)
- [Cloudflare Workers Observability MCP](https://github.com/cloudflare/mcp-server-cloudflare/tree/main/apps/workers-observability)
- [OpenTelemetry semantic conventions](https://opentelemetry.io/docs/specs/semconv/)
- [OpenTelemetry baggage security considerations](https://opentelemetry.io/docs/concepts/signals/baggage/#baggage-security-considerations)
