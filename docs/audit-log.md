# Organization audit log

The `scan_events` table doubles as the per-organization audit log. Owners and
admins read it from **Settings → Audit log**; it records who changed what across
release decisions, membership, security policy, and integrations.

## Data

`scan_events` (`server/db/schema.ts`) is the store. Every row is org-scoped
(`organizationId` NOT NULL, cascade-delete with the org), carries an optional
`actorUserId` (SET NULL on user delete), an event `type`, JSON `metadataJson`,
and `createdAt`. The `scan_events_org_created_idx` index backs the newest-first,
org-scoped read.

Writes go through `recordScanEvent` (`server/db/events.ts`). The table is
append-only in normal operation — the only delete paths are org/scan cascade and
retention (below).

## What is and isn't recorded

Scan **lifecycle** churn (`scan.started`, `scan.queued`, `scan.backgrounded`,
`scan.completed`, `scan.failed`, `scan.skipped`, `scan.retryable_failed`,
`scan.viewed`) and **discovery** churn (`npm_connection.used`,
`staged_publishes.scans_started`) are **no longer recorded** — they were ~97% of
all rows and carried no audit value. Operational visibility for those still lives
in Workers Logs via `emitOperationalEvent`, and the _measurable_ part of them —
volume, latency, failure rate — lives in Analytics Engine via
`recordProductEvent`. See [`product-analytics.md`](./product-analytics.md):
Workers Logs is a short-retention debugging stream, so without that counter the
removal left scan volume and failure rate unanswerable rather than just
un-audited.

Everything else is still written: `scan.decided`, `github_workflow_gate.*`,
`npm_connection.{upserted,validated,deleted,token_expired}`, `github_app_*`,
`organization.*`, and notification-delivery events.

Guided GitHub gate setup records successful environment creation, protection-rule
enablement, and workflow pull-request creation. These events contain only the
validated repository/environment identity needed for a useful audit description.
Preview-only reads, already-configured results, and failed mutations do not add
audit rows; installation tokens, GitHub response bodies, and generated workflow
bytes are never audit metadata.

## Visible allowlist

`server/lib/auth/audit-events.ts` is the single source of truth for the audit view. It
maps each surfaced `type` to a category (`release_decision`, `member`,
`security`, `integration`, `organization`), a human label, a severity, and a
redaction-safe `summarize()` that derives a short detail line from metadata.

Types not in the registry are hidden from the view even though they are persisted
— notification-delivery and internal gate-processing events are intentionally
excluded as noise. `AUDIT_VISIBLE_TYPES` scopes the query so hidden types never
leave the Worker.

## API

`GET /api/v1/audit-events` (`server/routes/audit.ts`), owner/admin only
(`roleCanManageMembers`), org resolved from the active-organization header like
the other org-scoped routes. Query params: `limit` (default 50, max 100) and
`cursor` (`<createdAtMs>:<id>`, keyset pagination, newest first).

Metadata never leaves the Worker: each row is reduced to
`{ id, type, category, label, severity, detail, createdAt, scanId, actor }`. Raw
`metadataJson` is dropped, and `redactScanEventForClient`'s sensitive-key set
still applies to anything the summarizer reads.

## Retention

Flat 90-day window (`AUDIT_LOG_RETENTION_DAYS`). `pruneAuditEventsOlderThan`
(`server/db/audit-log.ts`) runs each scheduled tick from the Worker's `scheduled`
handler, after the discovery sweep. Because lifecycle/discovery churn is no
longer written, retention is a single age sweep across all rows rather than a
type-restricted one. The sweep's bare `createdAt` predicate is backed by the
`scan_events_created_idx` index, so it never scans the whole table.

The same tick also prunes expired Better Auth rows (`pruneExpiredAuthRows`,
`server/db/auth-retention.ts`), which the Drizzle adapter never removes on its
own: `session` otherwise grows with every sign-in and keeps each dead session's
`ip_address` and `user_agent` forever, and `verification` accumulates consumed or
abandoned email-verification and password-reset values. A row is deleted only
once its own `expires_at` is more than `AUTH_ROW_RETENTION_GRACE_MS` (one day)
in the past, which keeps the sweep clear of Better Auth's session refresh. This
cannot sign anyone out — an expired row already authenticates nothing. Both
prunes are wrapped so a failure is logged (`audit_events.prune_failed`,
`auth_rows.prune_failed`) and never aborts the cron.

## UI

The **Audit log** tab in organization settings
(`src/pages/Dashboard/Settings/AuditLogSection.tsx`, model
`src/models/audit-log.ts`) is rendered only for owners/admins; members never see
the tab and the endpoint 403s them. The tab shows a paginated, newest-first
timeline with a category badge, label, detail, actor, timestamp, and a deep-link
to the originating scan when present.

## Tests

`test/workers/audit-events-route.test.ts` covers visible-only filtering, metadata
non-leakage, org scoping, cursor pagination, and the member-403 / admin-200 role
gate.
