// @ts-nocheck
import { describe, expect, test } from "vitest";
import * as tarParser from "../server/lib/tar-parser.js";
import { buildTar, encoder } from "./helpers/archive-fixtures.mjs";

const {
  canonicalizePath,
  decodeText,
  gunzipBounded,
  hasUnicodeConfusables,
  isRootGypPath,
  isSafePaxPath,
  normalizeTarPath,
  parsePackageJson,
  parsePax,
  readTar,
} = tarParser;

const PARSE_LIMITS = {
  maxFiles: 2_500,
  maxTarBytes: 25 * 1024 * 1024,
};

async function parse(tar, limits = PARSE_LIMITS) {
  const result = await readTar(tar.buffer, limits.maxFiles, limits.maxTarBytes);
  return result.files;
}

async function parseFull(tar, limits = PARSE_LIMITS) {
  return readTar(tar.buffer, limits.maxFiles, limits.maxTarBytes);
}

describe("normalizeTarPath", () => {
  test("strips leading slashes and `package/` prefix", () => {
    expect(normalizeTarPath("package/index.js")).toBe("index.js");
    expect(normalizeTarPath("/package/lib/foo.js")).toBe("lib/foo.js");
    expect(normalizeTarPath("//etc/passwd")).toBe("etc/passwd");
  });

  test("rejects path traversal sequences", () => {
    expect(normalizeTarPath("package/../../../etc/passwd")).toBeNull();
    expect(normalizeTarPath("../escape")).toBeNull();
    expect(normalizeTarPath("a/../b")).toBeNull();
    expect(normalizeTarPath("./hidden")).toBeNull();
  });

  test("rejects null bytes and backslashes", () => {
    expect(normalizeTarPath("foo\0bar")).toBeNull();
    expect(normalizeTarPath("foo\\bar")).toBeNull();
  });

  test("rejects Windows drive letters", () => {
    expect(normalizeTarPath("C:foo")).toBeNull();
    expect(normalizeTarPath("Z:bar/baz")).toBeNull();
  });

  test("rejects a drive letter re-exposed by stripping the package/ prefix", () => {
    // `package//C:` → strip `package/` → `/C:` (leading slash dodges the early
    // drive-letter test) → collapse the empty segment → `C:`. The canonical
    // form must still be rejected. Regression for the fuzz-found escape (#311).
    expect(normalizeTarPath("package//C:")).toBeNull();
    expect(normalizeTarPath("package//Z:evil")).toBeNull();
    // A drive-letter-looking segment that is not the leading one is harmless.
    expect(normalizeTarPath("package/lib/C:notdrive")).toBe("lib/C:notdrive");
  });

  test("rejects paths longer than 512 chars", () => {
    expect(normalizeTarPath("a/".repeat(300) + "x")).toBeNull();
  });

  test("rejects empty or whitespace-only paths", () => {
    expect(normalizeTarPath("")).toBeNull();
    expect(normalizeTarPath("package/")).toBeNull();
    expect(normalizeTarPath("/")).toBeNull();
  });
});

describe("isSafePaxPath", () => {
  test("rejects null bytes, backslashes, and non-strings", () => {
    expect(isSafePaxPath("clean/path.js")).toBe(true);
    expect(isSafePaxPath("nope\\path")).toBe(false);
    expect(isSafePaxPath("nope\0path")).toBe(false);
    expect(isSafePaxPath(undefined)).toBe(false);
    expect(isSafePaxPath(123)).toBe(false);
  });
});

describe("parsePax", () => {
  test("parses length-prefixed key=value records", () => {
    const record = "15 path=foo/bar\n";
    const parsed = parsePax(encoder.encode(record));
    expect(parsed.path).toBe("foo/bar");
  });

  test("returns empty object when the body is malformed", () => {
    expect(parsePax(encoder.encode("nope"))).toEqual({});
    expect(parsePax(encoder.encode(""))).toEqual({});
  });
});

describe("decodeText", () => {
  test("returns text when content is mostly printable utf-8", () => {
    expect(decodeText(encoder.encode("hello world\n"))).toBe("hello world\n");
  });

  test("returns empty for binary-looking content (null bytes or control chars)", () => {
    expect(decodeText(new Uint8Array([0, 1, 2, 3]))).toBe("");
    expect(decodeText(new Uint8Array([1, 1, 1, 1, 1, 1, 1, 1]))).toBe("");
  });
});

