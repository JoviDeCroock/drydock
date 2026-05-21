import { Hono } from "hono";
import {
  RateLimitError,
  createDb,
  enforceRateLimit,
  ensurePersonalOrganization,
  getNpmConnection,
  markNpmConnectionUsed,
  recordScanEvent,
} from "../db";
import { decryptNpmToken } from "../lib/npm-connection";
import { runScanPipeline } from "../lib/scan-pipeline";
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
    const organizationId = await ensurePersonalOrganization(db, session);
    await enforceRateLimit(db, { key: `scan:${organizationId}`, limit: 10, windowMs: 60 * 60 * 1000 });

    const npmConnection = await getNpmConnection(db, organizationId);
    if (!npmConnection && c.env.REQUIRE_ORG_NPM_CONNECTION === "true") {
      return c.json({ error: "Connect an organization npm token before scanning staged publishes." }, 400);
    }
    const orgNpmToken = npmConnection ? await decryptNpmToken(c.env, npmConnection) : undefined;
    if (npmConnection) {
      await markNpmConnectionUsed(db, organizationId);
      await recordScanEvent(db, {
        organizationId,
        actorUserId: session.userId,
        type: "npm_connection.used",
        metadata: {
          stageId: input.stageId,
          registryUrl: npmConnection.registryUrl,
          tokenFingerprint: npmConnection.tokenFingerprint,
        },
      });
    }

    const result = await runScanPipeline(
      { env: c.env, executionCtx: c.executionCtx, db, session },
      {
        ...input,
        organizationId,
        npmToken: orgNpmToken,
        npmRegistry: npmConnection?.registryUrl,
      },
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
      return c.json({ error: "Could not download or inspect the staged tarball.", detail: err.detail }, 502);
    }
    throw err;
  }
});
