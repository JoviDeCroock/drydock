import { Hono } from "hono";
import {
  RateLimitError,
  createDb,
  createScanJob,
  enforceRateLimit,
  listExistingScanStageIds,
  recordScanEvent,
} from "../db";
import { requireActiveOrganization } from "../lib/active-organization";
import { getOrganizationNpmToken } from "../lib/npm-connection";
import { StagedPublishesFetchError, listStagedPublishes } from "../lib/staged-publishes";
import { executeScanJob, type ScanQueueMessage } from "../lib/scan-job";
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
      return c.json(
        {
          error: "staged publish discovery rate limit exceeded",
          retryAfterSeconds: err.retryAfterSeconds,
        },
        429,
        { "retry-after": String(err.retryAfterSeconds) },
      );
    }
    throw err;
  }

  const connection = await getOrganizationNpmToken(db, c.env, organizationId);
  if (!connection) {
    return c.json(
      { error: "Connect an organization npm token before discovering staged publishes." },
      400,
    );
  }

  try {
    const page = await listStagedPublishes(connection.registryUrl, connection.token, {
      perPage: 50,
    });
    const stageIds = [...new Set(page.items.map((item) => item.id))];
    const existingStageIds = await listExistingScanStageIds(db, organizationId, stageIds);
    const scans: Array<{ id: string; stageId: string }> = [];

    for (const stageId of stageIds) {
      if (existingStageIds.has(stageId)) continue;
      const scanId = crypto.randomUUID();
      const detail = await createScanJob(db, {
        id: scanId,
        stageId,
        organizationId,
        ownerUserId: session.userId,
      });
      if (!detail) continue;
      existingStageIds.add(stageId);
      scans.push({ id: scanId, stageId });

      const message: ScanQueueMessage = {
        stageId,
        scanId,
        organizationId,
        actorUserId: session.userId,
      };
      await recordScanEvent(db, {
        organizationId,
        actorUserId: session.userId,
        scanId,
        type: c.env.SCAN_QUEUE ? "scan.queued" : "scan.backgrounded",
        metadata: { stageId, source: "staged_publishes.discovery" },
      });
      if (c.env.SCAN_QUEUE) {
        await c.env.SCAN_QUEUE.send(message);
      } else {
        c.executionCtx.waitUntil(
          executeScanJob(c.env, c.executionCtx, message, db, { finalAttempt: true }),
        );
      }
    }

    await recordScanEvent(db, {
      organizationId,
      actorUserId: session.userId,
      type: "staged_publishes.scans_started",
      metadata: {
        found: stageIds.length,
        created: scans.length,
        skipped: stageIds.length - scans.length,
      },
    });

    return c.json(
      {
        found: stageIds.length,
        created: scans.length,
        skipped: stageIds.length - scans.length,
        queued: Boolean(c.env.SCAN_QUEUE),
        scans,
      },
      202,
    );
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
