// @ts-nocheck
import { deflateRawSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import { normalizeZipPath, readZipArchive } from "../server/lib/tar-parser.js";

const encoder = new TextEncoder();

function u16(view, offset, value) {
  view.setUint16(offset, value, true);
}

function u32(view, offset, value) {
  view.setUint32(offset, value, true);
}

function concat(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function zipEntry(entry, localOffset) {
  const name = encoder.encode(entry.path);
  const body = entry.body instanceof Uint8Array ? entry.body : encoder.encode(entry.body ?? "");
  const compressed = entry.deflate ? new Uint8Array(deflateRawSync(body)) : body;
  const method = entry.deflate ? 8 : 0;

  const local = new Uint8Array(30 + name.length + compressed.length);
  const localView = new DataView(local.buffer);
  u32(localView, 0, 0x04034b50);
  u16(localView, 4, 20);
  u16(localView, 6, 0x0800);
  u16(localView, 8, method);
  u32(localView, 14, 0);
  u32(localView, 18, compressed.length);
  u32(localView, 22, body.length);
  u16(localView, 26, name.length);
  local.set(name, 30);
  local.set(compressed, 30 + name.length);

  const central = new Uint8Array(46 + name.length);
  const centralView = new DataView(central.buffer);
  u32(centralView, 0, 0x02014b50);
  u16(centralView, 4, 20);
  u16(centralView, 6, 20);
  u16(centralView, 8, 0x0800);
  u16(centralView, 10, method);
  u32(centralView, 16, 0);
  u32(centralView, 20, compressed.length);
  u32(centralView, 24, body.length);
  u16(centralView, 28, name.length);
  u32(centralView, 42, localOffset);
  central.set(name, 46);

  return { local, central };
}

function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let localOffset = 0;
  for (const entry of entries) {
    const built = zipEntry(entry, localOffset);
    locals.push(built.local);
    centrals.push(built.central);
    localOffset += built.local.length;
  }
  const centralDirectory = concat(centrals);
  const eocd = new Uint8Array(22);
  const view = new DataView(eocd.buffer);
  u32(view, 0, 0x06054b50);
  u16(view, 8, entries.length);
  u16(view, 10, entries.length);
  u32(view, 12, centralDirectory.length);
  u32(view, 16, localOffset);
  return concat([...locals, centralDirectory, eocd]);
}

const LIMITS = {
  maxFiles: 250,
  maxBytesPerFile: 64 * 1024,
  maxArchiveBytes: 25 * 1024 * 1024,
};

function parse(zip, limits = LIMITS) {
  return readZipArchive(
    zip.buffer,
    limits.maxFiles,
    limits.maxBytesPerFile,
    limits.maxArchiveBytes,
  );
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
