import { Hono } from "hono";
import { createDb } from "../db/client";
import {
  AUDIT_LOG_DEFAULT_LIMIT,
  AUDIT_LOG_MAX_LIMIT,
  type AuditLogCursor,
  listOrganizationAuditEvents,
} from "../db/audit-log";
import { requireActiveOrganizationContext } from "../lib/auth/active-organization";
import { describeAuditEvent } from "../lib/auth/audit-events";
import { roleCanManageMembers } from "../lib/auth/roles";
import type { Bindings, Variables } from "../types";

export const auditRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

function parseCursor(raw: string | undefined): AuditLogCursor | null {
  if (!raw) return null;
  const sep = raw.indexOf(":");
  if (sep <= 0) return null;
  const createdAtMs = Number(raw.slice(0, sep));
  const id = raw.slice(sep + 1);
  if (!Number.isFinite(createdAtMs) || !id) return null;
  return { createdAtMs, id };
}

function encodeCursor(cursor: AuditLogCursor | null): string | null {
  return cursor ? `${cursor.createdAtMs}:${cursor.id}` : null;
}

// Organization audit log. Owner/admin only — the log records member changes,
// credential rewiring, and release decisions, so it sits at the same trust tier
// as member management. Metadata never leaves the Worker: each row is reduced to
// a registry-derived label + short detail before serialization.
auditRoutes.get("/", async (c) => {
  const db = createDb(c.env.DB);
  const { organizationId, role } = await requireActiveOrganizationContext(c, db);
  if (!roleCanManageMembers(role)) return c.json({ error: "forbidden" }, 403);

  const rawLimit = Number(c.req.query("limit"));
  const limit = Number.isFinite(rawLimit)
    ? Math.min(AUDIT_LOG_MAX_LIMIT, Math.max(1, Math.floor(rawLimit)))
    : AUDIT_LOG_DEFAULT_LIMIT;
  const cursor = parseCursor(c.req.query("cursor"));

  const { events, nextCursor } = await listOrganizationAuditEvents(db, organizationId, {
    cursor,
    limit,
  });

  const shaped = events.map((row) => {
    const descriptor = describeAuditEvent(row.type, row.metadataJson);
    return {
      id: row.id,
      type: row.type,
      category: descriptor?.category ?? "organization",
      label: descriptor?.label ?? row.type,
      severity: descriptor?.severity ?? "info",
      detail: descriptor?.detail ?? null,
      createdAt: new Date(row.createdAt).getTime(),
      scanId: row.scanId,
      actor: row.actorUserId
        ? { type: "user" as const, name: row.actorName, email: row.actorEmail }
        : { type: "system" as const },
    };
  });

  return c.json({ events: shaped, nextCursor: encodeCursor(nextCursor), limit });
});
