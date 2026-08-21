/**
 * Bounded-concurrency fan-out.
 *
 * Workers cap simultaneous subrequests, so every place that fans out over a
 * list of releases, gates or artifacts has to pace itself. Results stay in
 * input order regardless of completion order.
 */

/**
 * Runs `worker` over `items` with at most `concurrency` in flight.
 *
 * Fails fast: the first rejection stops new work from being scheduled, but
 * already-running workers are awaited before the error is rethrown, so no
 * request is left dangling past the request context.
 */
export async function mapWithConcurrency<T, U>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<U>,
): Promise<U[]> {
  if (!items.length) return [];
  const results = new Map<number, U>();
  let next = 0;
  let firstError: unknown = null;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  const runners = Array.from({ length: workerCount }, async () => {
    for (;;) {
      if (firstError) return;
      const index = next;
      next += 1;
      if (index >= items.length) return;
      try {
        results.set(index, await worker(items[index]));
      } catch (err) {
        firstError ??= err;
        return;
      }
    }
  });
  await Promise.all(runners);
  if (firstError) throw firstError;
  return items.map((_, index) => results.get(index)!);
}
