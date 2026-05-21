import { Hono } from "hono";
import { createDb, getScan, listScans } from "../db";
import type { Bindings, Variables } from "../types";

export const scansRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

scansRoutes.get("/", async (c) => {
  if (!c.env.DB) return c.json({ scans: [] });
  return c.json({ scans: await listScans(createDb(c.env.DB)) });
});

scansRoutes.get("/:id", async (c) => {
  if (!c.env.DB) return c.json({ error: "database is not configured" }, 503);
  const scan = await getScan(createDb(c.env.DB), c.req.param("id"));
  if (!scan) return c.json({ error: "not found" }, 404);
  return c.json(scan);
});
