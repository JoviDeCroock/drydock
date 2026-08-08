/**
 * The Workers per-colo cache (`caches.default`).
 *
 * Two things to keep in mind at every call site, because neither is obvious
 * from the API:
 *
 * - It is **per colo**, not global. A `delete()` drops the entry in the colo
 *   that handled *that* request and nowhere else, so a purge is an optimization
 *   for the requester's region — never a correctness mechanism. Anything that
 *   must be withdrawn everywhere has to be either uncached or short-TTL'd.
 * - The key is a `Request`, so it includes the origin. Two hostnames bound to
 *   the same Worker are two cache namespaces; a write and its purge must derive
 *   the origin the same way or they will never meet.
 */
// The runtime exposes the colo cache as `caches.default`, but the DOM lib wins
// the global CacheStorage type in this repo's single tsconfig and doesn't know
// the property.
function coloCache(): Cache {
  return (caches as unknown as { default: Cache }).default;
}

/** Cache lookup that treats any cache failure as a miss. */
export async function coloCacheMatch(key: Request): Promise<Response | undefined> {
  try {
    return await coloCache().match(key);
  } catch {
    return undefined;
  }
}

// Both entry points take a nullable context and no-op without one. Everything
// here is background work behind `waitUntil`, so a request with no execution
// context should lose the cache write — never the request.

/** Best-effort background write; a failure only costs a later read-through. */
export function coloCachePut(ctx: ExecutionContext | null, key: Request, response: Response): void {
  ctx?.waitUntil(
    coloCache()
      .put(key, response)
      .catch(() => {}),
  );
}

/** Best-effort background delete. Colo-local — see the note above. */
export function coloCacheDelete(ctx: ExecutionContext | null, key: Request): void {
  ctx?.waitUntil(
    coloCache()
      .delete(key)
      .catch(() => {}),
  );
}
