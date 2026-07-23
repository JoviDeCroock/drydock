// @ts-nocheck
import { deflateRawSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import {
  normalizeZipPath,
  readStreamBounded,
  readZipArchive,
  readZipArchiveBuffered,
  readZipStream,
  sha256Hex,
} from "../server/lib/tar-parser.js";
import { buildZip, encoder } from "./helpers/archive-fixtures.mjs";

const LIMITS = {
  maxFiles: 2_500,
  maxArchiveBytes: 25 * 1024 * 1024,
};

function parse(zip, limits = LIMITS) {
  return readZipArchive(zip.buffer, limits.maxFiles, limits.maxArchiveBytes);
}

function chunkedStream(bytes, chunkSize = 100) {
  return new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize) {
        controller.enqueue(bytes.subarray(i, Math.min(i + chunkSize, bytes.length)));
      }
      controller.close();
    },
  });
}

// Byte length of the LOCAL record buildZip writes for an entry — used to
// splice locals and central directories from different builds when crafting
// local/central mismatches.
function localRecordLength(entry) {
  const body = encoder.encode(entry.body ?? "");
  const compressed = entry.deflate ? deflateRawSync(body).length : body.length;
  return 30 + entry.path.length + compressed;
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

describe("readZipStream", () => {
  const STREAM_LIMITS = { maxFiles: 100, maxTarBytes: 1024, maxStreamBytes: 1 << 20 };

  function parseStream(zip, limits = STREAM_LIMITS) {
    return readZipStream(
      chunkedStream(zip),
      limits.maxFiles,
      limits.maxTarBytes,
      limits.maxStreamBytes,
    );
  }

  test("parses chunked input identically to the buffered wrapper", async () => {
    const zip = buildZip([
      { path: "demo/__init__.py", body: "__version__ = '1.0.0'\n" },
      { path: "demo-1.0.0.dist-info/METADATA", body: "Name: demo\n", deflate: true },
    ]);
    const streamed = await parseStream(zip, {
      maxFiles: LIMITS.maxFiles,
      maxTarBytes: LIMITS.maxArchiveBytes,
      maxStreamBytes: LIMITS.maxArchiveBytes,
    });
    const buffered = await parse(zip);
    expect(streamed.files).toEqual(buffered);
    expect(streamed.suspicious).toEqual([]);
  });

  test("skips an oversized stored entry but records its metadata and hash", async () => {
    const big = new Uint8Array(2048).fill(0x42);
    const zip = buildZip([
      { path: "demo/__init__.py", body: "ok\n" },
      { path: "demo/lib/native.so", body: big },
      { path: "demo/after.py", body: "# after\n" },
    ]);
    const { files, suspicious } = await parseStream(zip);
    expect(files.map((f) => f.path)).toEqual([
      "demo/__init__.py",
      "demo/lib/native.so",
      "demo/after.py",
    ]);
    const skipped = files[1];
    expect(skipped.size).toBe(2048);
    expect(skipped.sha256).toBe(await sha256Hex(big));
    expect(skipped.flags).toEqual(["content-skipped"]);
    expect(skipped.textSample).toBeUndefined();
    // Entries after the skipped body are still fully parsed.
    expect(files[2].textSample).toBe("# after\n");
    expect(suspicious).toEqual([
      {
        kind: "content-skipped",
        path: "demo/lib/native.so",
        detail: expect.stringContaining("2048 bytes"),
      },
    ]);
  });

  test("demotes bodies past the full-inspection tier instead of failing the parse", async () => {
    // Two-tier cap: maxFiles bounds text retention, maxEntries bounds the
    // walk. Platform wheels with thousands of files parse; tail files are
    // hash-only with a single archive-level notice.
    const zip = buildZip([
      { path: "demo/a.py", body: "a = 1\n" },
      { path: "demo/b.py", body: "b = 2\n" },
      { path: "demo/c.py", body: "c = 3\n" },
      { path: "demo/d.py", body: "d = 4\n" },
    ]);
    const { files, suspicious } = await readZipStream(chunkedStream(zip), 2, 1024, 1 << 20, 10);
    expect(files).toHaveLength(4);
    expect(files[0].textSample).toBe("a = 1\n");
    expect(files[1].textSample).toBe("b = 2\n");
    for (const tail of files.slice(2)) {
      expect(tail.flags).toContain("content-skipped");
      expect(tail.textSample).toBeUndefined();
      expect(tail.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(suspicious).toEqual([
      expect.objectContaining({
        kind: "retention-tier",
        path: "<archive>",
        detail: expect.stringContaining("2-file full-inspection tier"),
      }),
    ]);
    expect(suspicious[0].detail).toContain("2 additional file bodies");
  });

  test("still fails the parse past the hard entry cap", async () => {
    const zip = buildZip(
      Array.from({ length: 6 }, (_, i) => ({ path: `demo/f${i}.py`, body: "x\n" })),
    );
    await expect(readZipStream(chunkedStream(zip), 2, 1024, 1 << 20, 5)).rejects.toThrow(
      /archive contains too many files/,
    );
  });

  test("retains a wheel METADATA past the full-inspection tier", async () => {
    const zip = buildZip([
      { path: "demo/a.py", body: "a = 1\n" },
      { path: "demo/b.py", body: "b = 2\n" },
      {
        path: "demo-1.0.0.dist-info/METADATA",
        body: "Metadata-Version: 2.3\nName: demo\nVersion: 1.0.0\n",
      },
    ]);
    const { files } = await readZipStream(chunkedStream(zip), 2, 1024, 1 << 20, 10);
    const manifest = files.find((file) => file.path.endsWith("METADATA"));
    expect(manifest?.textSample).toContain("Name: demo");
    expect(manifest?.flags ?? []).not.toContain("content-skipped");
  });

  test("hashes an oversized deflated entry through streaming inflate", async () => {
    const big = new Uint8Array(4096);
    for (let i = 0; i < big.length; i += 1) big[i] = i % 251;
    const zip = buildZip([{ path: "demo/blob.bin", body: big, deflate: true }]);
    const { files } = await parseStream(zip);
    expect(files[0].sha256).toBe(await sha256Hex(big));
    expect(files[0].flags).toEqual(["content-skipped"]);
  });

  test("sniffs native magic from the decompressed head of skipped entries", async () => {
    const elfStored = new Uint8Array(2048);
    elfStored.set([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00], 0);
    const elfDeflated = new Uint8Array(4096);
    elfDeflated.set([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00], 0);
    const zip = buildZip([
      { path: "demo/bin/tool-linux-x64", body: elfStored },
      { path: "demo/bin/tool-linux-arm64", body: elfDeflated, deflate: true },
    ]);
    const { files } = await parseStream(zip);
    expect(files[0].flags).toEqual(["content-skipped", "native-elf"]);
    expect(files[1].flags).toEqual(["content-skipped", "native-elf"]);
  });

  test("skips entries once the cumulative retention budget is exhausted", async () => {
    const bodyA = new Uint8Array(600).fill(0x61);
    const bodyB = new Uint8Array(600).fill(0x62);
    const zip = buildZip([
      { path: "demo/a.bin", body: bodyA },
      { path: "demo/b.bin", body: bodyB },
    ]);
    const { files } = await parseStream(zip, { ...STREAM_LIMITS, maxTarBytes: 1000 });
    expect(files[0].sha256).toBe(await sha256Hex(bodyA));
    expect(files[0].flags).toEqual([]);
    expect(files[1].sha256).toBe(await sha256Hex(bodyB));
    expect(files[1].flags).toEqual(["content-skipped"]);
  });

  test("retains a wheel METADATA manifest through bounded headroom after the budget is spent", async () => {
    const filler = new Uint8Array(990).fill(0x61);
    const metadataBody = "Name: demo\nVersion: 1.0.0\n".padEnd(50, "#");
    const zip = buildZip([
      { path: "demo/filler.bin", body: filler },
      { path: "demo-1.0.0.dist-info/METADATA", body: metadataBody },
      { path: "demo/after.bin", body: new Uint8Array(300).fill(0x62) },
    ]);
    const { files } = await parseStream(zip, { ...STREAM_LIMITS, maxTarBytes: 1000 });
    // The manifest lands past the shared budget but inside the bounded 2× headroom…
    expect(files.find((f) => f.path.endsWith("METADATA"))?.textSample).toContain("Name: demo");
    // …while a non-manifest sibling past the budget is still skipped.
    expect(files.find((f) => f.path === "demo/after.bin")?.flags).toEqual(["content-skipped"]);
  });

  test("skips (rather than fails) a manifest exceeding the per-file inspection limit", async () => {
    const big = new Uint8Array(3000).fill(0x4d);
    const zip = buildZip([{ path: "demo-1.0.0.dist-info/METADATA", body: big }]);
    const { files } = await parseStream(zip);
    expect(files[0].flags).toEqual(["content-skipped"]);
    expect(files[0].sha256).toBe(await sha256Hex(big));
  });

  test("streams a retained deflated entry whose compressed payload dwarfs its size", async () => {
    // A valid deflate stream can be padded with empty stored blocks
    // (00 00 00 ff ff), making the compressed payload arbitrarily larger than
    // the tiny declared uncompressed size. The retained path must stream it
    // through inflate — never buffer the compressed payload — and still
    // produce the exact body.
    const body = "print('hi')\n";
    const emptyBlock = Uint8Array.from([0x00, 0x00, 0x00, 0xff, 0xff]);
    const realDeflate = new Uint8Array(deflateRawSync(Buffer.from(body)));
    const padded = new Uint8Array(emptyBlock.length * 400 + realDeflate.length);
    for (let i = 0; i < 400; i += 1) padded.set(emptyBlock, i * emptyBlock.length);
    padded.set(realDeflate, emptyBlock.length * 400);
    expect(padded.length).toBeGreaterThan(1024); // dwarfs maxTarBytes

    const zip = buildZip([{ path: "demo/tiny.py", body, rawDeflate: padded }]);
    const { files, suspicious } = await parseStream(zip, {
      ...STREAM_LIMITS,
      maxStreamBytes: 1 << 20,
    });
    expect(files[0].flags).toEqual([]);
    expect(files[0].textSample).toBe(body);
    expect(suspicious).toEqual([]);
  });

  test("fails closed when a deflated entry inflates past its declared size", async () => {
    const body = "x".repeat(500);
    const zip = buildZip([{ path: "demo/liar.py", body, rawDeflate: undefined, deflate: true }]);
    // Corrupt the declared uncompressed size in the LOCAL header (offset 22)
    // and matching CENTRAL record (offset 24 within the CD entry) to claim a
    // smaller body than the deflate stream actually produces.
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    view.setUint32(22, 100, true);
    const cdOffset = zip.length - 22 - (46 + "demo/liar.py".length);
    view.setUint32(cdOffset + 24, 100, true);
    await expect(parseStream(zip)).rejects.toThrow(/zip entry size mismatch/);
  });

  test("a duplicate that fits after releasing the replaced entry's budget is retained", async () => {
    // The duplicate replaces the earlier body under last-write-wins, so its
    // budget check must exclude the earlier copy's contribution — otherwise
    // the very bytes a consumer receives would go uninspected.
    const zip = buildZip([
      { path: "demo/big.txt", body: "a".repeat(900) },
      { path: "demo/big.txt", body: "b".repeat(800) },
    ]);
    const { files, suspicious } = await parseStream(zip, { ...STREAM_LIMITS, maxTarBytes: 1000 });
    expect(files).toHaveLength(1);
    expect(files[0].flags).toEqual([]);
    expect(files[0].textSample).toBe("b".repeat(800));
    expect(suspicious.map((s) => s.kind)).toEqual(["duplicate"]);
  });

  test("resolves duplicate paths last-write-wins and flags the duplicate", async () => {
    const zip = buildZip([
      { path: "demo/mod.py", body: "one\n" },
      { path: "demo/mod.py", body: "two\n" },
    ]);
    const { files, suspicious } = await parseStream(zip);
    expect(files).toHaveLength(1);
    expect(files[0].textSample).toBe("two\n");
    expect(suspicious).toEqual([
      { kind: "duplicate", path: "demo/mod.py", detail: expect.stringContaining("duplicate") },
    ]);
  });

  test("fails closed when the central directory reorders duplicate entries", async () => {
    // zipfile resolves duplicate names by CENTRAL-directory order (last CD
    // record wins in NameToInfo) while the scanner walked locals in order —
    // a CD listing duplicates in a different order would hand consumers the
    // body the scanner replaced. Each swapped record still matches its local
    // entry, so only the winner cross-check can catch this.
    const zip = buildZip([
      { path: "demo/mod.py", body: "one\n" },
      { path: "demo/mod.py", body: "two\n" },
    ]);
    const recLen = 46 + "demo/mod.py".length;
    const cdStart = zip.length - 22 - 2 * recLen;
    const swapped = zip.slice();
    swapped.set(zip.subarray(cdStart + recLen, cdStart + 2 * recLen), cdStart);
    swapped.set(zip.subarray(cdStart, cdStart + recLen), cdStart + recLen);
    await expect(parseStream(swapped)).rejects.toThrow(
      /central directory does not match local entries/,
    );
  });

  test("duplicate records still count toward the file-count cap", async () => {
    // Duplicates replace their earlier entry, so distinct-path counting alone
    // would let thousands of records for one path bypass the cap while every
    // body is still parsed and hashed.
    const entries = Array.from({ length: 6 }, () => ({ path: "demo/dup.py", body: "x\n" }));
    const zip = buildZip(entries);
    await expect(parseStream(zip, { ...STREAM_LIMITS, maxFiles: 5 })).rejects.toThrow(
      /archive contains too many files/,
    );
  });

  test("parses an empty archive", async () => {
    const { files, suspicious } = await parseStream(buildZip([]));
    expect(files).toEqual([]);
    expect(suspicious).toEqual([]);
  });

  test("fails closed when the central directory renames a local entry", async () => {
    const zip = buildZip([{ path: "demo/good.py", body: "ok\n" }]);
    // Corrupt the CENTRAL copy of the filename (the local copy stays intact):
    // the scanner walked local headers, consumers read the central directory,
    // so any disagreement must reject the archive.
    const nameBytes = encoder.encode("demo/good.py");
    let centralNameOffset = -1;
    for (let i = zip.length - 1; i >= 0; i -= 1) {
      if (
        zip[i] === nameBytes[0] &&
        zip.subarray(i, i + nameBytes.length).every((b, j) => b === nameBytes[j])
      ) {
        centralNameOffset = i;
        break;
      }
    }
    expect(centralNameOffset).toBeGreaterThan(0);
    const corrupted = zip.slice();
    corrupted[centralNameOffset] = "x".charCodeAt(0);
    await expect(parseStream(corrupted)).rejects.toThrow(
      /central directory does not match local entries/,
    );
  });

  test("fails closed when a local entry is hidden from the central directory", async () => {
    const entryA = { path: "demo/a.py", body: "a\n" };
    const entryB = { path: "demo/b.py", body: "b\n" };
    const both = buildZip([entryA, entryB]);
    const onlyA = buildZip([entryA]);
    // Locals for A and B, but a central directory listing only A: B is a file
    // the scanner saw but consumers would never extract.
    const crafted = new Uint8Array(
      localRecordLength(entryA) +
        localRecordLength(entryB) +
        (onlyA.length - localRecordLength(entryA)),
    );
    crafted.set(both.subarray(0, localRecordLength(entryA) + localRecordLength(entryB)), 0);
    crafted.set(
      onlyA.subarray(localRecordLength(entryA)),
      localRecordLength(entryA) + localRecordLength(entryB),
    );
    await expect(parseStream(crafted)).rejects.toThrow(
      /central directory does not match local entries/,
    );
  });

  test("fails closed when the central directory lists an entry with no local header", async () => {
    const entryA = { path: "demo/a.py", body: "a\n" };
    const entryB = { path: "demo/b.py", body: "b\n" };
    const both = buildZip([entryA, entryB]);
    const onlyA = buildZip([entryA]);
    // Local for A only, but the central directory of the two-entry archive:
    // record B points at an offset holding no local header.
    const crafted = new Uint8Array(
      localRecordLength(entryA) +
        (both.length - localRecordLength(entryA) - localRecordLength(entryB)),
    );
    crafted.set(onlyA.subarray(0, localRecordLength(entryA)), 0);
    crafted.set(
      both.subarray(localRecordLength(entryA) + localRecordLength(entryB)),
      localRecordLength(entryA),
    );
    await expect(parseStream(crafted)).rejects.toThrow(
      /central directory does not match local entries/,
    );
  });

  test("rejects data-descriptor entries", async () => {
    const zip = buildZip([{ path: "demo/a.py", body: "a\n" }]);
    zip[6] |= 0x08; // set bit 3 (streamed sizes) in the first local header
    await expect(parseStream(zip)).rejects.toThrow(/data-descriptor/);
  });

  test("rejects encrypted entries", async () => {
    const zip = buildZip([{ path: "demo/a.py", body: "a\n" }]);
    zip[6] |= 0x01; // set bit 0 (encryption) in the first local header
    await expect(parseStream(zip)).rejects.toThrow(/encrypted/);
  });

  test("rejects trailing data after the end of central directory", async () => {
    const zip = buildZip([{ path: "demo/a.py", body: "a\n" }]);
    const extended = new Uint8Array(zip.length + 16);
    extended.set(zip, 0);
    extended.fill(0x66, zip.length);
    await expect(parseStream(extended)).rejects.toThrow(/trailing data/);
  });

  test("fails closed when cumulative declared expansion exceeds the stream cap", async () => {
    const big = new Uint8Array(4096).fill(0x41);
    const zip = buildZip([{ path: "demo/big.bin", body: big }]);
    await expect(
      parseStream(zip, { maxFiles: 100, maxTarBytes: 512, maxStreamBytes: 2048 }),
    ).rejects.toThrow(/expands beyond safety limit/);
  });

  test("rejects yazl-style data-descriptor entries (VSIX takes the buffered path)", async () => {
    const zip = buildZip([
      {
        path: "extension/extension.js",
        body: "exports.activate = () => {};\n",
        dataDescriptor: true,
      },
    ]);
    await expect(parseStream(zip)).rejects.toThrow(/data-descriptor/);
  });
});

describe("readZipArchiveBuffered", () => {
  // The CD-first buffered path VSIX archives require: vsce packs with yazl,
  // whose streamed entries set bit 3 and put their sizes in a data descriptor
  // after the entry data. Only the central directory is authoritative there —
  // which is also exactly what VS Code / yauzl read.
  test("parses data-descriptor entries via the central directory", async () => {
    const zip = buildZip([
      {
        path: "extension/package.json",
        body: JSON.stringify({ name: "demo", publisher: "example", version: "1.0.0" }),
        dataDescriptor: true,
        deflate: true,
      },
      {
        path: "extension/extension.js",
        body: "exports.activate = () => {};\n",
        dataDescriptor: true,
      },
    ]);
    const files = await readZipArchiveBuffered(zip, 2_500, 25 * 1024 * 1024);
    expect(files.map((file) => file.path)).toEqual([
      "extension/package.json",
      "extension/extension.js",
    ]);
    expect(files[0].textSample).toContain('"publisher"');
    expect(files[1].textSample).toBe("exports.activate = () => {};\n");
    expect(files[1].sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("matches the streaming reader on descriptor-free archives", async () => {
    const zip = buildZip([
      { path: "demo/__init__.py", body: "__version__ = '1.0.0'\n" },
      { path: "demo-1.0.0.dist-info/METADATA", body: "Name: demo\n", deflate: true },
    ]);
    const buffered = await readZipArchiveBuffered(zip, 2_500, 25 * 1024 * 1024);
    const streamed = await parse(zip);
    expect(buffered).toEqual(streamed);
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
