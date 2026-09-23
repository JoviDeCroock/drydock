import type { MiddlewareHandler } from "hono";
import { createDb } from "../db/client";
import type { Bindings, Variables } from "../types";

/**
 * Attaches the request's Drizzle handle as `c.var.db`. Creating the handle is a
 * pure wrapper over the binding, so attaching it on an anonymous surface does
 * not itself reach D1; only a handler that queries through it does.
 */
export const attachDb: MiddlewareHandler<{ Bindings: Bindings; Variables: Variables }> = async (
  c,
  next,
) => {
  c.set("db", createDb(c.env.DB));
  await next();
};
