import { Hono } from "hono";
import {
  getDependencyReview,
  getDependencyReviewSettings,
  listDependencyReviews,
  MAX_EXTRA_BOT_LOGINS,
  parseExtraBotLogins,
  readDependencyReviewBumps,
  saveDependencyReviewSettings,
} from "../db/dependency-reviews";
import { recordScanEvent } from "../db/events";
import {
  requireActiveOrganizationContext,
  requireOrganizationRole,
} from "../lib/auth/active-organization";
import { roleCanManageIntegrations } from "../lib/auth/roles";
import { parseDependencyReviewPolicy } from "../lib/dependency-review/policy";
import { listInstallationsForOrganization } from "../lib/github-app/persistence";
import { isRecord } from "../lib/platform/guards";
import { readJsonObject } from "../lib/platform/http";
import type { Bindings, Variables } from "../types";

export const dependencyReviewRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

const LIST_LIMIT = 50;

dependencyReviewRoutes.use("*", async (c, next) => {
  c.header("cache-control", "private, no-store");
  await next();
});

dependencyReviewRoutes.get("/", async (c) => {
  const db = c.var.db;
  const { organizationId, role } = await requireActiveOrganizationContext(c, db);
  const [settings, reviews, installations] = await Promise.all([
    getDependencyReviewSettings(db, organizationId),
    listDependencyReviews(db, organizationId, LIST_LIMIT),
    listInstallationsForOrganization(db, organizationId),
  ]);
  return c.json({
    settings: {
      enabled: settings.enabled,
      policy: settings.policy,
      extraBotLogins: settings.extraBotLogins,
    },
    githubAppInstalled: installations.some((installation) => installation.status === "active"),
    reviews,
    viewer: { canManage: roleCanManageIntegrations(role) },
  });
});

dependencyReviewRoutes.put("/settings", async (c) => {
  const db = c.var.db;
  const { organizationId } = await requireOrganizationRole(c, db, roleCanManageIntegrations);
  const body = await readJsonObject<{
    enabled: unknown;
    policy: unknown;
    extraBotLogins: unknown;
  }>(c);
  if (typeof body.enabled !== "boolean" || !isRecord(body.policy)) {
    return c.json({ error: "enabled and policy are required" }, 400);
  }
  const requestedLogins = Array.isArray(body.extraBotLogins) ? body.extraBotLogins : [];
  const extraBotLogins = parseExtraBotLogins(requestedLogins);
  if (
    requestedLogins.length > MAX_EXTRA_BOT_LOGINS ||
    extraBotLogins.length !== requestedLogins.length
  ) {
    return c.json(
      {
        error: `List up to ${MAX_EXTRA_BOT_LOGINS} distinct GitHub logins, such as my-renovate[bot].`,
      },
      400,
    );
  }
  const policy = parseDependencyReviewPolicy(body.policy);
  const session = c.get("authSession");
  await saveDependencyReviewSettings(
    db,
    organizationId,
    { enabled: body.enabled, policy, extraBotLogins },
    session.userId,
  );
  await recordScanEvent(db, {
    organizationId,
    actorUserId: session.userId,
    type: "dependency_review.settings_updated",
    metadata: { enabled: body.enabled, policy, extraBotLoginCount: extraBotLogins.length },
  });
  return c.json({ settings: { enabled: body.enabled, policy, extraBotLogins } });
});

dependencyReviewRoutes.get("/:id", async (c) => {
  const db = c.var.db;
  const { organizationId } = await requireActiveOrganizationContext(c, db);
  const review = await getDependencyReview(db, organizationId, c.req.param("id"));
  if (!review) return c.json({ error: "Dependency review not found." }, 404);
  return c.json({ review, bumps: await readDependencyReviewBumps(db, review.id) });
});