describe("readTar regular files", () => {
  test("decodes a regular file with text body", async () => {
    const tar = buildTar([{ name: "package/index.js", body: "export const x = 1;\n" }]);
    const files = await parse(tar);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("index.js");
    expect(files[0].textSample).toBe("export const x = 1;\n");
    expect(files[0].flags).toEqual([]);
    expect(files[0].size).toBeGreaterThan(0);
    expect(files[0].sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("combines prefix + name when both are set", async () => {
    const tar = buildTar([{ name: "deep/file.js", prefix: "package/scope", body: "// deep\n" }]);
    const files = await parse(tar);
    expect(files.map((f) => f.path)).toEqual(["scope/deep/file.js"]);
  });

  test("flags binary content and omits textSample", async () => {
    const binary = new Uint8Array([0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3]);
    const tar = buildTar([{ name: "package/bin/native.node", body: binary }]);
    const files = await parse(tar);
    expect(files[0].flags).toEqual(["binary"]);
    expect(files[0].textSample).toBeUndefined();
  });

  test("captures the whole file body without truncation (issue #191)", async () => {
    // A payload buried past any fixed window must still reach the scanner. The
    // parser no longer clips the text sample; truncation is a display-only
    // concern applied at persistence, so detection sees the full file here.
    const filler = "// padding\n".repeat(40_000); // ~440 KB, well past the old 128 KB window
    const payload = "eval(process.env.SECRET);\n";
    const body = new TextEncoder().encode(filler + payload);
    const tar = buildTar([{ name: "package/large.js", body }]);
    const files = await parse(tar);
    expect(files[0].flags).not.toContain("truncated");
    expect(files[0].size).toBe(body.length);
    expect(files[0].textSample).toBe(filler + payload);
    expect(files[0].textSample).toContain("eval(process.env.SECRET)");
  });

  test("omits low-value generated text samples while preserving metadata", async () => {
    const tar = buildTar([
      { name: "package/dist/index.js", body: "export const value = 1;\n" },
      { name: "package/dist/index.js.map", body: JSON.stringify({ version: 3, mappings: "AAAA" }) },
      { name: "package/dist/index.d.ts", body: "export declare const value: number;\n" },
      { name: "package/dist/index.min.js", body: "(()=>{var a=1})();\n" },
    ]);
    const files = await parse(tar);
    const byPath = Object.fromEntries(files.map((file) => [file.path, file]));

    expect(byPath["dist/index.js"].textSample).toBe("export const value = 1;\n");
    for (const path of ["dist/index.js.map", "dist/index.min.js"]) {
      expect(byPath[path].textSample).toBeUndefined();
      expect(byPath[path].sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(byPath[path].size).toBeGreaterThan(0);
      expect(byPath[path].flags).toContain("text-sample-skipped");
    }
  });

  test("keeps text samples for TypeScript declaration files", async () => {
    // .d.ts files describe the public API surface and are first-class review
    // material, so they must retain a diffable text sample.
    const tar = buildTar([
      { name: "package/dist/index.d.ts", body: "export declare const value: number;\n" },
      { name: "package/dist/index.d.mts", body: "export declare const m: string;\n" },
      { name: "package/dist/index.d.cts", body: "export declare const c: boolean;\n" },
    ]);
    const files = await parse(tar);
    const byPath = Object.fromEntries(files.map((file) => [file.path, file]));

    for (const [path, body] of [
      ["dist/index.d.ts", "export declare const value: number;\n"],
      ["dist/index.d.mts", "export declare const m: string;\n"],
      ["dist/index.d.cts", "export declare const c: boolean;\n"],
    ]) {
      expect(byPath[path].textSample).toBe(body);
      expect(byPath[path].flags).not.toContain("text-sample-skipped");
    }
  });
});

describe("readTar path safety", () => {
  test("drops entries with traversal paths but keeps siblings", async () => {
    const tar = buildTar([
      { name: "package/../../../etc/passwd", body: "evil\n" },
      { name: "package/good.js", body: "ok\n" },
    ]);
    const files = await parse(tar);
    expect(files.map((f) => f.path)).toEqual(["good.js"]);
  });

  test("normalizes absolute paths to relative without traversal", async () => {
    const tar = buildTar([
      { name: "/etc/passwd", body: "evil\n" },
      { name: "package/ok.js", body: "ok\n" },
    ]);
    const files = await parse(tar);
    // Leading slashes are stripped so the entry can never resolve outside the
    // package tree downstream; the path itself is preserved for evidence.
    expect(files.map((f) => f.path)).toEqual(["etc/passwd", "ok.js"]);
    for (const f of files) {
      expect(f.path.startsWith("/")).toBe(false);
      expect(f.path.includes("..")).toBe(false);
    }
  });

  test("skips hardlink and symlink entries entirely and surfaces suspicious entries", async () => {
    const tar = buildTar([
      { name: "package/symlink", type: "2", body: "" },
      { name: "package/hardlink", type: "1", body: "" },
      { name: "package/real.js", body: "real\n" },
    ]);
    const { files, suspicious } = await parseFull(tar);
    expect(files.map((f) => f.path)).toEqual(["real.js"]);
    expect(suspicious.map((entry) => ({ kind: entry.kind, path: entry.path }))).toEqual([
      { kind: "non-regular", path: "symlink" },
      { kind: "non-regular", path: "hardlink" },
    ]);
    expect(suspicious[0].detail).toMatch(/typeflag 2/);
    expect(suspicious[1].detail).toMatch(/typeflag 1/);
  });
});

describe("readTar PAX and GNU long-name handling", () => {
  test("applies a safe PAX path override to the next regular entry", async () => {
    const paxRecord = "30 path=package/long/clean.js\n";
    const tar = buildTar([
      { name: "PaxHeader", type: "x", body: paxRecord },
      { name: "ignored", body: "x = 1\n" },
    ]);
    const files = await parse(tar);
    expect(files.map((f) => f.path)).toEqual(["long/clean.js"]);
  });

  test("rejects PAX paths containing null bytes or backslashes", async () => {
    const paxRecord = "21 path=evil\\path.js\n";
    const tar = buildTar([
      { name: "PaxHeader", type: "x", body: paxRecord },
      { name: "ignored", body: "x = 1\n" },
    ]);
    await expect(parse(tar)).rejects.toThrow(/invalid pax path/);
  });

  test("applies a safe GNU long-name override to the next regular entry", async () => {
    const longName = "package/" + "really-long-segment/".repeat(8) + "leaf.js";
    const tar = buildTar([
      { name: "././@LongLink", type: "L", body: longName + "\0" },
      { name: "ignored", body: "leaf\n" },
    ]);
    const files = await parse(tar);
    expect(files.map((f) => f.path)).toEqual([longName.replace(/^package\//, "")]);
  });

  test("rejects GNU long-name entries containing a backslash", async () => {
    const evilLongName = "package/leaf\\escape";
    const tar = buildTar([{ name: "././@LongLink", type: "L", body: evilLongName }]);
    await expect(parse(tar)).rejects.toThrow(/invalid long-name path/);
  });

  test("PAX path override is normalized and reaches isRootGypPath", async () => {
    // The header points to a nested gyp (lib/binding.gyp, non-root); a PAX
    // override raises it to root binding.gyp. If the PAX value bypassed
    // normalizeTarPath or isRootGypPath, the implicit-node-gyp rule could be
    // dodged. We verify the normalized PAX path is what isRootGypPath sees.
    const paxRecord = "28 path=package/binding.gyp\n";
    const tar = buildTar([
      { name: "PaxHeader", type: "x", body: paxRecord },
      { name: "package/lib/binding.gyp", body: "{}" },
    ]);
    const { files } = await parseFull(tar);
    expect(files.map((f) => f.path)).toEqual(["binding.gyp"]);
    expect(isRootGypPath(files[0].path)).toBe(true);
  });

  test("PAX path without package/ prefix still treated as root gyp", async () => {
    const paxRecord = "20 path=binding.gyp\n";
    const tar = buildTar([
      { name: "PaxHeader", type: "x", body: paxRecord },
      { name: "package/lib/decoy.js", body: "{}" },
    ]);
    const { files } = await parseFull(tar);
    expect(files.map((f) => f.path)).toEqual(["binding.gyp"]);
    expect(isRootGypPath(files[0].path)).toBe(true);
  });

  test("global PAX path metadata does not override the next entry path", async () => {
    const paxRecord = "26 path=package/decoy.txt\n";
    const tar = buildTar([
      { name: "GlobalPaxHeader", type: "g", body: paxRecord },
      { name: "package/binding.gyp", body: "{}" },
    ]);
    const { files } = await parseFull(tar);
    expect(files.map((f) => f.path)).toEqual(["binding.gyp"]);
    expect(isRootGypPath(files[0].path)).toBe(true);
  });

  test("global PAX metadata clears pending local path overrides", async () => {
    const localPaxRecord = "26 path=package/decoy.txt\n";
    const globalPaxRecord = "22 comment=global-pax\n";
    const tar = buildTar([
      { name: "PaxHeader", type: "x", body: localPaxRecord },
      { name: "GlobalPaxHeader", type: "g", body: globalPaxRecord },
      { name: "package/binding.gyp", body: "{}" },
    ]);
    const { files } = await parseFull(tar);
    expect(files.map((f) => f.path)).toEqual(["binding.gyp"]);
  });
});

describe("readTar suspicious entries", () => {
  for (const [type, label] of [
    ["1", "hardlink"],
    ["2", "symlink"],
    ["3", "character-device"],
    ["4", "block-device"],
    ["5", "directory"],
    ["6", "fifo"],
    ["7", "reserved"],
  ]) {
    test(`surfaces a non-regular entry for typeflag ${type} (${label})`, async () => {
      const tar = buildTar([
        { name: `package/weird-${label}`, type, body: "" },
        { name: "package/real.js", body: "real\n" },
      ]);
      const { files, suspicious } = await parseFull(tar);
      expect(files.map((f) => f.path)).toEqual(["real.js"]);
      expect(suspicious).toHaveLength(1);
      expect(suspicious[0]).toMatchObject({
        kind: "non-regular",
        path: `weird-${label}`,
      });
      expect(suspicious[0].detail).toContain(`typeflag ${type}`);
      expect(suspicious[0].detail).toContain(label);
    });
  }

  test("flags duplicate normalized paths and keeps the last body", async () => {
    const tar = buildTar([
      { name: "package/dupe.js", body: "first\n" },
      { name: "package/dupe.js", body: "second-evil\n" },
      { name: "package/ok.js", body: "ok\n" },
    ]);
    const { files, suspicious } = await parseFull(tar);
    expect(files.map((f) => f.path)).toEqual(["dupe.js", "ok.js"]);
    // Common tar extraction is last-write-wins, so scan the bytes consumers receive.
    expect(files[0].textSample).toBe("second-evil\n");
    expect(suspicious).toHaveLength(1);
    expect(suspicious[0]).toMatchObject({
      kind: "duplicate",
      path: "dupe.js",
    });
    expect(suspicious[0].detail).toContain("later entry replaced earlier entry");
  });

  test("flags zero-width-space confusable in a root gyp path", async () => {
    // U+200B between "binding" and ".gyp" — visually identical to binding.gyp,
    // but a naive isRootGypPath without canonicalization would not match.
    const sneaky = "package/binding​.gyp";
    const tar = buildTar([{ name: sneaky, body: "{}" }]);
    const { files, suspicious } = await parseFull(tar);
    expect(files.map((f) => f.path)).toEqual(["binding​.gyp"]);
    expect(suspicious).toHaveLength(1);
    expect(suspicious[0].kind).toBe("unicode-confusable");
    expect(suspicious[0].path).toBe("binding.gyp");
    expect(isRootGypPath(files[0].path)).toBe(true);
  });

  test("flags fraction-slash confusable in a path separator", async () => {
    // U+2044 fraction slash between "lib" and "binding.gyp" — npm may treat
    // this as a path separator on extract while the reviewer would see it as
    // a normal character if not canonicalized.
    const sneaky = "package/lib⁄binding.gyp";
    const tar = buildTar([{ name: sneaky, body: "{}" }]);
    const { files, suspicious } = await parseFull(tar);
    expect(files.map((f) => f.path)).toEqual(["lib⁄binding.gyp"]);
    expect(suspicious).toHaveLength(1);
    expect(suspicious[0].kind).toBe("unicode-confusable");
    expect(suspicious[0].path).toBe("lib/binding.gyp");
  });

  test("flags confusable paths that normalize to an unsafe location", async () => {
    // Fullwidth slashes canonicalize to ASCII separators, exposing traversal.
    const sneaky = "package／..／payload.js";
    const tar = buildTar([{ name: sneaky, body: "bad\n" }]);
    const { files, suspicious } = await parseFull(tar);
    expect(files.map((f) => f.path)).toEqual(["package／..／payload.js"]);
    expect(suspicious).toHaveLength(1);
    expect(suspicious[0]).toMatchObject({
      kind: "unicode-confusable",
      path: "package／..／payload.js",
    });
    expect(suspicious[0].detail).toContain("normalized to an unsafe path");
  });

  test("does not collapse a confusable path with its ASCII twin", async () => {
    const tar = buildTar([
      { name: "package/a​.js", body: "process.env.NPM_TOKEN\n" },
      { name: "package/a.js", body: "ok\n" },
    ]);
    const { files, suspicious } = await parseFull(tar);
    expect(files.map((f) => [f.path, f.textSample])).toEqual([
      ["a​.js", "process.env.NPM_TOKEN\n"],
      ["a.js", "ok\n"],
    ]);
    expect(suspicious).toEqual([
      expect.objectContaining({
        kind: "unicode-confusable",
        path: "a.js",
      }),
    ]);
  });

  test("caps suspicious entries and records a single limit marker", async () => {
    const tar = buildTar([
      { name: "package/one", type: "2", body: "" },
      { name: "package/two", type: "2", body: "" },
      { name: "package/three", type: "2", body: "" },
      { name: "package/four", type: "2", body: "" },
      { name: "package/real.js", body: "real\n" },
    ]);
    const { files, suspicious } = await parseFull(tar, {
      ...PARSE_LIMITS,
      maxFiles: 2,
    });
    expect(files.map((file) => file.path)).toEqual(["real.js"]);
    expect(suspicious.map((entry) => entry.path)).toEqual(["one", "two", "<archive>"]);
    expect(suspicious[2].detail).toContain("additional entries omitted");
  });

  test("clean ASCII paths produce no suspicious entries", async () => {
    const tar = buildTar([{ name: "package/binding.gyp", body: "{}" }]);
    const { files, suspicious } = await parseFull(tar);
    expect(files.map((f) => f.path)).toEqual(["binding.gyp"]);
    expect(suspicious).toEqual([]);
  });

  test("does not flag ordinary decomposed Unicode filenames", async () => {
    const decomposedName = "cafe\u0301.txt";
    const tar = buildTar([{ name: `package/${decomposedName}`, body: "ok\n" }]);
    const { files, suspicious } = await parseFull(tar);
    expect(files.map((f) => f.path)).toEqual([decomposedName]);
    expect(suspicious).toEqual([]);
  });
});

describe("canonicalizePath and isRootGypPath Unicode hardening", () => {
  test("canonicalizePath strips zero-width and bidi format characters", () => {
    expect(canonicalizePath("binding​.gyp")).toBe("binding.gyp");
    expect(canonicalizePath("binding﻿.gyp")).toBe("binding.gyp");
    expect(canonicalizePath("‮binding.gyp")).toBe("binding.gyp");
    expect(canonicalizePath("binding‍.gyp")).toBe("binding.gyp");
  });

  test("canonicalizePath folds confusable separators to ASCII", () => {
    expect(canonicalizePath("lib⁄binding.gyp")).toBe("lib/binding.gyp"); // fraction
    expect(canonicalizePath("lib∕binding.gyp")).toBe("lib/binding.gyp"); // division
    expect(canonicalizePath("lib／binding.gyp")).toBe("lib/binding.gyp"); // fullwidth solidus
    expect(canonicalizePath("binding．gyp")).toBe("binding.gyp"); // fullwidth dot
    expect(canonicalizePath("binding․gyp")).toBe("binding.gyp"); // one dot leader
  });

  test("hasUnicodeConfusables flags only non-ASCII path forms", () => {
    const decomposedName = "cafe\u0301.txt";
    expect(hasUnicodeConfusables("binding.gyp")).toBe(false);
    expect(hasUnicodeConfusables(decomposedName)).toBe(false);
    expect(canonicalizePath(decomposedName)).toBe(decomposedName);
    expect(hasUnicodeConfusables("binding​.gyp")).toBe(true);
    expect(hasUnicodeConfusables("lib⁄binding.gyp")).toBe(true);
  });

  test("isRootGypPath matches confusable forms after canonicalization", () => {
    expect(isRootGypPath("binding.gyp")).toBe(true);
    expect(isRootGypPath("binding​.gyp")).toBe(true);
    expect(isRootGypPath("binding．gyp")).toBe(true);
    expect(isRootGypPath("lib/binding.gyp")).toBe(false);
    // Confusable slash still indicates a separator — not a root gyp.
    expect(isRootGypPath("lib⁄binding.gyp")).toBe(false);
  });
});

describe("readTar limits and malformed archives", () => {
  test("throws on a truncated tar entry whose declared size overflows the buffer", async () => {
    const tar = buildTar([{ name: "package/x.js", body: "abc" }]);
    // Corrupt the size field to claim the entry is 4 KB even though only ~512B
    // of payload follows; the parser should detect the overflow.
    const sizeField = encoder.encode("00000010000\0");
    tar.set(sizeField, 124);
    await expect(parse(tar)).rejects.toThrow(/truncated tar entry/);
  });

  test("throws when the size field is not valid octal", async () => {
    const tar = buildTar([{ name: "package/x.js", body: "abc" }]);
    tar.set(encoder.encode("XYZZZZZZZZZ\0"), 124);
    await expect(parse(tar)).rejects.toThrow(/invalid tar entry size/);
  });

  test("fails closed when the file-count cap is exceeded", async () => {
    const tar = buildTar(
      Array.from({ length: 12 }, (_, i) => ({ name: `package/f${i}.js`, body: `// ${i}\n` })),
    );
    await expect(parse(tar, { ...PARSE_LIMITS, maxFiles: 5 })).rejects.toThrow(
      /archive contains too many files/,
    );
  });

  test("skips an oversized entry body but records its metadata", async () => {
    const limits = { maxFiles: 100, maxTarBytes: 1024 };
    const big = new Uint8Array(2048).fill(0x42);
    const tar = buildTar([
      { name: "package/index.js", body: "export const x = 1;\n" },
      { name: "package/bin/native.node", body: big },
      { name: "package/after.js", body: "// after\n" },
    ]);
    const { files, suspicious } = await parseFull(tar, limits);
    expect(files.map((f) => f.path)).toEqual(["index.js", "bin/native.node", "after.js"]);
    const skipped = files[1];
    expect(skipped.size).toBe(2048);
    expect(skipped.sha256).toBe("");
    expect(skipped.flags).toEqual(["content-skipped"]);
    expect(skipped.textSample).toBeUndefined();
    // Entries after the skipped body are still fully parsed.
    expect(files[2].textSample).toBe("// after\n");
    expect(files[2].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(suspicious).toEqual([
      {
        kind: "content-skipped",
        path: "bin/native.node",
        detail: expect.stringContaining("2048 bytes"),
      },
    ]);
  });

  test("skips entries once the cumulative retention budget is exhausted", async () => {
    const limits = { maxFiles: 100, maxTarBytes: 1000 };
    const bodyA = new Uint8Array(600).fill(0x61);
    const bodyB = new Uint8Array(600).fill(0x62);
    const tar = buildTar([
      { name: "package/a.bin", body: bodyA },
      { name: "package/b.bin", body: bodyB },
    ]);
    const { files, suspicious } = await parseFull(tar, limits);
    expect(files[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(files[1].sha256).toBe("");
    expect(files[1].flags).toEqual(["content-skipped"]);
    expect(suspicious.map((s) => s.kind)).toEqual(["content-skipped"]);
  });

  test("retains package.json even after earlier entries consume the retention budget", async () => {
    const limits = { maxFiles: 100, maxTarBytes: 950 };
    const filler = new Uint8Array(900).fill(0x61);
    const tar = buildTar([
      { name: "package/filler.bin", body: filler },
      {
        name: "package/package.json",
        body: JSON.stringify({
          name: "pkg",
          version: "1.0.0",
          scripts: { postinstall: "node install.js" },
        }),
      },
      { name: "package/install.js", body: 'require("child_process").exec("x")\n' },
    ]);
    const { files, suspicious } = await parseFull(tar, limits);
    const manifest = files.find((file) => file.path === "package.json");

    expect(manifest?.textSample).toContain('"postinstall"');
    expect(parsePackageJson(files)?.scripts?.postinstall).toBe("node install.js");
    expect(files.find((file) => file.path === "install.js")?.flags).toEqual(["content-skipped"]);
    expect(suspicious).toEqual([
      expect.objectContaining({
        kind: "content-skipped",
        path: "install.js",
      }),
    ]);
  });

  test("readTarStream parses chunked input identically to readTar", async () => {
    const tar = buildTar([
      { name: "package/index.js", body: "export const x = 1;\n" },
      { name: "package/lib/util.js", body: "// util\n" },
    ]);
    const chunked = new ReadableStream({
      start(controller) {
        for (let i = 0; i < tar.length; i += 100) {
          controller.enqueue(tar.subarray(i, Math.min(i + 100, tar.length)));
        }
        controller.close();
      },
    });
    const streamed = await tarParser.readTarStream(
      chunked,
      PARSE_LIMITS.maxFiles,
      PARSE_LIMITS.maxTarBytes,
      Infinity,
    );
    const buffered = await parseFull(tar);
    expect(streamed).toEqual(buffered);
  });

  test("readTarStream fails closed when the total stream exceeds its cap", async () => {
    const tar = buildTar([{ name: "package/big.bin", body: new Uint8Array(4096) }]);
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(tar);
        controller.close();
      },
    });
    await expect(tarParser.readTarStream(stream, 100, 512, 2048)).rejects.toThrow(
      /archive expands beyond safety limit/,
    );
  });

  test("throws truncated when a skipped entry body overruns the archive", async () => {
    const tar = buildTar([{ name: "package/x.bin", body: "abc" }]);
    // Claim a body far beyond both the retention limit and the archive length:
    // the skip path must still detect the overrun instead of succeeding.
    tar.set(encoder.encode("00000010000\0"), 124);
    await expect(parse(tar, { maxFiles: 100, maxTarBytes: 1024 })).rejects.toThrow(
      /truncated tar entry/,
    );
  });

  test("stops at the end-of-archive marker even with trailing garbage", async () => {
    const tar = buildTar([{ name: "package/a.js", body: "// a\n" }]);
    // Append garbage after the zero blocks; readTar should not see it.
    const extended = new Uint8Array(tar.length + 1024);
    extended.set(tar, 0);
    extended.fill(0x66, tar.length); // 'f'
    const files = await parse(extended);
    expect(files.map((f) => f.path)).toEqual(["a.js"]);
  });
});

describe("parsePackageJson", () => {
  test("normalizes scripts and dependency maps", () => {
    const files = [
      {
        path: "package.json",
        size: 0,
        sha256: "",
        flags: [],
        textSample: JSON.stringify({
          name: "@scope/pkg",
          version: "1.2.3",
          scripts: { preinstall: "node bad.js" },
          dependencies: { foo: "1.0.0" },
          files: ["dist", 42, "README.md"],
        }),
      },
    ];
    const parsed = parsePackageJson(files);
    expect(parsed?.name).toBe("@scope/pkg");
    expect(parsed?.version).toBe("1.2.3");
    expect(parsed?.scripts?.preinstall).toBe("node bad.js");
    expect(parsed?.dependencies?.foo).toBe("1.0.0");
    expect(parsed?.devDependencies).toEqual({});
    expect(parsed?.files).toEqual(["dist", "README.md"]);
  });

  test("models npm's implicit node-gyp install script for root gyp files", () => {
    const parsed = parsePackageJson([
      {
        path: "package.json",
        size: 0,
        sha256: "",
        flags: [],
        textSample: JSON.stringify({ name: "pkg", version: "1.0.0" }),
      },
      { path: "binding.gyp", size: 2, sha256: "gyp", flags: [], textSample: "{}" },
    ]);

    expect(parsed?.scripts?.install).toBe("node-gyp rebuild");
    expect(parsed?.implicitScripts).toEqual({ install: "node-gyp rebuild" });
    expect(parsed?.gypfile).toBe(true);
  });

  test("does not infer node-gyp install when npm would suppress it", () => {
    const withPreinstall = parsePackageJson([
      {
        path: "package.json",
        size: 0,
        sha256: "",
        flags: [],
        textSample: JSON.stringify({ scripts: { preinstall: "node setup.js" } }),
      },
      { path: "binding.gyp", size: 2, sha256: "gyp", flags: [], textSample: "{}" },
    ]);
    const withGypfileFalse = parsePackageJson([
      {
        path: "package.json",
        size: 0,
        sha256: "",
        flags: [],
        textSample: JSON.stringify({ gypfile: false }),
      },
      { path: "binding.gyp", size: 2, sha256: "gyp", flags: [], textSample: "{}" },
    ]);
    const nestedGyp = parsePackageJson([
      {
        path: "package.json",
        size: 0,
        sha256: "",
        flags: [],
        textSample: JSON.stringify({ name: "pkg", version: "1.0.0" }),
      },
      { path: "src/binding.gyp", size: 2, sha256: "gyp", flags: [], textSample: "{}" },
    ]);

    expect(withPreinstall?.implicitScripts).toBeUndefined();
    expect(withPreinstall?.scripts?.install).toBeUndefined();
    expect(withGypfileFalse?.implicitScripts).toBeUndefined();
    expect(withGypfileFalse?.scripts?.install).toBeUndefined();
    expect(nestedGyp?.implicitScripts).toBeUndefined();
    expect(nestedGyp?.scripts?.install).toBeUndefined();
  });

  test("returns null on malformed JSON or missing package.json", () => {
    expect(parsePackageJson([])).toBeNull();
    expect(
      parsePackageJson([
        { path: "package.json", size: 0, sha256: "", flags: [], textSample: "{not-json" },
      ]),
    ).toBeNull();
  });
});

describe("rendered sandbox parser source", () => {
  // The dynamic sandbox worker is built by concatenating
  // `Function.toString()` of these parser exports (see
  // `renderTarParserSource` in server/lib/sandbox.ts). If a bundler ever
  // strips or renames any of them, the sandbox module fails to load.
  const SANDBOX_EXPORT_NAMES = [
    "readString",
    "decodeText",
    "isPlainObject",
    "normalizeStringRecord",
    "canonicalizePath",
    "hasUnicodeConfusables",
    "isRootGypPath",
    "hasImplicitNodeGypInstall",
    "isSafePaxPath",
    "normalizeTarPath",
    "parsePax",
    "describeNonRegularType",
    "sha256Hex",
    "shouldSkipTextSample",
    "summarizeFile",
    "summarizeSkippedFile",
    "readTarStream",
    "parsePackageJson",
  ];

  test("every required parser export keeps its function name", () => {
    for (const name of SANDBOX_EXPORT_NAMES) {
      const fn = tarParser[name];
      expect(typeof fn, `${name} must be exported`).toBe("function");
      expect(fn.name, `${name} must keep its declared name`).toBe(name);
    }
  });

  test("concatenated source parses and runs without module-level dependencies", () => {
    const source = SANDBOX_EXPORT_NAMES.map((name) => tarParser[name].toString()).join("\n\n");
    for (const name of SANDBOX_EXPORT_NAMES) {
      expect(source).toContain(`function ${name}`);
    }
    expect(() => new Function(source)).not.toThrow();
    const run = new Function(
      source +
        `
return {
  safe: isSafePaxPath("clean/path.js"),
  unsafe: isSafePaxPath("nope" + String.fromCharCode(0) + "path"),
  normalized: normalizeTarPath("package/index.js")
};`,
    );
    expect(run()).toEqual({ safe: true, unsafe: false, normalized: "index.js" });
  });
});

describe("gunzipBounded", () => {
  function streamFrom(bytes) {
    return new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  }

  async function gzip(input) {
    const cs = new CompressionStream("gzip");
    const writer = cs.writable.getWriter();
    writer.write(input);
    writer.close();
    return new Uint8Array(await new Response(cs.readable).arrayBuffer());
  }

  test("decompresses a small gzip stream", async () => {
    const compressed = await gzip(encoder.encode("hello hello hello"));
    const buf = await gunzipBounded(streamFrom(compressed), 1024);
    expect(new TextDecoder().decode(buf)).toBe("hello hello hello");
  });

  test("throws when decompressed bytes exceed the cap", async () => {
    // 64 KB of repeated text compresses well — small input expands past the cap.
    const compressed = await gzip(encoder.encode("a".repeat(64 * 1024)));
    await expect(gunzipBounded(streamFrom(compressed), 1024)).rejects.toThrow(
      /archive expands beyond safety limit/,
    );
  });

  test("throws on a missing body", async () => {
    await expect(gunzipBounded(null, 1024)).rejects.toThrow(/tarball decompression failed/);
  });
});
