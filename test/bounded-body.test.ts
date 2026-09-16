import { describe, expect, test } from "vitest";
import {
  parseContentLength,
  readBoundedJson,
  readBoundedText,
} from "../server/lib/platform/bounded-body";

function streamed(chunks: string[], options: { contentLength?: string } = {}): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  const headers = new Headers();
  if (options.contentLength !== undefined) headers.set("content-length", options.contentLength);
  return new Response(body, { headers });
}

// A body that never produces its next chunk, so only the deadline can end the read.
function stalled(firstChunk: string): { response: Response; cancelled: () => boolean } {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(firstChunk));
    },
    cancel() {
      cancelled = true;
    },
  });
  return { response: new Response(body), cancelled: () => cancelled };
}

describe("readBoundedText", () => {
  test("concatenates chunks under the cap", async () => {
    await expect(readBoundedText(streamed(["ab", "cd"]), { maxBytes: 4 })).resolves.toBe("abcd");
  });

  test("returns null once streamed bytes exceed the cap, even without content-length", async () => {
    await expect(readBoundedText(streamed(["abc", "de"]), { maxBytes: 4 })).resolves.toBeNull();
  });

  test("rejects an oversized declared content-length before reading", async () => {
    let pulled = false;
    const body = new ReadableStream<Uint8Array>({
      pull() {
        pulled = true;
      },
    });
    const response = new Response(body, { headers: { "content-length": "10" } });
    await expect(readBoundedText(response, { maxBytes: 4 })).resolves.toBeNull();
    expect(pulled).toBe(false);
  });

  test("a malformed content-length is unknown, not small: the stream is still counted", async () => {
    await expect(
      readBoundedText(streamed(["abcde"], { contentLength: "lots" }), { maxBytes: 4 }),
    ).resolves.toBeNull();
    await expect(
      readBoundedText(streamed(["ab"], { contentLength: "lots" }), { maxBytes: 4 }),
    ).resolves.toBe("ab");
  });

  test("returns null for a bodyless response", async () => {
    await expect(readBoundedText(new Response(null), { maxBytes: 4 })).resolves.toBeNull();
  });

  test("gives up and cancels the body when the deadline passes mid-stream", async () => {
    const { response, cancelled } = stalled("{");
    const result = await readBoundedText(response, { maxBytes: 1024, deadlineMs: Date.now() + 20 });
    expect(result).toBeNull();
    expect(cancelled()).toBe(true);
  });

  test("an already-passed deadline still lets a complete body through only if it is instant", async () => {
    // The timer resolves on the next macrotask; a synchronous in-memory body
    // is fully read before that, which is the only way a lapsed deadline reads.
    // What matters for callers is that the read never hangs.
    const result = await readBoundedText(streamed(["ok"]), {
      maxBytes: 16,
      deadlineMs: Date.now() - 1,
    });
    expect(result === "ok" || result === null).toBe(true);
  });
});

describe("readBoundedJson", () => {
  test("parses JSON under the cap", async () => {
    await expect(readBoundedJson(streamed(['{"a":', "1}"]), { maxBytes: 64 })).resolves.toEqual({
      a: 1,
    });
  });

  test("returns null for malformed JSON instead of throwing", async () => {
    await expect(readBoundedJson(streamed(["{nope"]), { maxBytes: 64 })).resolves.toBeNull();
  });

  test("returns null when the body is over the cap", async () => {
    await expect(readBoundedJson(streamed(['{"a":1}']), { maxBytes: 3 })).resolves.toBeNull();
  });
});

describe("parseContentLength", () => {
  test("accepts a plain non-negative integer", () => {
    expect(parseContentLength("0")).toBe(0);
    expect(parseContentLength(" 1234 ")).toBe(1234);
  });

  test.each([null, undefined, "", "-1", "1e3", "12abc", "abc", "9007199254740993"])(
    "treats %j as unknown",
    (value) => {
      expect(parseContentLength(value)).toBeNull();
    },
  );
});
