import type { MiddlewareHandler } from "hono";
import { guardRateLimit } from "../lib/rate-limit";
import type { Bindings, Variables } from "../types";

function authIpLimit(path: string): { bucket: string; max: number; windowMs: number } | null {
  if (path.startsWith("/api/auth/two-factor")) {
    return { bucket: "two-factor", max: 10, windowMs: 15 * 60 * 1000 };
  }
  if (path.startsWith("/api/auth/sign-in")) {
    return { bucket: "sign-in", max: 10, windowMs: 15 * 60 * 1000 };
  }
  if (path.startsWith("/api/auth/sign-up")) {
    return { bucket: "sign-up", max: 5, windowMs: 60 * 60 * 1000 };
  }
  if (path.startsWith("/api/auth/forget-password") || path.startsWith("/api/auth/reset-password")) {
    return { bucket: "password-reset", max: 5, windowMs: 60 * 60 * 1000 };
  }
  return null;
}

/** Per-IP budgets on the credential-bearing Better Auth POSTs. */
export const authIpRateLimit: MiddlewareHandler<{
  Bindings: Bindings;
  Variables: Variables;
}> = async (c, next) => {
  if (c.req.method !== "POST") return next();
  const limit = authIpLimit(c.req.path);
  if (!limit) return next();
  const ip =
    c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  if (!ip) return next();
  const limited = await guardRateLimit(
    c,
    { key: `auth:${limit.bucket}:${ip}`, limit: limit.max, windowMs: limit.windowMs },
    "too many authentication attempts",
  );
  if (limited) return limited;
  return next();
};
