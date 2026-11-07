# Organization audit log

The `scan_events` table doubles as the per-organization audit log, read by owners and admins in Settings → Audit log. **Authority:** enforced (owner/admin only). **Owner:** `server/lib/auth/audit-events.ts` (visible allowlist), `server/routes/audit.ts` (API).

## At a glance

| Thing | Owner file | Who may call / trigger | Pinned by |
| --- | --- | --- | --- |
| Store | `scan_events` in `server/db/schema.ts` | — | — |
| Writes | `recordScanEvent` in `server/db/events.ts` | Server routes and jobs | Per-feature Worker tests |
| Visible allowlist | `server/lib/auth/audit-events.ts` (`AUDIT_VISIBLE_TYPES`) | — | `test/workers/audit-events-route.test.ts` |
| Read API | `GET /api/v1/audit-events` in `server/routes/audit.ts` | Owner/admin (`roleCanManageMembers`) | `test/workers/audit-events-route.test.ts` |
| Retention | `pruneAuditEventsOlderThan` in `server/db/audit-log.ts` | Scheduled tick | — |
| Auth row retention | `pruneExpiredAuthRows` in `server/db/auth-retention.ts` | Scheduled tick | `test/workers/auth-retention.test.ts` |
| UI | `src/pages/Dashboard/Settings/AuditLogSection.tsx`, model `src/models/audit-log.ts` | Owner/admin | — |

## Contract

### Row shape

| Column | Contract |
| --- | --- |
| `organization_id` | NOT NULL; cascades with the org |
| `actor_user_id` | Optional; `SET NULL` on user delete |
| `scan_id` | Optional; cascades with the scan |
| `type` | Event type string |
| `metadata_json` | JSON; never leaves the Worker |
| `created_at` | Timestamp; `scan_events_org_created_idx` backs the org-scoped newest-first read, `scan_events_created_idx` the retention sweep |

The table is append-only in normal operation; the only deletes are org/scan cascade (and explicit org deletion) and retention.

### What is recorded

| Group | Recorded | Visible | Notes |
| --- | --- | --- | --- |
| `scan.decided` | yes | yes | Batch approval writes one per approved review in the same transaction, `batch: true`; shown as "approved publish in a batch" |
| `github_workflow_gate.*` | yes | `requested`, `reviewed`, `approved`, `rejected`, `timeout_missed` | Internal gate-processing types are hidden |
| `organization.member_*` | yes | yes | [Organization members](./organization-members.md#audit-events) |
| `organization.*` (created, renamed, release_two_factor_changed, notification recipients, Slack, package badge) | yes | yes |  |
| `npm_connection.{upserted,validated,deleted,token_expired,personal_confirmed}` | yes | yes |  |
| `github_app_*` (installation linked, release target created/deleted, `github_app_setup.pr_created`) | yes | yes | Setup PR: actor, repository, environment, PR number; detail shows repository and PR number only; workflow contents and proposal tokens are never recorded |
| `scan.share_*`, `scan.feed_*` | yes | yes | Security category |
| `npm_package.management_*` | yes | yes | [Package claims](./package-claims.md) |
| `publication.*`, `publication_watch.*` | yes | yes | See publication monitoring below |
| Notification delivery | yes | no | Hidden as noise |
| Scan lifecycle: `scan.started`, `scan.queued`, `scan.backgrounded`, `scan.completed`, `scan.failed`, `scan.skipped`, `scan.retryable_failed`, `scan.viewed` | no | — | Workers Logs via `emitOperationalEvent`; volume/latency/failure rate via `recordProductEvent` ([product analytics](./product-analytics.md)) |
| Discovery: `npm_connection.used`, `staged_publishes.scans_started` | no | — | Same as lifecycle |

The full surfaced set, with category, label, and severity, is the registry in `server/lib/auth/audit-events.ts`. Categories: `release_decision`, `member`, `security`, `integration`, `organization`.

### Publication monitoring events

| Event | Severity | Records |
| --- | --- | --- |
| `publication.discrepancy` | security | Package/version identity |
| `publication.acknowledged` | notice | Package/version and the acknowledging member; changes neither approval nor observed evidence |
| `publication.review_started` | info | The member who pressed Scan; review scan id in metadata so the event outlives a failed, deleted review |
| `publication.review_resolved` | notice | The deciding member, resolution, whether reviewed bytes matched published ones, whether the badge counts it; deep-linked to the review |
| `publication_watch.started` | info | Explicit enrollment (also clears a persisted opt-out); package name and member |
| `publication_watch.stopped` | notice | Owner/admin only, since stopping deletes the watch's observations and persists an opt-out; package name and member |

Neither review event changes the observation's verdict. Alert deduplication persists independently of audit retention.

### API

`GET /api/v1/audit-events`, owner/admin only, organization from the active-organization header.

| Parameter | Contract |
| --- | --- |
| `limit` | Default 50 (`AUDIT_LOG_DEFAULT_LIMIT`), max 100 (`AUDIT_LOG_MAX_LIMIT`) |
| `cursor` | `<createdAtMs>:<id>`; keyset pagination, newest first |

```json
{
  "events": [
    {
      "id": "…",
      "type": "scan.decided",
      "category": "release_decision",
      "label": "…",
      "severity": "notice",
      "detail": "…",
      "createdAt": 1730937600000,
      "scanId": "…",
      "actor": { "type": "user", "name": "…", "email": "…" }
    }
  ],
  "nextCursor": "1730937600000:…",
  "limit": 50
}
```

### Retention

| What | Rule | Failure event |
| --- | --- | --- |
| `scan_events` | Flat 90 days (`AUDIT_LOG_RETENTION_DAYS`), single age sweep across all rows | `audit_events.prune_failed` |
| Better Auth `session`, `verification` | Deleted once `expires_at` is more than `AUTH_ROW_RETENTION_GRACE_MS` (one day) past | `auth_rows.prune_failed` |

Scheduled tick order (`server/scheduled.ts`): discovery sweep, publication monitor, publisher setup job cleanup, audit prune, auth-row prune, rate-limit bucket prune. Each prune is wrapped so a failure is logged and never aborts the cron.

## Invariants

1. Types outside `AUDIT_VISIBLE_TYPES` never leave the Worker; the query is scoped to them.
2. Each row is reduced to `{ id, type, category, label, severity, detail, createdAt, scanId, actor }` (`actor` is `{ type: "user", name, email }` or `{ type: "system" }`; unregistered types default to category `organization`, severity `info`); raw `metadata_json` is dropped, `summarize()` derives `detail`, and `redactScanEventForClient`'s sensitive-key set applies to anything the summarizer reads.
3. Members never see the tab and the endpoint answers them `403`.
4. The category is rendered untoned: rows never state a severity, so color would read as an alarm on routine actions.
5. Auth-row pruning cannot sign anyone out: an expired row already authenticates nothing, and the one-day grace keeps the sweep clear of Better Auth's session refresh. Without it, `session` keeps every dead session's `ip_address` and `user_agent` forever.

## Tests

`test/workers/audit-events-route.test.ts` covers visible-only filtering, metadata non-leakage, org scoping, cursor pagination, and the member-`403` / admin-`200` gate.

## Change checklist

- New auditable action → `recordScanEvent` with a redaction-safe metadata shape, add an entry to `server/lib/auth/audit-events.ts`, extend `test/workers/audit-events-route.test.ts`.
- New high-volume operational signal → `emitOperationalEvent` and `recordProductEvent`, not `scan_events`.
