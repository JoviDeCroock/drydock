import { Hono } from "hono";
import { createDb } from "../db/client";
import { getNpmConnection } from "../db/npm-connections";
import { RateLimitError, enforceRateLimit } from "../db/rate-limit";
import { requireActiveOrganization } from "../lib/auth/active-organization";
import { rateLimitResponse } from "../lib/platform/http";
import { workerExecutionContext } from "../lib/platform/execution-context";
import { allowInsecureLocalRegistry } from "../lib/ecosystems/npm/connection";
import {
  InvalidNpmConnectionError,
  StagedPublishesFetchError,
  discoverAndQueueStagedPublishes,
  ensureUsableNpmConnection,
} from "../lib/ecosystems/npm/staged-publishes-discovery";
import type { Bindings, Variables } from "../types";

export const stagedPublishesRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

stagedPublishesRoutes.post("/scan", async (c) => {
  const db = createDb(c.env.DB);
  const session = c.get("authSession");
  const organizationId = await requireActiveOrganization(c, db);

  try {
    await enforceRateLimit(db, {
      key: `staged-publishes:scan:${organizationId}`,
      limit: 12,
      windowMs: 10 * 60 * 1000,
    });
  } catch (err) {
    if (err instanceof RateLimitError) {
      return rateLimitResponse(c, "staged publish discovery rate limit exceeded", err);
    }
    throw err;
  }

  const savedConnection = await getNpmConnection(db, organizationId);
  if (!savedConnection) {
    return c.json(
      { error: "Connect an organization npm token before discovering staged publishes." },
      400,
    );
  }
  if (savedConnection.validationStatus !== "valid") {
    return c.json(
      { error: "Validate the organization npm token before discovering staged publishes." },
      400,
    );
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
        executionCtx: workerExecutionContext(c.executionCtx),
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
