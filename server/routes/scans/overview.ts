/**
 * The dashboard overview strip: aggregate counts for the active organization.
 *
 * Read-only and organization-scoped like the list; nothing here names a scan.
 */
import { Hono } from "hono";
import { createDb } from "../../db/client";
import { getScanOverview } from "../../db/scans";
import { requireActiveOrganization } from "../../lib/auth/active-organization";
import type { Bindings, Variables } from "../../types";

export const scanOverviewRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

scanOverviewRoutes.get("/overview", async (c) => {
  const db = createDb(c.env.DB);
  const organizationId = await requireActiveOrganization(c, db);
  return c.json(await getScanOverview(db, organizationId));
});
