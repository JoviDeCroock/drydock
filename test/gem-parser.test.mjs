// @ts-nocheck
import { gzipSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import { readGemArchive, readPlainTarMembers } from "../server/lib/tar-parser.js";
import { buildTar, encoder } from "./helpers/archive-fixtures.mjs";

const MAX_FILES = 2_500;
const MAX_TAR_BYTES = 25 * 1024 * 1024;
const MAX_STREAM_BYTES = MAX_TAR_BYTES * 10;

const GEMSPEC = `--- !ruby/object:Gem::Specification
name: demo-gem
version: !ruby/object:Gem::Version
  version: 1.2.0
platform: ruby
`;

function buildGem({
  metadata = GEMSPEC,
  dataEntries = [{ name: "lib/demo.rb", body: "A = 1\n" }],
  extraMembers = [],
} = {}) {
  return buildTar([
    { name: "metadata.gz", body: gzipSync(encoder.encode(metadata)) },
    { name: "data.tar.gz", body: gzipSync(buildTar(dataEntries)) },
    { name: "checksums.yaml.gz", body: gzipSync(encoder.encode("---\n")) },
    ...extraMembers,
  ]);
}

async function parseGem(bytes, limits = {}) {
  return readGemArchive(
    bytes,
    limits.maxFiles ?? MAX_FILES,
    limits.maxTarBytes ?? MAX_TAR_BYTES,
    limits.maxStreamBytes ?? MAX_STREAM_BYTES,
  );
}

describe("readGemArchive", () => {
  test("surfaces the gemspec as metadata.gz plus the data.tar.gz files", async () => {
    const result = await parseGem(buildGem());
    expect(result.files.map((file) => file.path)).toEqual(["metadata.gz", "lib/demo.rb"]);
    const metadata = result.files[0];
    expect(metadata.textSample).toContain("!ruby/object:Gem::Specification");
    expect(metadata.textSample).toContain("name: demo-gem");
    expect(result.suspicious).toEqual([]);
  });

  test("fails closed when metadata.gz or data.tar.gz is missing", async () => {
    const noData = buildTar([{ name: "metadata.gz", body: gzipSync(encoder.encode(GEMSPEC)) }]);
    await expect(parseGem(noData)).rejects.toThrow(/missing metadata\.gz or data\.tar\.gz/);
    const noMetadata = buildTar([{ name: "data.tar.gz", body: gzipSync(buildTar([])) }]);
    await expect(parseGem(noMetadata)).rejects.toThrow(/missing metadata\.gz or data\.tar\.gz/);
  });

  test("rejects non-regular outer tar members", async () => {
    const gem = buildGem({ extraMembers: [{ name: "escape", body: "", type: "2" }] });
    await expect(parseGem(gem)).rejects.toThrow(/unsupported entry/);
  });

  test("applies the decompressed-size limit to the gzipped gemspec", async () => {
    const bomb = gzipSync(new Uint8Array(64 * 1024).fill(97));
    const gem = buildTar([
      { name: "metadata.gz", body: bomb },
      { name: "data.tar.gz", body: gzipSync(buildTar([])) },
    ]);
    await expect(parseGem(gem, { maxTarBytes: 16 * 1024 })).rejects.toThrow(
      /expands beyond safety limit/,
    );
  });

  test("applies the file-count limit to the nested data tar", async () => {
    const entries = Array.from({ length: 12 }, (_, i) => ({
      name: `lib/f${i}.rb`,
      body: "A = 1\n",
    }));
    await expect(parseGem(buildGem({ dataEntries: entries }), { maxFiles: 8 })).rejects.toThrow(
      /too many files/,
    );
  });

  test("applies the per-file body limit inside the nested data tar", async () => {
    const gem = buildGem({
      dataEntries: [{ name: "lib/huge.bin", body: new Uint8Array(96 * 1024).fill(1) }],
    });
    const result = await parseGem(gem, { maxTarBytes: 64 * 1024 });
    expect(result.suspicious).toContainEqual(
      expect.objectContaining({ kind: "content-skipped", path: "lib/huge.bin" }),
    );
  });

  test("flags a data.tar.gz entry that shadows the gem metadata member", async () => {
    const gem = buildGem({
      dataEntries: [
        { name: "metadata.gz", body: "shadow" },
        { name: "lib/demo.rb", body: "A = 1\n" },
      ],
    });
    const result = await parseGem(gem);
    expect(result.files.map((file) => file.path)).toEqual(["metadata.gz", "lib/demo.rb"]);
    expect(result.files[0].textSample).toContain("Gem::Specification");
    expect(result.suspicious).toContainEqual(
      expect.objectContaining({ kind: "duplicate", path: "metadata.gz" }),
    );
  });

  test("rejects an outer tar with too many members", async () => {
    const members = Array.from({ length: 20 }, (_, i) => ({ name: `m${i}`, body: "x" }));
    expect(() => readPlainTarMembers(buildTar(members), 16, MAX_TAR_BYTES)).toThrow(
      /too many files/,
    );
  });

  test("rejects traversal paths in the outer tar", async () => {
    expect(() =>
      readPlainTarMembers(buildTar([{ name: "../escape", body: "x" }]), 16, MAX_TAR_BYTES),
    ).toThrow(/unsupported entry/);
  });
});
