import { Hono } from "hono";
import { getPublicDiffAdapter } from "../lib/ecosystems";
import { canonicalOrigin } from "../lib/platform/http";
import { createPublicMcpHandler } from "../lib/public-mcp";
import { guardRateLimit } from "../lib/rate-limit";
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
  const ip =
    c.req.header("cf-connecting-ip") ||
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown";
  const limited = await guardRateLimit(
    c,
    { key: `public-mcp:${ip}`, limit: 120, windowMs: 60_000 },
    "rate limit exceeded",
  );
  if (limited) return limited;

  const handler = createPublicMcpHandler(
    // In-process dispatch preserves the public router's validation, per-IP
    // budgets and cache. No caller cookie, key, origin, or target URL crosses
    // into it, and there is no network hop back to this Worker.
    async (path) =>
      publicDiffRoutes.fetch(
        new Request(`https://public-diff.internal${path}`, {
          headers: { "cf-connecting-ip": ip },
        }),
        c.env,
        c.executionCtx,
      ),
    origin,
  );
  return handler.fetch(c.req.raw);
});
