import { Hono } from "hono";
import {
  createDb,
  enforceRateLimit,
  RateLimitError,
  resolveApiToken,
  touchApiTokenLastUsed,
} from "../db";
import { hashApiToken, parseBearerApiToken } from "../lib/api-token";
import { rateLimitResponse } from "../lib/http";
import { handleMcpRequestBody, type McpToolContext } from "../lib/mcp-server";
import { emitOperationalEvent } from "../lib/observability";
import { scanArtifactReadBucket } from "../lib/scan-artifacts";
import type { Bindings, Variables } from "../types";

export const mcpRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// 401 with a Bearer challenge, no body detail — every auth failure mode
// (missing/malformed/unknown/expired/revoked token) collapses to one opaque
// response so a caller can't probe which tokens exist.
function unauthorized(): Response {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: {
      "content-type": "application/json",
      "www-authenticate": 'Bearer realm="drydock-mcp"',
    },
  });
}

// The MCP endpoint is bearer-authenticated and mounted before the /api/* cookie
// + CSRF-Origin middleware: headless agents present a token, not a session, and
// send cross-origin POSTs with no Origin header. The token hash lookup is the
// trust boundary here (mirrors the signed-webhook mount).
mcpRoutes.post("/", async (c) => {
  const token = parseBearerApiToken(c.req.header("authorization"));
  if (!token) return unauthorized();

  const db = createDb(c.env.DB);
  const resolved = await resolveApiToken(db, await hashApiToken(token));
  if (!resolved) {
    emitOperationalEvent("info", "mcp.auth.rejected", { reason: "invalid_token" });
    return unauthorized();
  }

  try {
    await enforceRateLimit(db, {
      key: `mcp:${resolved.tokenId}`,
      limit: 240,
      windowMs: 60 * 1000,
    });
  } catch (err) {
    if (err instanceof RateLimitError) {
      return rateLimitResponse(c, "too many MCP requests", err);
    }
    throw err;
  }

  // Best-effort last-used stamp; never blocks or fails the request.
  c.executionCtx.waitUntil(
    touchApiTokenLastUsed(db, resolved.tokenId).catch(() => {
      /* observability only; ignore */
    }),
  );

  const rawBody = await c.req.text();
  const ctx: McpToolContext = {
    db,
    organizationId: resolved.organizationId,
    artifactBucket: scanArtifactReadBucket(c.env),
  };
  const { body } = await handleMcpRequestBody(ctx, rawBody);

  // A body of only notifications yields no response payload (JSON-RPC 202).
  if (body === null) return c.body(null, 202);
  return c.json(body);
});

// Agents sometimes probe with GET expecting an SSE stream; this transport is
// request/response JSON-RPC only.
mcpRoutes.get("/", (c) =>
  c.json({ error: "method not allowed; POST JSON-RPC to this endpoint" }, 405),
);
