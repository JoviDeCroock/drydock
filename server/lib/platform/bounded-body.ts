/**
 * Bounded response-body readers for remote metadata reads.
 *
 * `response.json()` / `response.text()` let the remote endpoint decide how much
 * memory the Worker spends on what should be a few kilobytes, so every remote
 * metadata read goes through these instead. The contract is deliberately
 * lenient: any failure (declared or streamed size over `maxBytes`, missing
 * body, transport error, deadline passed, malformed JSON) collapses into
 * `null`, because every caller is decorating a result that must degrade rather
 * than throw. Callers that need a typed error wrap the `null` themselves.
 */

export interface BoundedBodyOptions {
  /** Hard ceiling on streamed bytes; the declared `content-length` is checked first. */
  maxBytes: number;
  /**
   * Absolute epoch-ms deadline for the whole body read, so a slow body cannot
   * outlive the caller's own timeout budget. Set it from `Date.now()` once
   * headers have arrived rather than from before the fetch: the fetch helpers
   * clear their abort timer at headers, and a retried request must not inherit
   * a deadline the first attempt already spent.
   *
   * Omitted means the read is bounded by bytes only — which leaves a body that
   * trickles under `maxBytes` unbounded in time, so omit it only for hosts
   * whose availability is already the caller's problem.
   */
  deadlineMs?: number;
}

export async function readBoundedText(
  response: Response,
  options: BoundedBodyOptions,
): Promise<string | null> {
  const declared = parseContentLength(response.headers.get("content-length"));
  if (declared !== null && declared > options.maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  const body = response.body;
  if (!body) return null;

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout =
    options.deadlineMs === undefined
      ? null
      : new Promise<null>((resolve) => {
          timeoutId = setTimeout(
            () => resolve(null),
            Math.max(0, (options.deadlineMs as number) - Date.now()),
          );
        });
  const abandon = () => {
    void reader.cancel().catch(() => undefined);
    return null;
  };

  try {
    for (;;) {
      const read = timeout ? await Promise.race([reader.read(), timeout]) : await reader.read();
      if (read === null) return abandon();
      if (read.done) break;
      total += read.value.byteLength;
      if (total > options.maxBytes) return abandon();
      chunks.push(read.value);
    }
  } catch {
    return abandon();
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    reader.releaseLock();
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

export async function readBoundedJson<T = unknown>(
  response: Response,
  options: BoundedBodyOptions,
): Promise<T | null> {
  const text = await readBoundedText(response, options);
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/**
 * A `content-length` the size check can trust: a non-negative safe integer.
 * Anything else (absent, malformed, overflowing) is `null`, which callers
 * treat as "unknown, stream and count", never as "small".
 */
export function parseContentLength(value: string | null | undefined): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}
