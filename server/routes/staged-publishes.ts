import { Hono } from "hono";
import { guardRateLimit } from "../lib/rate-limit";
import { getNpmConnection } from "../db/npm-connections";
import { recordApiKeyAction } from "../db/api-keys";
import { requestActorUserId, requireActiveOrganization } from "../lib/auth/active-organization";
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
  const db = c.var.db;
  const actorUserId = requestActorUserId(c);
  const organizationId = await requireActiveOrganization(c, db);

  const limited = await guardRateLimit(
    c,
    { key: `staged-publishes:scan:${organizationId}`, limit: 12, windowMs: 10 * 60 * 1000 },
    "staged publish discovery rate limit exceeded",
  );
  if (limited) return limited;

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
      actorUserId,
      allowInsecureLocalhost,
    });
    const result = await discoverAndQueueStagedPublishes(
      {
        db,
        env: c.env,
        executionCtx: workerExecutionContext(c.executionCtx),
        organizationId,
        actorUserId,
        source: "manual",
        eventSource: "staged_publishes.discovery",
        allowInsecureLocalhost,
      },
      usable,
    );
    // Blocked stages are only counted as skipped here: the caller has not
    // proven read access to them, so it learns nothing about their claims.
    const { claimBlocked: _claimBlocked, ...body } = result;
    const apiKey = c.get("apiKey");
    if (apiKey) {
      await recordApiKeyAction(db, apiKey, {
        type: "organization.api_key_discovery_ran",
        metadata: { found: body.found, created: body.created, skipped: body.skipped },
      });
    }
    return c.json(body, 202);
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
