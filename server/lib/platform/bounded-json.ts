/**
 * Read a JSON response body under a byte cap and a wall-clock deadline.
 *
 * Returns `null` for a missing body, a body past the cap, a read that runs
 * past the deadline, or unparseable JSON. Callers decorating something that
 * must work without the lookup treat every null the same way: unknown.
 */
export async function readBoundedJson(
  response: Response,
  maxBytes: number,
  deadlineMs: number,
): Promise<unknown> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  const remainingMs = Math.max(0, deadlineMs - Date.now());
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timeoutId = setTimeout(() => resolve(null), remainingMs);
  });

  try {
    while (true) {
      const read = await Promise.race([reader.read(), timeout]);
      if (read === null) {
        void reader.cancel().catch(() => undefined);
        return null;
      }
      if (read.done) break;
      byteLength += read.value.byteLength;
      if (byteLength > maxBytes) {
        void reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(read.value);
    }
  } catch {
    void reader.cancel().catch(() => undefined);
    return null;
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    reader.releaseLock();
  }

  const body = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(body)) as unknown;
  } catch {
    return null;
  }
}
