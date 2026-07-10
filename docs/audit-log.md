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
in Workers Logs via `emitOperationalEvent`.

Everything else is still written: `scan.decided`, `github_workflow_gate.*`,
`npm_connection.{upserted,validated,deleted,token_expired}`, `github_app_*`,
`organization.*`, and notification-delivery events.

## Visible allowlist

`server/lib/audit-events.ts` is the single source of truth for the audit view. It
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
type-restricted one.

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
