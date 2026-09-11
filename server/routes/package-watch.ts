import { Hono } from "hono";
import { createDb } from "../db/client";
import { recordScanEvent } from "../db/events";
import { acknowledgeOutOfBandPublish, listOpenOutOfBandPublishes } from "../db/package-watch";
import { requireActiveOrganization } from "../lib/auth/active-organization";
import type { Bindings, Variables } from "../types";

export interface OutOfBandAlarmWire {
  id: string;
  registryUrl: string;
  packageName: string;
  version: string;
  statusConfirmed: boolean;
  detectedAt: number;
}

export interface OutOfBandAlarmsResponse {
  alarms: OutOfBandAlarmWire[];
}

export const packageWatchRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

packageWatchRoutes.get("/out-of-band", async (c) => {
  const db = createDb(c.env.DB);
  const organizationId = await requireActiveOrganization(c, db);
  const rows = await listOpenOutOfBandPublishes(db, organizationId);
  const alarms: OutOfBandAlarmWire[] = rows.map((row) => ({
    id: row.id,
    registryUrl: row.registryUrl,
    packageName: row.packageName,
    version: row.version,
    statusConfirmed: row.statusConfirmed,
    detectedAt: row.detectedAt.getTime(),
  }));
  return c.json({ alarms } satisfies OutOfBandAlarmsResponse);
});

// Any member may acknowledge: it is release triage (weaker than deciding a
// release, which members already can), and the audit event records who did.
packageWatchRoutes.post("/out-of-band/:id/acknowledge", async (c) => {
  const db = createDb(c.env.DB);
  const session = c.get("authSession");
  const organizationId = await requireActiveOrganization(c, db);
  const alarmId = c.req.param("id");
  const acknowledged = await acknowledgeOutOfBandPublish(db, {
    organizationId,
    alarmId,
    userId: session.userId,
    at: new Date(),
  });
  if (!acknowledged) return c.json({ error: "not found" }, 404);
  await recordScanEvent(db, {
    organizationId,
    actorUserId: session.userId,
    type: "package_watch.out_of_band_acknowledged",
    metadata: {
      packageName: acknowledged.packageName,
      stagedVersion: acknowledged.version,
      registryUrl: acknowledged.registryUrl,
    },
  });
  return c.json({ ok: true });
});
