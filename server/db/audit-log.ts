import { and, desc, eq, inArray, lt, or } from "drizzle-orm";
import type { AppDb } from "./client";
import { scanEvents, user } from "./schema";
import { AUDIT_VISIBLE_TYPES } from "../lib/audit-events";

export const AUDIT_LOG_DEFAULT_LIMIT = 50;
export const AUDIT_LOG_MAX_LIMIT = 100;

// Audit events older than this are pruned by the scheduled sweep. Everything
// still recorded here is audit-relevant (scan lifecycle/discovery churn is no
// longer written), so retention is a flat window across all rows.
export const AUDIT_LOG_RETENTION_DAYS = 90;

export interface AuditLogCursor {
  createdAtMs: number;
  id: string;
}

export interface ListAuditEventsOptions {
  cursor?: AuditLogCursor | null;
  limit?: number;
}

export interface AuditEventRow {
  id: string;
  type: string;
  createdAt: Date;
  scanId: string | null;
  actorUserId: string | null;
  actorName: string | null;
  actorEmail: string | null;
  metadataJson: unknown;
}

export interface ListAuditEventsResult {
  events: AuditEventRow[];
  nextCursor: AuditLogCursor | null;
}

// Keyset-paginated read of an organization's audit log, newest first. Scoped to
// the visible allowlist and to `organizationId` (backed by the
// scan_events_org_created_idx index) — no cross-org leakage possible. Metadata
// is returned raw here; the route maps it through the registry summarizer and
// never ships raw metadata to the client.
export async function listOrganizationAuditEvents(
  db: AppDb,
  organizationId: string,
  options: ListAuditEventsOptions = {},
): Promise<ListAuditEventsResult> {
  const limit = Math.min(
    AUDIT_LOG_MAX_LIMIT,
    Math.max(1, Math.floor(options.limit ?? AUDIT_LOG_DEFAULT_LIMIT)),
  );

  const conditions = [
    eq(scanEvents.organizationId, organizationId),
    inArray(scanEvents.type, [...AUDIT_VISIBLE_TYPES]),
  ];

  if (options.cursor) {
    const cursorDate = new Date(options.cursor.createdAtMs);
    conditions.push(
      or(
        lt(scanEvents.createdAt, cursorDate),
        and(eq(scanEvents.createdAt, cursorDate), lt(scanEvents.id, options.cursor.id)),
      )!,
    );
  }

  const rows = await db
    .select({
      id: scanEvents.id,
      type: scanEvents.type,
      createdAt: scanEvents.createdAt,
      scanId: scanEvents.scanId,
      actorUserId: scanEvents.actorUserId,
      actorName: user.name,
      actorEmail: user.email,
      metadataJson: scanEvents.metadataJson,
    })
    .from(scanEvents)
    .leftJoin(user, eq(scanEvents.actorUserId, user.id))
    .where(and(...conditions))
    .orderBy(desc(scanEvents.createdAt), desc(scanEvents.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last ? { createdAtMs: new Date(last.createdAt).getTime(), id: last.id } : null;

  return { events: page, nextCursor };
}

// Delete audit events recorded before `cutoff`. The only delete path for the
// table besides org/scan cascade, and it is a flat age sweep.
export async function pruneAuditEventsOlderThan(db: AppDb, cutoff: Date): Promise<void> {
  await db.delete(scanEvents).where(lt(scanEvents.createdAt, cutoff));
}
