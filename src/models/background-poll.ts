/**
 * Follows a server-side job (a scan, a dependency review) to a terminal
 * status while its page is open. A self-scheduling timeout chain (not
 * setInterval) lets the cadence adapt: the base delay doubles per consecutive
 * failed read (so an unreachable API isn't hammered at a fixed rate) up to the
 * max, and resets on success. A job that never settles stops the chain after
 * the stall window; the page offers a manual resume.
 */
export const POLL_BASE_DELAY_MS = 10_000;
export const POLL_MAX_DELAY_MS = 30_000;
export const POLL_STALL_AFTER_MS = 10 * 60_000;

/**
 * Starts the chain and returns its stop function. `poll` resolves true when
 * the read succeeded; `onStall` runs once when the stall window elapses.
 */
export function startBackgroundPoll(poll: () => Promise<boolean>, onStall: () => void): () => void {
  let disposed = false;
  let delay = POLL_BASE_DELAY_MS;
  const startedAt = Date.now();

  const tick = async () => {
    if (Date.now() - startedAt >= POLL_STALL_AFTER_MS) {
      onStall();
      return;
    }
    const ok = await poll();
    // The poll can settle the job and stop this chain while it awaited; the
    // flag keeps the stale chain from rescheduling.
    if (disposed) return;
    delay = ok ? POLL_BASE_DELAY_MS : Math.min(delay * 2, POLL_MAX_DELAY_MS);
    timer = setTimeout(() => void tick(), delay);
  };

  let timer = setTimeout(() => void tick(), delay);
  return () => {
    disposed = true;
    clearTimeout(timer);
  };
}
