// @ts-check
import { CliError, pathSegment } from "./client.mjs";

const EXIT_TIMEOUT = 4;
const MAX_RETRY_DELAY_MS = 60_000;

/**
 * Polls one review until it completes or fails, or the shared deadline passes.
 * @param {{ client: { json: (path: string, options?: { timeoutMs?: number }) => Promise<any> }; io: { now: () => number; sleep: (ms: number) => Promise<void> } }} ctx
 * @param {string} id
 * @param {{ intervalMs: number; deadline: number }} waiting
 * @param {(scan: any) => void} [onPoll] called after each poll that is still waiting
 * @returns {Promise<any>} the final `GET /scans/:id/status` body
 */
export async function waitForReview(ctx, id, { intervalMs, deadline }, onPoll) {
  const path = `/api/v1/scans/${pathSegment(id, "review id")}/status`;
  let failures = 0;
  for (;;) {
    let body;
    try {
      // A hung request must not outlive the deadline.
      body = await ctx.client.json(path, {
        timeoutMs: Math.max(1000, deadline - ctx.io.now()),
      });
      failures = 0;
    } catch (err) {
      if (!(err instanceof CliError) || !err.retryable) throw err;
      // A rate limit or an outage says nothing about the review, so it is
      // retried with backoff until the deadline instead of exiting as a failure.
      failures++;
      const backoffMs = Math.min(intervalMs * 2 ** (failures - 1), MAX_RETRY_DELAY_MS);
      const delayMs = Math.max(backoffMs, err.retryAfterMs ?? 0);
      if (ctx.io.now() + delayMs > deadline) {
        throw new CliError(
          `could not read review ${id} before the timeout: ${err.message}`,
          EXIT_TIMEOUT,
        );
      }
      await ctx.io.sleep(delayMs);
      continue;
    }
    const { scan } = body;
    if (scan?.status === "complete" || scan?.status === "failed") return body;
    if (ctx.io.now() + intervalMs > deadline) {
      throw new CliError(
        `review ${id} is still ${scan?.status ?? "pending"} after the timeout`,
        EXIT_TIMEOUT,
      );
    }
    onPoll?.(scan);
    await ctx.io.sleep(intervalMs);
  }
}
