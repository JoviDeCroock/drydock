type HonoExecutionContext = import("hono").Context["executionCtx"];

/**
 * Hono's context type can lag newly required Workers ExecutionContext fields.
 * The object is supplied by the Workers runtime, so normalize that type at the
 * route boundary instead of weakening the internal Worker APIs.
 */
export function workerExecutionContext(ctx: HonoExecutionContext): ExecutionContext {
  return ctx as unknown as ExecutionContext;
}

/**
 * The Worker ExecutionContext when the request has one, otherwise null.
 *
 * Hono's `executionCtx` getter *throws* when there is no execution context, so
 * reading it on a best-effort path turns a request that already did its real
 * work into a 500 — a revoke that committed to D1 would report failure while
 * the link is in fact dead. Background-only callers (cache writes, purges,
 * telemetry) take the null and skip the work instead.
 */
export function optionalWorkerExecutionContext(c: {
  executionCtx: HonoExecutionContext;
}): ExecutionContext | null {
  try {
    return workerExecutionContext(c.executionCtx);
  } catch {
    return null;
  }
}
