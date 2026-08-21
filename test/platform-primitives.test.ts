import { describe, expect, test } from "vitest";
import { mapWithConcurrency } from "../server/lib/platform/concurrency";
import { isRecord } from "../server/lib/platform/guards";
import { escapeHtmlAttribute, escapeHtmlText, escapeXml } from "../server/lib/platform/html-escape";
import { isSafeManifestPath } from "../server/lib/platform/path-safety";

// These four primitives are each shared by several call sites, so a regression
// in one of them is a regression everywhere at once. isSafeManifestPath in
// particular guards every ecosystem's manifest parser against path traversal:
// before it was hoisted here it existed as three copies, and a weakening edit
// could only ever affect one ecosystem. Now it can affect all three, which is
// exactly why the behavior is pinned rather than left to the callers' tests.
describe("isSafeManifestPath", () => {
  test("accepts ordinary relative archive paths", () => {
    expect(isSafeManifestPath("package.json")).toBe(true);
    expect(isSafeManifestPath("lib/index.js")).toBe(true);
    expect(isSafeManifestPath("a/b/c/d.txt")).toBe(true);
    expect(isSafeManifestPath("dist/.keep")).toBe(true);
    expect(isSafeManifestPath("weird name (1).js")).toBe(true);
  });

  test("rejects traversal out of the archive root", () => {
    expect(isSafeManifestPath("../secrets")).toBe(false);
    expect(isSafeManifestPath("lib/../../secrets")).toBe(false);
    expect(isSafeManifestPath("a/../b")).toBe(false);
    expect(isSafeManifestPath("..")).toBe(false);
  });

  test("rejects absolute and drive-qualified paths", () => {
    expect(isSafeManifestPath("/etc/passwd")).toBe(false);
    expect(isSafeManifestPath("C:/Windows/system32")).toBe(false);
    expect(isSafeManifestPath("c:tmp")).toBe(false);
  });

  test("rejects backslashes, which a Windows consumer would resolve as separators", () => {
    expect(isSafeManifestPath("lib\\index.js")).toBe(false);
    expect(isSafeManifestPath("..\\secrets")).toBe(false);
  });

  test("rejects NUL, which can truncate a path in a native consumer", () => {
    expect(isSafeManifestPath("package.json\0.js")).toBe(false);
  });

  test("rejects empty, dot, and empty-segment paths", () => {
    expect(isSafeManifestPath("")).toBe(false);
    expect(isSafeManifestPath(".")).toBe(false);
    expect(isSafeManifestPath("a//b")).toBe(false);
    expect(isSafeManifestPath("a/./b")).toBe(false);
    expect(isSafeManifestPath("/")).toBe(false);
  });

  test("caps path length at 512 characters", () => {
    expect(isSafeManifestPath("a".repeat(512))).toBe(true);
    expect(isSafeManifestPath("a".repeat(513))).toBe(false);
  });
});

describe("isRecord", () => {
  test("accepts plain objects", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord(Object.create(null))).toBe(true);
  });

  test("rejects arrays, null, and primitives", () => {
    // Arrays and null are the two that matter: every caller narrows parsed
    // JSON with this before indexing into it.
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
    expect(isRecord(0)).toBe(false);
    expect(isRecord("")).toBe(false);
    expect(isRecord("{}")).toBe(false);
    expect(isRecord(false)).toBe(false);
  });
});

describe("mapWithConcurrency", () => {
  test("preserves input order regardless of completion order", async () => {
    const result = await mapWithConcurrency([30, 10, 20], 3, async (ms) => {
      await new Promise((resolve) => setTimeout(resolve, ms / 10));
      return ms;
    });
    expect(result).toEqual([30, 10, 20]);
  });

  test("returns an empty array for empty input without invoking the worker", async () => {
    let calls = 0;
    expect(
      await mapWithConcurrency([], 4, async () => {
        calls += 1;
        return 1;
      }),
    ).toEqual([]);
    expect(calls).toBe(0);
  });

  test("never runs more than `concurrency` workers at once", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(
      Array.from({ length: 20 }, (_, i) => i),
      3,
      async (i) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
        return i;
      },
    );
    expect(peak).toBeLessThanOrEqual(3);
  });

  test("clamps concurrency to at least one rather than silently returning holes", async () => {
    // The pre-consolidation copies computed `Math.min(concurrency, length)`,
    // so a zero here started no workers at all and resolved to an array of
    // `undefined` — a silent wrong answer rather than an error.
    expect(await mapWithConcurrency([1, 2, 3], 0, async (n) => n * 2)).toEqual([2, 4, 6]);
  });

  test("rethrows the first error and stops scheduling new work", async () => {
    const started: number[] = [];
    const boom = new Error("boom");
    await expect(
      mapWithConcurrency([0, 1, 2, 3, 4, 5, 6, 7], 1, async (n) => {
        started.push(n);
        if (n === 1) throw boom;
        return n;
      }),
    ).rejects.toBe(boom);
    // Serial worker: item 2 onwards must never have been started.
    expect(started).toEqual([0, 1]);
  });

  test("awaits in-flight workers before rethrowing, leaving nothing dangling", async () => {
    // Workers outliving the rejection is what makes an unhandled rejection
    // escape the request context in a Worker.
    let settled = 0;
    await expect(
      mapWithConcurrency([0, 1], 2, async (n) => {
        if (n === 0) throw new Error("boom");
        await new Promise((resolve) => setTimeout(resolve, 5));
        settled += 1;
        return n;
      }),
    ).rejects.toThrow("boom");
    expect(settled).toBe(1);
  });
});

describe("markup escaping", () => {
  test("escapeHtmlText covers the characters that matter between tags", () => {
    expect(escapeHtmlText(`<script>alert(1)</script>`)).toBe(
      "&lt;script&gt;alert(1)&lt;/script&gt;",
    );
    expect(escapeHtmlText("a & b")).toBe("a &amp; b");
  });

  test("escapeHtmlText escapes the ampersand first, so entities are not doubled", () => {
    expect(escapeHtmlText("&lt;")).toBe("&amp;lt;");
  });

  test("escapeHtmlAttribute also escapes both quote styles", () => {
    expect(escapeHtmlAttribute(`" onerror="alert(1)`)).toBe("&quot; onerror=&quot;alert(1)");
    expect(escapeHtmlAttribute("' onerror='alert(1)")).toBe("&#39; onerror=&#39;alert(1)");
  });

  test("escapeXml uses &apos;, which is defined in XML but not HTML4", () => {
    expect(escapeXml(`<a href="x">&'`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&apos;");
  });
});
