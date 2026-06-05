import { Hono } from "hono";
import { createDb } from "../db";
import { requireActiveOrganization } from "../lib/active-organization";
import { withRateLimit } from "../lib/http";
import {
  NpmConnectionError,
  allowInsecureLocalRegistry,
  requireValidNpmConnection,
} from "../lib/npm-connection";
import {
  InvalidNpmConnectionError,
  StagedPublishesFetchError,
  discoverAndQueueStagedPublishes,
  ensureUsableNpmConnection,
} from "../lib/staged-publishes-discovery";
import type { Bindings, Variables } from "../types";

export const stagedPublishesRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

stagedPublishesRoutes.post("/scan", async (c) => {
  const db = createDb(c.env.DB);
  const session = c.get("authSession");
  const organizationId = await requireActiveOrganization(c, db);

  const limited = await withRateLimit(
    c,
    db,
    { key: `staged-publishes:scan:${organizationId}`, limit: 12, windowMs: 10 * 60 * 1000 },
    "staged publish discovery rate limit exceeded",
  );
  if (limited) return limited;

  let savedConnection;
  try {
    savedConnection = await requireValidNpmConnection(db, organizationId);
  } catch (err) {
    if (err instanceof NpmConnectionError) {
      return c.json({ error: err.message }, 400);
    }
    throw err;
  }

  const allowInsecureLocalhost = allowInsecureLocalRegistry(c.env);
  try {
    const usable = await ensureUsableNpmConnection({
      db,
      env: c.env,
      connection: savedConnection,
      actorUserId: session.userId,
      allowInsecureLocalhost,
    });
    const result = await discoverAndQueueStagedPublishes(
      {
        db,
        env: c.env,
        executionCtx: c.executionCtx,
        organizationId,
        actorUserId: session.userId,
        source: "manual",
        eventSource: "staged_publishes.discovery",
        allowInsecureLocalhost,
      },
      usable,
    );
    return c.json(result, 202);
  } catch (err) {
    if (err instanceof InvalidNpmConnectionError) {
      return c.json(
        { error: "Validate the organization npm token before discovering staged publishes." },
        400,
      );
    }
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
