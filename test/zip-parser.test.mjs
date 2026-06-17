// @ts-nocheck
import { describe, expect, test } from "vitest";
import { normalizeZipPath, readStreamBounded, readZipArchive } from "../server/lib/tar-parser.js";
import { buildZip } from "./helpers/archive-fixtures.mjs";

const LIMITS = {
  maxFiles: 2_500,
  maxArchiveBytes: 25 * 1024 * 1024,
};

function parse(zip, limits = LIMITS) {
  return readZipArchive(zip.buffer, limits.maxFiles, limits.maxArchiveBytes);
}

describe("normalizeZipPath", () => {
  test("accepts relative archive paths and rejects traversal", () => {
    expect(normalizeZipPath("pkg/__init__.py")).toBe("pkg/__init__.py");
    expect(normalizeZipPath("../escape.py")).toBeNull();
    expect(normalizeZipPath("pkg/../escape.py")).toBeNull();
    expect(normalizeZipPath("C:escape.py")).toBeNull();
    expect(normalizeZipPath("pkg\\escape.py")).toBeNull();
  });
});

describe("readZipArchive", () => {
  test("reads stored and deflated wheel entries", async () => {
    const zip = buildZip([
      { path: "demo/__init__.py", body: "__version__ = '1.0.0'\n" },
      {
        path: "demo-1.0.0.dist-info/METADATA",
        body: "Metadata-Version: 2.3\nName: demo\nVersion: 1.0.0\n",
        deflate: true,
      },
    ]);
    const files = await parse(zip);
    expect(files.map((file) => file.path)).toEqual([
      "demo/__init__.py",
      "demo-1.0.0.dist-info/METADATA",
    ]);
    expect(files[1].textSample).toContain("Name: demo");
    expect(files[1].flags).toEqual([]);
  });

  test("drops unsafe zip entry paths while keeping safe siblings", async () => {
    const zip = buildZip([
      { path: "../escape.py", body: "bad\n" },
      { path: "demo/good.py", body: "ok\n" },
    ]);
    const files = await parse(zip);
    expect(files.map((file) => file.path)).toEqual(["demo/good.py"]);
  });
});

describe("readStreamBounded", () => {
  test("rejects downloads that exceed the configured cap while reading", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(8));
        controller.enqueue(new Uint8Array(8));
        controller.close();
      },
    });

    await expect(readStreamBounded(stream, 12)).rejects.toThrow(/archive too large/);
  });
});
