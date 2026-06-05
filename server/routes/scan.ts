import { Hono } from "hono";
import { createDb, createScanJob } from "../db";
import { requireActiveOrganization } from "../lib/active-organization";
import { withRateLimit } from "../lib/http";
import { NpmConnectionError, requireValidNpmConnection } from "../lib/npm-connection";
import { parseScanInput } from "../lib/scan-input";
import { executeScanJob } from "../lib/scan-job";
import { sandboxErrorDetail } from "../lib/sandbox";
import type { Bindings, ScanInput, Variables } from "../types";

export const scanRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

scanRoutes.post("/", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Partial<ScanInput>;
  const parsed = parseScanInput(body);
  if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);
  const { input } = parsed;

  const db = createDb(c.env.DB);
  const session = c.get("authSession");
  const organizationId = await requireActiveOrganization(c, db);
  const limited = await withRateLimit(
    c,
    db,
    { key: `scan:${organizationId}`, limit: 10, windowMs: 60 * 60 * 1000 },
    "scan rate limit exceeded",
  );
  if (limited) return limited;

  try {
    await requireValidNpmConnection(db, organizationId);
  } catch (err) {
    if (err instanceof NpmConnectionError) {
      return c.json({ error: err.message }, 400);
    }
    throw err;
  }

  try {
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
      { finalAttempt: true },
    );

    return c.json(result);
  } catch (err) {
    const detail = sandboxErrorDetail(err);
    if (detail !== null) {
      return c.json({ error: "Could not download or inspect the staged tarball.", detail }, 502);
    }
    throw err;
  }
});
