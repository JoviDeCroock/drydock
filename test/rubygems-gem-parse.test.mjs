// @ts-nocheck
import { gzipSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import { readGem, readTarRawEntries } from "../server/lib/tar-parser.js";

// Minimal ustar tar writer (mirrors test/tar-parser.test.mjs) used to assemble
// both the inner `data.tar` and the outer `.gem` container in-memory.
const BLOCK = 512;
const encoder = new TextEncoder();

function pad(bytes, length) {
  const out = new Uint8Array(length);
  out.set(bytes.subarray(0, length), 0);
  return out;
}

function octal(value, length) {
  return pad(encoder.encode(value.toString(8).padStart(length - 1, "0") + "\0"), length);
}

function header({ name = "", size = 0, type = "0", prefix = "" }) {
  const buf = new Uint8Array(BLOCK);
  buf.set(pad(encoder.encode(name), 100), 0);
  buf.set(pad(encoder.encode("0000644"), 8), 100);
  buf.set(octal(size, 12), 124);
  buf.set(pad(encoder.encode("        "), 8), 148);
  buf[156] = type.charCodeAt(0);
  buf.set(pad(encoder.encode("ustar"), 6), 257);
  buf.set(pad(encoder.encode("00"), 2), 263);
  buf.set(pad(encoder.encode(prefix), 155), 345);
  return buf;
}

function buildTar(entries) {
  const parts = [];
  for (const entry of entries) {
    const bytes = entry.body instanceof Uint8Array ? entry.body : encoder.encode(entry.body ?? "");
    parts.push(header({ ...entry, size: bytes.length }));
    const padded = Math.ceil(bytes.length / BLOCK) * BLOCK;
    const body = new Uint8Array(padded);
    body.set(bytes, 0);
    parts.push(body);
  }
  parts.push(new Uint8Array(BLOCK * 2));
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function buildGem({ files, metadata, extraMembers = [] } = {}) {
  const dataTar = buildTar(files);
  const dataGz = gzipSync(Buffer.from(dataTar));
  const metaGz = gzipSync(Buffer.from(metadata ?? ""));
  return buildTar([
    { name: "metadata.gz", body: new Uint8Array(metaGz) },
    { name: "data.tar.gz", body: new Uint8Array(dataGz) },
    { name: "checksums.yaml.gz", body: new Uint8Array(gzipSync(Buffer.from("---\n"))) },
    ...extraMembers,
  ]);
}

const LIMITS = [2_500, 25 * 1024 * 1024];

const METADATA = `--- !ruby/object:Gem::Specification
name: example
version: !ruby/object:Gem::Version
  version: 1.2.3
`;

describe("readGem", () => {
  test("extracts inner data files and the raw gemspec metadata", async () => {
    const gem = buildGem({
      files: [
        { name: "lib/example.rb", body: "puts 'hi'\n" },
        { name: "bin/example", body: "#!/usr/bin/env ruby\n" },
      ],
      metadata: METADATA,
    });

    const result = await readGem(gem, ...LIMITS);

    expect(result.files.map((f) => f.path).sort()).toEqual(["bin/example", "lib/example.rb"]);
    expect(result.files.find((f) => f.path === "lib/example.rb").textSample).toContain("puts");
    expect(result.gemMetadata).toContain("name: example");
    expect(result.gemMetadata).toContain("version: 1.2.3");
  });

  test("surfaces suspicious entries from the inner data tar", async () => {
    const gem = buildGem({
      files: [
        { name: "lib/example.rb", body: "x = 1\n" },
        { name: "ext/evil/link", type: "2", body: "" }, // symlink
      ],
      metadata: METADATA,
    });

    const result = await readGem(gem, ...LIMITS);
    expect(result.suspicious.some((s) => s.kind === "non-regular")).toBe(true);
  });

  test("preserves package-prefixed paths inside gem data archives", async () => {
    const gem = buildGem({
      files: [
        { name: "lib/example.rb", body: "root = true\n" },
        { name: "package/lib/example.rb", body: "nested = true\n" },
      ],
      metadata: METADATA,
    });

    const result = await readGem(gem, ...LIMITS);

    expect(result.files.map((f) => f.path).sort()).toEqual([
      "lib/example.rb",
      "package/lib/example.rb",
    ]);
  });

  test("returns null metadata when metadata.gz is absent but still parses files", async () => {
    // Hand-built gem with only a data member (no metadata.gz).
    const dataGz = gzipSync(Buffer.from(buildTar([{ name: "lib/x.rb", body: "x\n" }])));
    const gem = buildTar([{ name: "data.tar.gz", body: new Uint8Array(dataGz) }]);
    const result = await readGem(gem, ...LIMITS);
    expect(result.gemMetadata).toBeNull();
    expect(result.files.map((f) => f.path)).toEqual(["lib/x.rb"]);
  });

  test("throws when the data archive member is missing", async () => {
    const gem = buildTar([
      { name: "metadata.gz", body: new Uint8Array(gzipSync(Buffer.from(METADATA))) },
    ]);
    await expect(readGem(gem, ...LIMITS)).rejects.toThrow(/missing data archive/);
  });

  test("throws instead of parsing truncated gemspec metadata", async () => {
    const oversizedMetadata = METADATA + "\n".repeat(262145);
    const gem = buildGem({
      files: [{ name: "lib/example.rb", body: "x\n" }],
      metadata: oversizedMetadata,
    });

    await expect(readGem(gem, ...LIMITS)).rejects.toThrow(/metadata too large/);
  });

  test("readTarRawEntries returns only the requested members verbatim", async () => {
    const gem = buildGem({ files: [{ name: "lib/x.rb", body: "x\n" }], metadata: METADATA });
    const members = await readTarRawEntries(gem, ["metadata.gz", "data.tar.gz"], LIMITS[1]);
    expect([...members.keys()].sort()).toEqual(["data.tar.gz", "metadata.gz"]);
    expect(members.get("metadata.gz")).toBeInstanceOf(Uint8Array);
  });
});
