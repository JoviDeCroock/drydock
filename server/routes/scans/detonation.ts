/**
 * Beta detonation sandbox results for a scan. Outside the beta the read
 * answers "nothing to show" rather than 404, because the scan page asks on
 * every load and a 404 is a console error in the browser. That answer is the
 * same for a foreign or missing scan id, so it reveals nothing. Starting a run
 * outside the beta is a 404.
 */
import { Hono } from "hono";
import { recordScanEvent } from "../../db/events";
import { getDetonationTarget, getScanDetonation } from "../../db/scan-detonations";
import { requireActiveOrganization } from "../../lib/auth/active-organization";
import { detonationEnabled, requestDetonation } from "../../lib/detonation/job";
import { workerExecutionContext } from "../../lib/platform/execution-context";
import { guardRateLimit } from "../../lib/rate-limit";
import type { Bindings, Variables } from "../../types";

const DETONATION_RERUN_LIMIT = 10;
const DETONATION_RERUN_WINDOW_MS = 60 * 60 * 1000;

export const scanDetonationRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

scanDetonationRoutes.get("/:id/detonation", async (c) => {
  const db = c.var.db;
  const organizationId = await requireActiveOrganization(c, db);
  if (!(await detonationEnabled(c.env, organizationId))) {
    return c.json({ eligible: false, detonation: null });
  }
  const scanId = c.req.param("id");
  const [detonation, target] = await Promise.all([
    getScanDetonation(db, scanId, organizationId),
    getDetonationTarget(db, scanId, organizationId),
  ]);
  return c.json({
    eligible: target !== null,
    detonation: detonation && {
      status: detonation.status,
      stale: detonation.stale,
      result: detonation.resultJson,
      errorCode: detonation.errorCode,
      artifactSha256: detonation.artifactSha256,
      requestedAt: detonation.requestedAt.toISOString(),
      startedAt: detonation.startedAt?.toISOString() ?? null,
      completedAt: detonation.completedAt?.toISOString() ?? null,
    },
  });
});

scanDetonationRoutes.post("/:id/detonation", async (c) => {
  const db = c.var.db;
  const session = c.get("authSession");
  const organizationId = await requireActiveOrganization(c, db);
  if (!(await detonationEnabled(c.env, organizationId))) return c.json({ error: "not found" }, 404);
  const scanId = c.req.param("id");
  const target = await getDetonationTarget(db, scanId, organizationId);
  if (!target) return c.json({ error: "not found" }, 404);

  const limited = await guardRateLimit(
    c,
    {
      key: `detonation:${organizationId}`,
      limit: DETONATION_RERUN_LIMIT,
      windowMs: DETONATION_RERUN_WINDOW_MS,
    },
    "detonation rate limit exceeded",
  );
  if (limited) return limited;

  const queued = await requestDetonation(c.env, workerExecutionContext(c.executionCtx), db, {
    scanId,
    organizationId,
    requestedByUserId: session.userId,
  });
  if (!queued) return c.json({ error: "a detonation is already running for this scan" }, 409);
  await recordScanEvent(db, {
    organizationId,
    actorUserId: session.userId,
    scanId,
    type: "scan.detonation_requested",
    metadata: { scanId },
  });
  return c.json({ ok: true }, 202);
});
