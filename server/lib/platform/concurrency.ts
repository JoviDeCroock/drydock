// Stop scheduling after the first failure, but await work already in flight.
export async function mapWithConcurrency<T, U>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<U>,
): Promise<U[]> {
  if (!items.length) return [];
  const results = new Map<number, U>();
  let next = 0;
  let failed = false;
  let firstError: unknown;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  const runners = Array.from({ length: workerCount }, async () => {
    for (;;) {
      if (failed) return;
      const index = next;
      next += 1;
      if (index >= items.length) return;
      try {
        results.set(index, await worker(items[index]));
      } catch (err) {
        if (!failed) {
          failed = true;
          firstError = err;
        }
        return;
      }
    }
  });
  await Promise.all(runners);
  if (failed) throw firstError;
  return items.map((_, index) => results.get(index)!);
}
