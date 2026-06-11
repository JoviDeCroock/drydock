import { Hono } from "hono";
import { createDb, getUserNotificationSettings, setUserNotificationSettings } from "../db";
import type { Bindings, Variables } from "../types";

// Personal (cross-organization) account settings. Notification preferences
// here govern emails addressed to the signed-in user, unlike the org-level
// recipient list which routes release alerts for an organization.
export const accountRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

accountRoutes.get("/notification-settings", async (c) => {
  const db = createDb(c.env.DB);
  const session = c.get("authSession");
  const settings = await getUserNotificationSettings(db, session.userId);
  return c.json({ settings });
});

accountRoutes.patch("/notification-settings", async (c) => {
  const db = createDb(c.env.DB);
  const session = c.get("authSession");
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  if (typeof body.mentionEmails !== "boolean") {
    return c.json({ error: "mentionEmails must be a boolean" }, 400);
  }
  const settings = await setUserNotificationSettings(db, session.userId, {
    mentionEmails: body.mentionEmails,
  });
  return c.json({ settings });
});
