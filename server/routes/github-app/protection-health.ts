import { Hono } from "hono";
import { listProtectionHealthRows, publicProtectionHealth } from "../../db/protection-health";
import {
  requireActiveOrganizationContext,
  requireOrganizationRole,
} from "../../lib/auth/active-organization";
import { roleCanManageIntegrations } from "../../lib/auth/roles";
import { refreshProtectionHealth } from "../../lib/github-app/protection-health-job";
import { guardRateLimit } from "../../lib/rate-limit";
import type { Bindings, Variables } from "../../types";

export const protectionHealthRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();
protectionHealthRoutes.use("*", async (c, next) => {
  c.header("cache-control", "private, no-store");
  await next();
});
protectionHealthRoutes.get("/protection-health", async (c) => {
  const { organizationId, role } = await requireActiveOrganizationContext(c, c.var.db);
  const rows = await listProtectionHealthRows(c.var.db, organizationId);
  return c.json({
    targets: rows.map((row) => publicProtectionHealth(row)),
    canRefresh: roleCanManageIntegrations(role),
  });
});
protectionHealthRoutes.post("/protection-health/:targetId/refresh", async (c) => {
  const { organizationId } = await requireOrganizationRole(c, c.var.db, roleCanManageIntegrations);
  const limited = await guardRateLimit(
    c,
    { key: `github-app:protection-health:${organizationId}`, limit: 10, windowMs: 60_000 },
    "protection health refresh rate limit exceeded",
  );
  if (limited) return limited;
  const target = await refreshProtectionHealth(
    c.var.db,
    c.env,
    organizationId,
    c.req.param("targetId"),
  );
  return target ? c.json({ target }) : c.json({ error: "Release target not found." }, 404);
});
