// Purges are colo-local and origin-specific; never use them as a correctness boundary.
function coloCache(): Cache {
  return (caches as unknown as { default: Cache }).default;
}

export async function coloCacheMatch(key: Request): Promise<Response | undefined> {
  try {
    return await coloCache().match(key);
  } catch {
    return undefined;
  }
}

export function coloCachePut(ctx: ExecutionContext | null, key: Request, response: Response): void {
  ctx?.waitUntil(
    coloCache()
      .put(key, response)
      .catch(() => {}),
  );
}

export function coloCacheDelete(ctx: ExecutionContext | null, key: Request): void {
  ctx?.waitUntil(
    coloCache()
      .delete(key)
      .catch(() => {}),
  );
}
