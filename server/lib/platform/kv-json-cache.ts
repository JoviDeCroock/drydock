/**
 * JSON over an optional KV namespace, for caches that must degrade to
 * "no cache" when the binding is absent (local dev, tests) or KV misbehaves.
 *
 * Reads never throw: a KV error is a cache miss. Writes are detached onto the
 * execution context so a slow or failing put never delays the response.
 */
export async function readKvJson<T>(
  namespace: KVNamespace | undefined,
  key: string,
  options: { cacheTtl: number },
): Promise<T | null> {
  if (!namespace) return null;
  try {
    return await namespace.get<T>(key, { type: "json", cacheTtl: options.cacheTtl });
  } catch {
    return null;
  }
}

export function writeKvJson(
  namespace: KVNamespace | undefined,
  ctx: ExecutionContext,
  key: string,
  payload: unknown,
  options: { expirationTtl: number },
): void {
  if (!namespace) return;
  const write = namespace
    .put(key, JSON.stringify(payload), { expirationTtl: options.expirationTtl })
    .catch(() => undefined);
  ctx.waitUntil(write);
}
