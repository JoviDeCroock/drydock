type HonoExecutionContext = import("hono").Context["executionCtx"];

/**
 * Hono's context type can lag newly required Workers ExecutionContext fields.
 * The object is supplied by the Workers runtime, so normalize that type at the
 * route boundary instead of weakening the internal Worker APIs.
 */
export function workerExecutionContext(ctx: HonoExecutionContext): ExecutionContext {
  return ctx as unknown as ExecutionContext;
}
