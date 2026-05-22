import { Hono } from "hono";
import {
  RateLimitError,
  createDb,
  enforceRateLimit,
  ensurePersonalOrganization,
  recordScanEvent,
} from "../db";
import { getOrganizationNpmToken } from "../lib/npm-connection";
import { StagedPublishesFetchError, listStagedPublishes } from "../lib/staged-publishes";
import type { Bindings, Variables } from "../types";

export const stagedPublishesRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

stagedPublishesRoutes.get("/", async (c) => {
  const db = createDb(c.env.DB);
  const session = c.get("authSession");
  const organizationId = await ensurePersonalOrganization(db, session);

  try {
    await enforceRateLimit(db, {
      key: `staged-publishes:list:${organizationId}`,
      limit: 60,
      windowMs: 60 * 1000,
    });
  } catch (err) {
    if (err instanceof RateLimitError) {
      return c.json(
        { error: "staged publishes rate limit exceeded", retryAfterSeconds: err.retryAfterSeconds },
        429,
        { "retry-after": String(err.retryAfterSeconds) },
      );
    }
    throw err;
  }

  const connection = await getOrganizationNpmToken(db, c.env, organizationId);
  if (!connection) {
    return c.json(
      { error: "Connect an organization npm token before listing staged publishes." },
      400,
    );
  }

  try {
    const page = await listStagedPublishes(connection.registryUrl, connection.token, {
      perPage: 50,
    });
    await recordScanEvent(db, {
      organizationId,
      actorUserId: session.userId,
      type: "staged_publishes.listed",
      metadata: { count: page.items.length, total: page.total },
    });
    return c.json(page);
  } catch (err) {
    if (err instanceof StagedPublishesFetchError) {
      return c.json(
        {
          error: "npm registry rejected the staged publishes request",
          status: err.status,
          detail: err.detail,
        },
        502,
      );
    }
    throw err;
  }
});
