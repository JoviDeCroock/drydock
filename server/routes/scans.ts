import { Hono } from "hono";
import { createDb, ensurePersonalOrganization, getScan, listScans, recordScanEvent } from "../db";
import type { Bindings, Variables } from "../types";

export const scansRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

scansRoutes.get("/", async (c) => {
  const db = createDb(c.env.DB);
  const organizationId = await ensurePersonalOrganization(db, c.get("authSession"));
  return c.json({ scans: await listScans(db, organizationId) });
});

scansRoutes.get("/:id", async (c) => {
  const db = createDb(c.env.DB);
  const session = c.get("authSession");
  const organizationId = await ensurePersonalOrganization(db, session);
  const scan = await getScan(db, c.req.param("id"), organizationId);
  if (!scan) return c.json({ error: "not found" }, 404);
  await recordScanEvent(db, {
    organizationId,
    actorUserId: session.userId,
    scanId: scan.scan.id,
    type: "scan.viewed",
    metadata: { stageId: scan.scan.stageId },
  });
  return c.json(scan);
});
