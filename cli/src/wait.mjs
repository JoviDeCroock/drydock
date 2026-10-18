// @ts-check
import { CliError, pathSegment } from "./client.mjs";

const EXIT_TIMEOUT = 4;

/**
 * Polls one review until it completes or fails, or the shared deadline passes.
 * @param {{ client: { json: (path: string) => Promise<any> }; io: { now: () => number; sleep: (ms: number) => Promise<void> } }} ctx
 * @param {string} id
 * @param {{ intervalMs: number; deadline: number }} waiting
 * @param {(scan: any) => void} [onPoll] called after each poll that is still waiting
 * @returns {Promise<any>} the review's final status
 */
export async function waitForReview(ctx, id, { intervalMs, deadline }, onPoll) {
  const path = `/api/v1/scans/${pathSegment(id, "review id")}/status`;
  for (;;) {
    const { scan } = await ctx.client.json(path);
    if (scan?.status === "complete" || scan?.status === "failed") return scan;
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
