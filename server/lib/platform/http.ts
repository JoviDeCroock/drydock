import type { Context } from "hono";
import { type RateLimitError } from "../../db/rate-limit";
import type { Bindings, Variables } from "../../types";

type AppContext = Context<{ Bindings: Bindings; Variables: Variables }>;

export function rateLimitResponse(c: AppContext, error: string, err: RateLimitError) {
  return c.json({ error, retryAfterSeconds: err.retryAfterSeconds }, 429, {
    "retry-after": String(err.retryAfterSeconds),
  });
}
