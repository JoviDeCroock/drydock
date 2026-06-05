import { describe, expect, test, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {},
}));

const { stripTextSamples } = await import("../server/lib/compare-cache.ts");

describe("stripTextSamples", () => {
  test("removes textSample from file records", () => {
    const files = [
      { path: "index.js", size: 100, sha256: "abc", textSample: "console.log('hi')", flags: [] },
      { path: "readme.md", size: 50, sha256: "def", textSample: "# Hello", flags: ["doc"] },
    ];
    const result = stripTextSamples(files);
    expect(result).toEqual([
      { path: "index.js", size: 100, sha256: "abc", flags: [] },
      { path: "readme.md", size: 50, sha256: "def", flags: ["doc"] },
    ]);
  });

  test("handles files without textSample", () => {
    const files = [{ path: "bin.wasm", size: 200, sha256: "ghi", flags: ["binary"] }];
    const result = stripTextSamples(files);
    expect(result).toEqual([{ path: "bin.wasm", size: 200, sha256: "ghi", flags: ["binary"] }]);
  });

  test("returns empty array for empty input", () => {
    expect(stripTextSamples([])).toEqual([]);
  });

  test("does not mutate the original array", () => {
    const files = [{ path: "a.js", size: 10, sha256: "x", textSample: "let a = 1;", flags: [] }];
    const result = stripTextSamples(files);
    expect(files[0]).toHaveProperty("textSample");
    expect(result[0]).not.toHaveProperty("textSample");
  });
});
