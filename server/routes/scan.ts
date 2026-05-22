import { Hono } from "hono";
import { RateLimitError, createDb, createScanJob, enforceRateLimit, getNpmConnection } from "../db";
import { requireActiveOrganization } from "../lib/active-organization";
import { executeScanJob } from "../lib/scan-job";
import { SandboxError } from "../lib/sandbox";
import type { Bindings, ScanInput, Variables } from "../types";

const STAGE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{5,160}$/;

export const scanRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

scanRoutes.post("/", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Partial<ScanInput>;
  const input: ScanInput = {
    stageId: String(body.stageId || ""),
    maxFiles: body.maxFiles,
    maxBytesPerFile: body.maxBytesPerFile,
  };
  if (!STAGE_ID_RE.test(input.stageId)) {
    return c.json({ error: "invalid stageId" }, 400);
  }

  try {
    const db = createDb(c.env.DB);
    const session = c.get("authSession");
    const organizationId = await requireActiveOrganization(c, db);
    await enforceRateLimit(db, {
      key: `scan:${organizationId}`,
      limit: 10,
      windowMs: 60 * 60 * 1000,
    });

    const npmConnection = await getNpmConnection(db, organizationId);
    if (!npmConnection) {
      return c.json(
        { error: "Connect an organization npm token before scanning staged publishes." },
        400,
      );
    }

    const scanId = crypto.randomUUID();
    await createScanJob(db, {
      id: scanId,
      stageId: input.stageId,
      organizationId,
      ownerUserId: session.userId,
    });
    const result = await executeScanJob(
      c.env,
      c.executionCtx,
      { ...input, scanId, organizationId, actorUserId: session.userId },
      db,
    );

    return c.json(result);
  } catch (err) {
    if (err instanceof RateLimitError) {
      return c.json(
        { error: "scan rate limit exceeded", retryAfterSeconds: err.retryAfterSeconds },
        429,
        { "retry-after": String(err.retryAfterSeconds) },
      );
    }
    if (err instanceof SandboxError) {
      return c.json(
        { error: "Could not download or inspect the staged tarball.", detail: err.detail },
        502,
      );
    }
    throw err;
  }
});
