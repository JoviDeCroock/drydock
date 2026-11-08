import { Hono } from "hono";
import { getPublicDiffAdapter } from "../lib/ecosystems";
import { canonicalOrigin } from "../lib/platform/http";
import { createPublicMcpHandler } from "../lib/public-mcp";
import { clientRateLimitKey, guardRateLimit } from "../lib/rate-limit";
import type { Bindings, Variables } from "../types";
import { publicDiffRoutes } from "./public-diff";

export const publicMcpRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

publicMcpRoutes.on(["GET", "POST", "DELETE"], "/", async (c) => {
  const publicRegistry = getPublicDiffAdapter("npm")?.registryUrl;
  const registry = (c.env.NPM_REGISTRY || publicRegistry || "").replace(/\/+$/, "");
  if (!publicRegistry || registry !== publicRegistry) {
    return c.json({ error: "public package review is disabled for custom registries" }, 404);
  }
  const origin = canonicalOrigin(c);
  const requestOrigin = c.req.header("origin");
  if (requestOrigin !== undefined && requestOrigin !== origin) {
    return c.json({ error: "request origin not allowed" }, 403);
  }
  const limited = await guardRateLimit(
    c,
    { key: `public-mcp:${clientRateLimitKey(c)}`, limit: 120, windowMs: 60_000 },
    "rate limit exceeded",
  );
  if (limited) return limited;

  // Forwarded as received, so the router derives the same client key.
  const clientAddress = c.req.header("cf-connecting-ip");
  const handler = createPublicMcpHandler(
    // In-process dispatch preserves the public router's validation, per-IP
    // budgets and cache. No caller cookie, key, origin header, or target URL
    // crosses into it, and there is no network hop back to this Worker. The
    // URL carries the canonical origin only so the router's reviewUrl matches
    // the site; the client tag keeps tool calls out of the /diff page-view count.
    async (path) =>
      publicDiffRoutes.fetch(
        new Request(new URL(path, origin), {
          headers: {
            ...(clientAddress ? { "cf-connecting-ip": clientAddress } : {}),
            "x-drydock-client": "mcp",
          },
        }),
        c.env,
        c.executionCtx,
      ),
  );
  return handler.fetch(c.req.raw);
});
