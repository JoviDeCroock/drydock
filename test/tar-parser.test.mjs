// @ts-nocheck
import { describe, expect, test } from "vitest";
import * as tarParser from "../server/lib/tar-parser.js";
import {
  TAR_BLOCK,
  buildTar,
  buildTarHeaderOnly,
  concatBytes,
  encoder,
  sealTarHeader,
  tarEntriesOnly,
} from "./helpers/archive-fixtures.mjs";

const {
  canonicalizePath,
  decodeText,
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
    expect(normalizeTarPath("//etc/passwd")).toBe("etc/passwd");
    // npm extracts with `strip: 1`, which drops the first path component —
    // here the empty one before the leading slash — so `package/` survives as
    // an ordinary directory rather than being taken for the root prefix.
    expect(normalizeTarPath("/package/lib/foo.js")).toBe("package/lib/foo.js");
    expect(normalizeTarPath("./package/lib/foo.js")).toBe("package/lib/foo.js");
  });

  test("rejects path traversal sequences", () => {
    expect(normalizeTarPath("package/../../../etc/passwd")).toBeNull();
    expect(normalizeTarPath("../escape")).toBeNull();
    expect(normalizeTarPath("a/../b")).toBeNull();
  });

  test("collapses `.` segments the way every extractor does", () => {
    // Rejecting these produced no record at all for `package/./binding.gyp`
    // while npm wrote `binding.gyp`.
    expect(normalizeTarPath("./hidden")).toBe("hidden");
    expect(normalizeTarPath("package/./binding.gyp")).toBe("binding.gyp");
    expect(normalizeTarPath("package/lib/./deep/./x.js")).toBe("lib/deep/x.js");
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

// Every expectation below was taken from npm's bundled node-tar 7.5.15:
// `tar.x({ strip: 1 })` into a scratch directory, then the file list on disk.
describe("normalizeTarPath strip modes", () => {
  test("`strip1` drops the first component whatever it is called", () => {
    expect(normalizeTarPath("dist/index.js", "strip1")).toBe("index.js");
    expect(normalizeTarPath("package/index.js", "strip1")).toBe("index.js");
    expect(normalizeTarPath("a/b/c.js", "strip1")).toBe("b/c.js");
    expect(normalizeTarPath("package/package/x.js", "strip1")).toBe("package/x.js");
  });

  test("`strip1` runs before the leading-slash, `.` and `..` checks, as node-tar's does", () => {
    expect(normalizeTarPath("/dist/x.js", "strip1")).toBe("dist/x.js");
    expect(normalizeTarPath("./dist/x.js", "strip1")).toBe("dist/x.js");
    expect(normalizeTarPath("//x.js", "strip1")).toBe("x.js");
    // node-tar checks for `..` after stripping, so the first one is consumed by
    // the strip and npm writes `evil.js`, while the second survives and npm
    // refuses the entry.
    expect(normalizeTarPath("../evil.js", "strip1")).toBe("evil.js");
    expect(normalizeTarPath("package/../evil.js", "strip1")).toBeNull();
    // Same for a drive letter: it is the stripped component, so nothing about
    // the extracted path is drive-relative.
    expect(normalizeTarPath("C:/x.js", "strip1")).toBe("x.js");
    expect(normalizeTarPath("C:x.js", "strip1")).toBeNull();
  });

  test("`strip1` leaves no path for an entry with no directory component", () => {
    // npm installs no file for these. Returning the entry's own name instead
    // would let a top-level decoy collide with, and last-write-wins over, the
    // stripped entry whose bytes npm does install; the reader discloses them
    // as evidence instead.
    expect(normalizeTarPath("index.js", "strip1")).toBeNull();
    expect(normalizeTarPath("dist/", "strip1")).toBeNull();
  });

  test("`keep` leaves a PyPI sdist root intact", () => {
    expect(normalizeTarPath("proj-1.0/PKG-INFO", "keep")).toBe("proj-1.0/PKG-INFO");
    // A sdist rooted at `package/` is not npm's root prefix to pip.
    expect(normalizeTarPath("package/setup.py", "keep")).toBe("package/setup.py");
    expect(normalizeTarPath("../escape", "keep")).toBeNull();
  });

  test("the default mode is the ecosystem-unknown `package-prefix` parse", () => {
    expect(normalizeTarPath("package/index.js")).toBe(
      normalizeTarPath("package/index.js", "package-prefix"),
    );
    expect(normalizeTarPath("dist/index.js")).toBe("dist/index.js");
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
    // The declared length counts the record's own bytes plus its newline.
    const parsed = parsePax(encoder.encode("16 path=foo/bar\n"));
    expect(parsed.path).toBe("foo/bar");
  });

  test("ignores a record whose declared length is wrong, and keeps the rest", () => {
    // node-tar drops the malformed line only; a parser that walks the declared
    // lengths instead would resolve a path npm never applies.
    const parsed = parsePax(encoder.encode("15 path=foo/bar\n16 size=1234567\n"));
    expect(parsed.path).toBeUndefined();
    expect(parsed.size).toBe("1234567");
  });

  test("reads records past a NUL byte and past 8 KiB of padding", () => {
    const padding = "20 comment=xxxxxxxx\n".repeat(500);
    const parsed = parsePax(encoder.encode(`\0\0\n${padding}16 path=foo/bar\n`));
    expect(parsed.path).toBe("foo/bar");
  });

  test("returns empty object when the body is malformed", () => {
    expect(parsePax(encoder.encode("nope"))).toEqual({});
    expect(parsePax(encoder.encode(""))).toEqual({});
  });

  test("keeps a record with no `=` as an empty value, like node-tar", () => {
    // node-tar splits on `=` and keeps whatever is left of it as the key, so a
    // bare `size` is a zero-length body to npm and a bare `path` an empty path.
    expect(parsePax(encoder.encode("7 size\n7 path\n"))).toEqual({ size: "", path: "" });
  });

  test("keeps a leading BOM, so the first record's length no longer parses, like node-tar", () => {
    expect(parsePax(encoder.encode("\uFEFF16 path=foo/bar\n9 size=5\n"))).toEqual({ size: "5" });
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

describe("readTar baseline text-sample cap", () => {
  // The cap is opt-in and applies only to baseline (already published) parses;
  // every staged/reviewed parse passes 0 and keeps the whole-body behavior the
  // test above pins (issue #191).
  const CAP = 1024;

  async function parseCapped(tar, cap = CAP) {
    const result = await readTar(tar.buffer, PARSE_LIMITS.maxFiles, PARSE_LIMITS.maxTarBytes, cap);
    return result.files;
  }

  test("is off by default: the same archive keeps its whole body", async () => {
    const body = "// pad\n".repeat(500); // 3500 chars
    const tar = buildTar([{ name: "package/big.js", body }]);

    const [uncapped] = await parse(tar);

    expect(uncapped.textSample).toBe(body);
    expect(uncapped.flags).not.toContain("baseline-truncated");
  });

  test("clips the retained sample, flags it, and keeps size + hash of the full body", async () => {
    const filler = "// pad\n".repeat(500); // 3500 chars, well past the cap
    const payload = "eval(process.env.SECRET);\n";
    const bodyText = filler + payload;
    const tar = buildTar([{ name: "package/big.js", body: bodyText }]);

    const [uncapped] = await parse(tar);
    const [capped] = await parseCapped(tar);

    expect(capped.flags).toContain("baseline-truncated");
    expect(capped.textSample.length).toBeLessThanOrEqual(CAP);
    expect(bodyText.startsWith(capped.textSample)).toBe(true);
    // Identity is unaffected: the digest still covers every byte, so the diff
    // layer can still prove whether the file changed.
    expect(capped.sha256).toBe(uncapped.sha256);
    expect(capped.size).toBe(uncapped.size);
  });

  test("clips on a line boundary so the last retained line is complete", async () => {
    const line = "a".repeat(99) + "\n"; // 100 chars per line
    const tar = buildTar([{ name: "package/lines.js", body: line.repeat(50) }]);

    const [capped] = await parseCapped(tar, 250);

    expect(capped.textSample).toBe(line.repeat(2));
  });

  test("falls back to a hard cut when one line is longer than the cap", async () => {
    const body = "b".repeat(4_000);
    const tar = buildTar([{ name: "package/one-line.js", body }]);

    const [capped] = await parseCapped(tar, 500);

    expect(capped.textSample).toBe("b".repeat(500));
    expect(capped.flags).toContain("baseline-truncated");
  });

  test("exempts manifests: structural manifest diffing needs the whole document", async () => {
    const manifest = JSON.stringify({
      name: "pkg",
      version: "1.0.0",
      description: "x".repeat(4_000),
    });
    const tar = buildTar([
      { name: "package/package.json", body: manifest },
      { name: "package/nested/dep/package.json", body: manifest },
      { name: "package/PKG-INFO", body: `Name: pkg\n${"# ".repeat(2_000)}\n` },
      { name: "package/other.js", body: "x".repeat(4_000) },
    ]);

    const files = await parseCapped(tar);
    const byPath = Object.fromEntries(files.map((file) => [file.path, file]));

    expect(byPath["package.json"].textSample).toBe(manifest);
    expect(byPath["package.json"].flags).not.toContain("baseline-truncated");
    expect(byPath["nested/dep/package.json"].textSample).toBe(manifest);
    expect(byPath["PKG-INFO"].flags).not.toContain("baseline-truncated");
    expect(byPath["other.js"].flags).toContain("baseline-truncated");
    // A capped manifest would null out package identity downstream.
    expect(parsePackageJson(files)).toMatchObject({ name: "pkg", version: "1.0.0" });
  });

  test("classifies binary bodies from the whole body, not the retained prefix", async () => {
    // The NUL that proves this file is binary sits past the cap. Classification
    // must still see it, otherwise a capped parse would emit a bogus text
    // sample for a binary file and change what the `binary` flag means.
    const head = new TextEncoder().encode("MZ" + "text".repeat(1_000));
    const body = new Uint8Array(head.length + 4);
    body.set(head, 0);
    body.set([0, 0, 0, 0], head.length);
    const tar = buildTar([{ name: "package/bin/tool", body }]);

    const [capped] = await parseCapped(tar);

    expect(capped.flags).toContain("binary");
    expect(capped.flags).not.toContain("baseline-truncated");
    expect(capped.textSample).toBeUndefined();
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

describe("readTar under npm's strip: 1", () => {
  const parseStripped = (tar) =>
    readTar(tar.buffer, PARSE_LIMITS.maxFiles, PARSE_LIMITS.maxTarBytes, 0, "strip1");

  test("anchors root-only rules on a tarball rooted at any other name", async () => {
    // The root manifest and `binding.gyp` are what npm installs at the package
    // root, so a tarball rooted at `dist/` must reach the root-anchored rules —
    // under the ecosystem-unknown parse it reported one level deeper and they
    // saw an empty root.
    const tar = buildTar([
      { name: "dist/package.json", body: '{"name":"x","version":"1.0.0"}' },
      { name: "dist/binding.gyp", body: "{}" },
      { name: "dist/lib/index.js", body: "ok\n" },
    ]);
    const { files } = await parseStripped(tar);
    expect(files.map((f) => f.path).sort()).toEqual([
      "binding.gyp",
      "lib/index.js",
      "package.json",
    ]);
    expect(parsePackageJson(files)?.name).toBe("x");
  });

  test("collapses two roots onto one installed path and reports the collision", async () => {
    // npm's strip writes both to `x.js`, last one wins. Recording them as
    // distinct files hid that a second entry overwrites the first.
    const tar = buildTar([
      { name: "a/x.js", body: "benign\n" },
      { name: "b/x.js", body: "evil\n" },
    ]);
    const { files, suspicious } = await parseStripped(tar);
    expect(files.map((f) => f.path)).toEqual(["x.js"]);
    expect(files[0].textSample).toBe("evil\n");
    expect(suspicious.map((entry) => ({ kind: entry.kind, path: entry.path }))).toEqual([
      { kind: "duplicate", path: "x.js" },
    ]);
  });

  test("records a traversal or drive-letter first component npm installs", async () => {
    const tar = buildTar([
      { name: "../evil.js", body: "evil\n" },
      { name: "C:/drive.js", body: "drive\n" },
      { name: "package/../escape.js", body: "escape\n" },
    ]);
    const { files, suspicious } = await parseStripped(tar);
    // The first two strip down to ordinary root files npm writes; the third
    // still carries `..` after the strip and npm refuses it, so it stays a
    // disclosure rather than a recorded file.
    expect(files.map((f) => f.path).sort()).toEqual(["drive.js", "evil.js"]);
    expect(suspicious.map((entry) => ({ kind: entry.kind, path: entry.path }))).toEqual([
      { kind: "parser-differential", path: "package/../escape.js" },
    ]);
  });

  test("a top-level decoy cannot mask the entry npm installs at that path", async () => {
    // npm's strip drops the top-level `index.js` outright and writes the bytes
    // of the one under `a/` to `index.js`. Recording the decoy as a file made it
    // win the collision and show the reviewer content npm never installs.
    const tar = buildTar([
      { name: "a/index.js", body: "payload\n" },
      { name: "index.js", body: "decoy\n" },
    ]);
    const { files, suspicious } = await parseStripped(tar);
    expect(files.map((f) => f.path)).toEqual(["index.js"]);
    expect(files[0].textSample).toBe("payload\n");
    expect(suspicious).toEqual([
      {
        kind: "parser-differential",
        path: "index.js",
        detail: expect.stringContaining("installs no file for it"),
      },
    ]);
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

  test("keeps a pending local path override across a global PAX header", async () => {
    // node-tar merges a global header into its own record without clearing the
    // pending local one, so npm writes `decoy.txt` here. Clearing it meant a
    // `g` block could hide a path override from review.
    const tar = buildTar([
      { name: "PaxHeader", type: "x", body: "26 path=package/decoy.txt\n" },
      { name: "GlobalPaxHeader", type: "g", body: "22 comment=global-pax\n" },
      { name: "package/binding.gyp", body: "{}" },
    ]);
    const { files } = await parseFull(tar);
    expect(files.map((f) => f.path)).toEqual(["decoy.txt"]);
  });

  test("does not apply a global PAX path to later entries", async () => {
    const tar = buildTar([
      { name: "GlobalPaxHeader", type: "g", body: "26 path=package/decoy.txt\n" },
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
    const { files, suspicious } = await tarParser.readTarStream(
      new Response(tar).body,
      2,
      PARSE_LIMITS.maxTarBytes,
      Infinity,
      10,
    );
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
    expect(canonicalizePath("binding\uFEFF.gyp")).toBe("binding.gyp");
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
    sealTarHeader(tar, 0);
    await expect(parse(tar)).rejects.toThrow(/truncated tar entry/);
  });

  test("throws when the size field is not valid octal", async () => {
    const tar = buildTar([{ name: "package/x.js", body: "abc" }]);
    tar.set(encoder.encode("XYZZZZZZZZZ\0"), 124);
    sealTarHeader(tar, 0);
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

  test("skips an oversized entry body but records its metadata and hash", async () => {
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
    // The body is discarded but hashed on the way past, so the diff layer can
    // still prove whether the uninspected binary changed against the baseline.
    expect(skipped.sha256).toBe(await tarParser.sha256Hex(big));
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

  test("fails closed on an oversized non-regular entry instead of streaming its body", async () => {
    // npm publish never emits non-regular entries, so a hand-crafted archive
    // is the only source; unlike a regular file there is no retention/skip
    // path for it, and it must be rejected before its body is streamed at all.
    const limits = { maxFiles: 100, maxTarBytes: 1024 };
    const big = new Uint8Array(2048).fill(0x42);
    const tar = buildTar([{ name: "package/link", type: "2", body: big }]);
    await expect(parse(tar, limits)).rejects.toThrow(/invalid tar entry size/);
  });

  test("duplicate paths still count toward the file-count cap", async () => {
    // Duplicates replace their earlier entry, so distinct-path counting alone
    // would let thousands of records for one path bypass the cap while every
    // body is still streamed and hashed.
    const tar = buildTar(
      Array.from({ length: 6 }, () => ({ name: "package/dup.js", body: "x\n" })),
    );
    await expect(parse(tar, { maxFiles: 5, maxTarBytes: 1 << 20 })).rejects.toThrow(
      /archive contains too many files/,
    );
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
    expect(files[1].sha256).toBe(await tarParser.sha256Hex(bodyB));
    expect(files[1].flags).toEqual(["content-skipped"]);
    // Bulk budget demotions aggregate into one archive-level notice instead of
    // one suspicious entry (and finding) per demoted file.
    expect(suspicious).toEqual([
      expect.objectContaining({
        kind: "retention-tier",
        path: "<archive>",
        detail: expect.stringContaining("cumulative retention budget"),
      }),
    ]);
    expect(suspicious[0].detail).toContain("1 additional file bodies");
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
        kind: "retention-tier",
        path: "<archive>",
        detail: expect.stringContaining("cumulative retention budget"),
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

  test("readTarStream parses byte-at-a-time input identically to readTar", async () => {
    const tar = buildTar([
      { name: "package/index.js", body: "export const x = 1;\n" },
      { name: "package/lib/util.js", body: "// util\n" },
      { name: "package/readme.txt", body: "chunk cursor regression\n" },
    ]);
    const chunked = new ReadableStream({
      start(controller) {
        for (let i = 0; i < tar.length; i += 1) {
          controller.enqueue(tar.subarray(i, i + 1));
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
    sealTarHeader(tar, 0);
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

  test("reads a typeflag 7 entry as the regular file npm extracts", async () => {
    const tar = buildTar([
      { name: "package/index.js", body: "// a\n" },
      { name: "package/binding.gyp", type: "7", body: "{}" },
    ]);
    const { files, suspicious } = await parseFull(tar);
    expect(files.map((f) => f.path)).toEqual(["index.js", "binding.gyp"]);
    expect(suspicious).toEqual([]);
  });

  test("reads a `0` entry whose name ends in `/` as the directory npm skips", async () => {
    const tar = buildTar([
      { name: "package/index.js", body: "// a\n" },
      { name: "package/weird/", body: "" },
    ]);
    const { files, suspicious } = await parseFull(tar);
    expect(files.map((f) => f.path)).toEqual(["index.js"]);
    expect(suspicious).toContainEqual(
      expect.objectContaining({ kind: "non-regular", detail: "typeflag 5 (directory)" }),
    );
  });

  test("applies a GNU `N` long path like `L`", async () => {
    const tar = buildTar([
      { name: "@LongLink", type: "N", body: "package/binding.gyp\0" },
      { name: "package/harmless.txt", body: "{}" },
    ]);
    const { files } = await parseFull(tar);
    expect(files.map((f) => f.path)).toEqual(["binding.gyp"]);
  });

  test("keeps a pending long path across a `K` long-linkpath header", async () => {
    const tar = buildTar([
      { name: "@LongLink", type: "L", body: "package/binding.gyp\0" },
      { name: "@LongLink", type: "K", body: "target\0" },
      { name: "package/harmless.txt", body: "{}" },
    ]);
    const { files, suspicious } = await parseFull(tar);
    expect(files.map((f) => f.path)).toEqual(["binding.gyp"]);
    expect(suspicious).toEqual([]);
  });

  test("applies an `X` old extended header like `x`", async () => {
    const tar = buildTar([
      { name: "PaxHeader", type: "X", body: "28 path=package/binding.gyp\n" },
      { name: "package/harmless.txt", body: "{}" },
    ]);
    const { files } = await parseFull(tar);
    expect(files.map((f) => f.path)).toEqual(["binding.gyp"]);
  });

  test("ignores an extended header larger than node-tar's 1 MiB metadata limit", async () => {
    // Over that limit node-tar skips the body and leaves its pending record
    // untouched, so the entry keeps its own name.
    const body = new Uint8Array(1024 * 1024 + 512);
    body.set(encoder.encode("28 path=package/binding.gyp\n"));
    const tar = buildTar([
      { name: "PaxHeader", type: "x", body },
      { name: "package/harmless.txt", body: "{}" },
    ]);
    const { files } = await parseFull(tar);
    expect(files.map((f) => f.path)).toEqual(["harmless.txt"]);
  });

  test("takes a PAX size over the header's own so later entries stay aligned", async () => {
    // The header claims 1024 bytes and the PAX record claims 5: npm reads 5 and
    // finds a header in the second block, so a reader that trusts the header
    // walks a different archive from here on.
    const hidden = buildTar([{ name: "package/binding.gyp", body: "{}" }]);
    const tar = concatBytes([
      tarEntriesOnly(buildTar([{ name: "package/index.js", body: "// a\n" }])),
      tarEntriesOnly(buildTar([{ name: "PaxHeader", type: "x", body: "9 size=5\n" }])),
      buildTarHeaderOnly({ name: "package/decoy.txt", size: 1024 }),
      new Uint8Array(TAR_BLOCK),
      hidden,
    ]);
    const { files } = await parseFull(tar);
    expect(files.map((f) => f.path)).toEqual(["index.js", "decoy.txt", "binding.gyp"]);
  });

  test("takes a global PAX size the same way", async () => {
    const tar = concatBytes([
      tarEntriesOnly(buildTar([{ name: "GlobalPaxHeader", type: "g", body: "9 size=5\n" }])),
      buildTarHeaderOnly({ name: "package/decoy.txt", size: 1024 }),
      new Uint8Array(TAR_BLOCK),
      buildTar([{ name: "package/binding.gyp", body: "{}" }]),
    ]);
    const { files } = await parseFull(tar);
    expect(files.map((f) => f.path)).toEqual(["decoy.txt", "binding.gyp"]);
  });

  test("skips a bad-checksum block without consuming its body, like npm's reader", async () => {
    // node-tar skips the block and reads the next 512 bytes as a header, so the
    // "body" declared here is really the entry that follows.
    const tar = concatBytes([
      tarEntriesOnly(buildTar([{ name: "package/index.js", body: "// a\n" }])),
      buildTarHeaderOnly({ name: "package/decoy.txt", size: 1024, seal: false }),
      buildTar([{ name: "package/binding.gyp", body: "{}" }]),
    ]);
    const { files, suspicious } = await parseFull(tar);
    expect(files.map((f) => f.path)).toEqual(["index.js", "binding.gyp"]);
    expect(suspicious).toContainEqual(
      expect.objectContaining({
        kind: "parser-differential",
        path: "<archive>",
        detail: expect.stringContaining("1 header block is one npm's reader rejects"),
      }),
    );
  });

  test.each([
    ["mode", 100],
    ["uid", 108],
    ["gid", 116],
    ["mtime", 136],
    ["devmaj", 329],
    ["devmin", 337],
    ["atime", 476],
    ["ctime", 488],
  ])(
    "skips a header whose %s field has a base-256 prefix npm's reader cannot decode, without consuming its body",
    async (_field, offset) => {
      // node-tar's header decode throws on a base-256 prefix other than
      // 0x80/0xff, and a header whose decode throws is skipped like a checksum
      // failure — so the declared body is really the entry that follows.
      const decoy = buildTarHeaderOnly({ name: "package/decoy.txt", size: 1024 });
      decoy[offset] = 0x81;
      sealTarHeader(decoy);
      const tar = concatBytes([
        tarEntriesOnly(buildTar([{ name: "package/index.js", body: "// a\n" }])),
        decoy,
        buildTar([{ name: "package/binding.gyp", body: "{}" }]),
      ]);
      const { files, suspicious } = await parseFull(tar);
      expect(files.map((f) => f.path)).toEqual(["index.js", "binding.gyp"]);
      expect(suspicious).toContainEqual(
        expect.objectContaining({
          kind: "parser-differential",
          path: "<archive>",
          detail: expect.stringContaining("1 header block is one npm's reader rejects"),
        }),
      );
    },
  );

  test("skips a header whose base-256 mtime is outside the safe-integer range", async () => {
    const decoy = buildTarHeaderOnly({ name: "package/decoy.txt", size: 1024 });
    decoy[136] = 0x80;
    decoy[137] = 0xff;
    sealTarHeader(decoy);
    const tar = concatBytes([
      tarEntriesOnly(buildTar([{ name: "package/index.js", body: "// a\n" }])),
      decoy,
      buildTar([{ name: "package/binding.gyp", body: "{}" }]),
    ]);
    expect((await parse(tar)).map((f) => f.path)).toEqual(["index.js", "binding.gyp"]);
  });

  test.each([
    ["a positive", 0x80, 0],
    ["a two's-complement", 0xff, 0xff],
  ])(
    "reads a header whose uid is %s base-256 value npm's reader decodes",
    async (_l, prefix, fill) => {
      const decoy = buildTarHeaderOnly({ name: "package/decoy.txt", size: 1024 });
      decoy.fill(fill, 108, 116);
      decoy[108] = prefix;
      sealTarHeader(decoy);
      const tar = concatBytes([
        tarEntriesOnly(buildTar([{ name: "package/index.js", body: "// a\n" }])),
        decoy,
        buildTar([{ name: "package/binding.gyp", body: "{}" }]),
      ]);
      const { files, suspicious } = await parseFull(tar);
      expect(files.map((f) => f.path)).toEqual(["index.js", "decoy.txt"]);
      expect(suspicious).toEqual([]);
    },
  );

  test.each(["x", "g"])(
    "does not decode a numeric field a PAX `%s` record overrides, like npm's reader",
    async (type) => {
      const decoy = buildTarHeaderOnly({ name: "package/decoy.txt", size: 1024 });
      decoy[108] = 0x81;
      sealTarHeader(decoy);
      const tar = concatBytes([
        tarEntriesOnly(buildTar([{ name: "package/index.js", body: "// a\n" }])),
        tarEntriesOnly(buildTar([{ name: "PaxHeader", type, body: "12 uid=1000\n" }])),
        decoy,
        buildTar([{ name: "package/binding.gyp", body: "{}" }]),
      ]);
      expect((await parse(tar)).map((f) => f.path)).toEqual(["index.js", "decoy.txt"]);
    },
  );

  test.each([
    ["mode", 100, "9 mode=1\n"],
    ["devmaj", 329, "12 devmaj=1\n"],
    ["devmin", 337, "12 devmin=1\n"],
  ])(
    "still decodes %s under a PAX record naming it, because node-tar's PAX record never carries it",
    async (_field, offset, record) => {
      const decoy = buildTarHeaderOnly({ name: "package/decoy.txt", size: 1024 });
      decoy[offset] = 0x81;
      sealTarHeader(decoy);
      const tar = concatBytes([
        tarEntriesOnly(buildTar([{ name: "package/index.js", body: "// a\n" }])),
        tarEntriesOnly(buildTar([{ name: "PaxHeader", type: "x", body: record }])),
        decoy,
        buildTar([{ name: "package/binding.gyp", body: "{}" }]),
      ]);
      expect((await parse(tar)).map((f) => f.path)).toEqual(["index.js", "binding.gyp"]);
    },
  );

  test("reads a name past a NUL followed by a newline, as node-tar's decString does", async () => {
    // node-tar cuts a field with `/\0.*/` and no `s` flag, so text after a
    // newline survives the cut; stopping at the NUL instead sees an empty name
    // and rejects a header npm accepts, reading its body as headers.
    // The name fills its field exactly so no NUL padding follows (node-tar keeps
    // that padding in the path too, which makes it unrepresentable here).
    const tail = "k".repeat(90);
    const decoy = buildTarHeaderOnly({ name: "package/decoy.txt", size: 1024 });
    decoy.set(encoder.encode(`package/\0\n${tail}`), 0);
    sealTarHeader(decoy);
    const tar = concatBytes([
      tarEntriesOnly(buildTar([{ name: "package/index.js", body: "// a\n" }])),
      decoy,
      buildTar([{ name: "package/binding.gyp", body: "{}" }]),
    ]);
    expect((await parse(tar)).map((f) => f.path)).toEqual(["index.js", `\n${tail}`]);
  });

  test("rejects a regular file whose linkname survives node-tar's NUL cut, without consuming its body", async () => {
    const decoy = buildTarHeaderOnly({ name: "package/decoy.txt", size: 1024 });
    decoy.set(encoder.encode("\0\nx"), 157);
    sealTarHeader(decoy);
    const tar = concatBytes([
      tarEntriesOnly(buildTar([{ name: "package/index.js", body: "// a\n" }])),
      decoy,
      buildTar([{ name: "package/binding.gyp", body: "{}" }]),
    ]);
    expect((await parse(tar)).map((f) => f.path)).toEqual(["index.js", "binding.gyp"]);
  });

  test("rejects a header for a numeric PAX path only for typeflag 0, so a later `x` can still replace it", async () => {
    // node-tar's throw is `.slice` on the Number path inside its typeflag-0
    // branch; an `x` header carrying a pending numeric path is read normally.
    const tar = concatBytes([
      tarEntriesOnly(buildTar([{ name: "package/index.js", body: "// a\n" }])),
      tarEntriesOnly(buildTar([{ name: "PaxHeader", type: "x", body: "12 path=123\n" }])),
      tarEntriesOnly(
        buildTar([{ name: "PaxHeader", type: "x", body: "24 path=package/evil.js\n" }]),
      ),
      buildTar([{ name: "package/decoy.txt", body: "{}" }]),
    ]);
    expect((await parse(tar)).map((f) => f.path)).toEqual(["index.js", "evil.js"]);
  });

  test("rejects every header after a PAX `path=0`, which is a falsy path to node-tar", async () => {
    const tar = concatBytes([
      tarEntriesOnly(buildTar([{ name: "package/index.js", body: "// a\n" }])),
      tarEntriesOnly(buildTar([{ name: "PaxHeader", type: "x", body: "10 path=0\n" }])),
      buildTar([{ name: "package/binding.gyp", body: "{}" }]),
    ]);
    const { files, suspicious } = await parseFull(tar);
    expect(files.map((f) => f.path)).toEqual(["index.js"]);
    expect(suspicious).toContainEqual(
      expect.objectContaining({
        kind: "parser-differential",
        detail: expect.stringContaining("npm's reader rejects"),
      }),
    );
  });

  test("prepends the ustar prefix, even an empty one, when byte 475 is set, like node-tar", async () => {
    // node-tar's path is then `/` for an empty name — truthy, so the header is
    // accepted and its body consumed rather than read as headers.
    const decoy = buildTarHeaderOnly({ name: "", size: 1024 });
    decoy[475] = 0x41;
    sealTarHeader(decoy);
    const tar = concatBytes([
      tarEntriesOnly(buildTar([{ name: "package/index.js", body: "// a\n" }])),
      decoy,
      buildTar([{ name: "package/binding.gyp", body: "{}" }]),
    ]);
    const { files, suspicious } = await parseFull(tar);
    expect(files.map((f) => f.path)).toEqual(["index.js"]);
    expect(suspicious).toContainEqual(
      expect.objectContaining({ kind: "parser-differential", path: "/" }),
    );
  });

  test("reports `/package/x` one level down when byte 475 is set, where npm's `strip: 1` writes it", async () => {
    const entry = buildTarHeaderOnly({ name: "package/x.txt" });
    entry[475] = 0x41;
    sealTarHeader(entry);
    const tar = concatBytes([
      tarEntriesOnly(buildTar([{ name: "package/index.js", body: "// a\n" }])),
      entry,
      buildTar([{ name: "package/binding.gyp", body: "{}" }]),
    ]);
    expect((await parse(tar)).map((f) => f.path)).toEqual([
      "index.js",
      "package/x.txt",
      "binding.gyp",
    ]);
  });

  test("decodes the device and time fields only under the ustar magic", async () => {
    const decoy = buildTarHeaderOnly({ name: "package/decoy.txt", size: 1024 });
    decoy[329] = 0x81;
    decoy.fill(0, 257, 265);
    sealTarHeader(decoy);
    const tar = concatBytes([
      tarEntriesOnly(buildTar([{ name: "package/index.js", body: "// a\n" }])),
      decoy,
      buildTar([{ name: "package/binding.gyp", body: "{}" }]),
    ]);
    expect((await parse(tar)).map((f) => f.path)).toEqual(["index.js", "decoy.txt"]);
  });

  test("reads a PAX `size` record with no `=` as the zero-length body npm reads", async () => {
    // node-tar keeps the record as `size=''`, and an empty remaining size reads
    // as nothing left, so the 1024 bytes the header declares are the next entry.
    const tar = concatBytes([
      tarEntriesOnly(buildTar([{ name: "package/index.js", body: "// a\n" }])),
      tarEntriesOnly(buildTar([{ name: "PaxHeader", type: "x", body: "7 size\n" }])),
      buildTarHeaderOnly({ name: "package/decoy.txt", size: 1024 }),
      buildTar([{ name: "package/binding.gyp", body: "{}" }]),
    ]);
    expect((await parse(tar)).map((f) => f.path)).toEqual(["index.js", "decoy.txt", "binding.gyp"]);
  });

  test("rejects every header after a PAX `path` record with no `=`, like npm's reader", async () => {
    const tar = concatBytes([
      tarEntriesOnly(buildTar([{ name: "package/index.js", body: "// a\n" }])),
      tarEntriesOnly(buildTar([{ name: "PaxHeader", type: "x", body: "7 path\n" }])),
      buildTar([{ name: "package/binding.gyp", body: "{}" }]),
    ]);
    const { files, suspicious } = await parseFull(tar);
    expect(files.map((f) => f.path)).toEqual(["index.js"]);
    expect(suspicious).toContainEqual(
      expect.objectContaining({
        kind: "parser-differential",
        detail: expect.stringContaining("npm's reader rejects"),
      }),
    );
  });

  test("ends the archive on two blocks npm's reader treats as null, not only all-zero ones", async () => {
    // node-tar's null block is zero everywhere outside the checksum field with a
    // checksum that does not parse; ending only on all-zero blocks would report
    // the entries after these as files npm never writes.
    const blank = new Uint8Array(TAR_BLOCK);
    blank.set(encoder.encode("        "), 148);
    const tar = concatBytes([
      tarEntriesOnly(buildTar([{ name: "package/index.js", body: "// a\n" }])),
      blank,
      blank,
      buildTar([{ name: "package/binding.gyp", body: "{}" }]),
    ]);
    const { files, suspicious } = await parseFull(tar);
    expect(files.map((f) => f.path)).toEqual(["index.js"]);
    expect(suspicious).toEqual([]);
  });

  test("counts a lone such block as the lone null block it is to npm's reader", async () => {
    const blank = new Uint8Array(TAR_BLOCK);
    blank.set(encoder.encode("        "), 148);
    const tar = concatBytes([
      tarEntriesOnly(buildTar([{ name: "package/index.js", body: "// a\n" }])),
      blank,
      buildTar([{ name: "package/binding.gyp", body: "{}" }]),
    ]);
    const { files, suspicious } = await parseFull(tar);
    expect(files.map((f) => f.path)).toEqual(["index.js", "binding.gyp"]);
    expect(suspicious).toContainEqual(
      expect.objectContaining({
        kind: "parser-differential",
        path: "<archive>",
        detail: expect.stringContaining("1 entry follows"),
      }),
    );
  });

  test("consumes the body of an entry whose PAX path is empty under a ustar prefix, like npm's reader", async () => {
    // node-tar accepts the header (its own path is `prefix/`), reads the body,
    // and only drops the entry in unpack; rejecting it here would read that body
    // as headers and report entries npm never sees.
    const tar = concatBytes([
      tarEntriesOnly(buildTar([{ name: "package/index.js", body: "// a\n" }])),
      tarEntriesOnly(buildTar([{ name: "PaxHeader", type: "x", body: "8 path=\n" }])),
      buildTarHeaderOnly({ name: "", prefix: "package", size: 1024 }),
      buildTar([{ name: "package/binding.gyp", body: "{}" }]),
    ]);
    const { files, suspicious } = await parseFull(tar);
    expect(files.map((f) => f.path)).toEqual(["index.js"]);
    expect(suspicious).toContainEqual(
      expect.objectContaining({ kind: "parser-differential", path: "<unnamed>" }),
    );
  });

  test("reads a GNU long name made of digits as the string node-tar keeps, not a numeric PAX path", async () => {
    // Only a PAX record's all-digit value is coerced to a Number by node-tar;
    // an `L` body of the same digits stays a string and the file is extracted.
    const tar = concatBytes([
      tarEntriesOnly(buildTar([{ name: "package/index.js", body: "// a\n" }])),
      tarEntriesOnly(buildTar([{ name: "././@LongLink", type: "L", body: "123" }])),
      buildTarHeaderOnly({ name: "package/decoy.txt", size: 1024 }),
      buildTar([{ name: "package/binding.gyp", body: "{}" }]),
    ]);
    expect((await parse(tar)).map((f) => f.path)).toEqual(["index.js", "123"]);
  });

  test("ignores a zero-length long-name header, as node-tar does", async () => {
    const tar = concatBytes([
      tarEntriesOnly(buildTar([{ name: "package/index.js", body: "// a\n" }])),
      buildTarHeaderOnly({ name: "././@LongLink", type: "L", size: 0 }),
      buildTar([{ name: "package/binding.gyp", body: "{}" }]),
    ]);
    expect((await parse(tar)).map((f) => f.path)).toEqual(["index.js", "binding.gyp"]);
  });

  test("keeps a leading BOM in a name, as node-tar's Buffer decode does", async () => {
    // TextDecoder drops U+FEFF by default; node-tar keeps it, so a BOM-only
    // name is a truthy path whose body is consumed rather than read as headers.
    const decoy = buildTarHeaderOnly({ name: "package/decoy.txt", size: 1024 });
    decoy.fill(0, 0, 100);
    decoy.set(encoder.encode("\uFEFF"), 0);
    sealTarHeader(decoy);
    const tar = concatBytes([
      tarEntriesOnly(buildTar([{ name: "package/index.js", body: "// a\n" }])),
      decoy,
      buildTar([{ name: "package/binding.gyp", body: "{}" }]),
    ]);
    const { files, suspicious } = await parseFull(tar);
    expect(files.map((f) => f.path)).not.toContain("binding.gyp");
    expect(suspicious).not.toContainEqual(expect.objectContaining({ path: "<archive>" }));
  });

  test("rejects a regular file whose linkname is only a BOM, as node-tar does", async () => {
    const decoy = buildTarHeaderOnly({ name: "package/decoy.txt", size: 1024 });
    decoy.set(encoder.encode("\uFEFF"), 157);
    sealTarHeader(decoy);
    const tar = concatBytes([
      tarEntriesOnly(buildTar([{ name: "package/index.js", body: "// a\n" }])),
      decoy,
      buildTar([{ name: "package/binding.gyp", body: "{}" }]),
    ]);
    expect((await parse(tar)).map((f) => f.path)).toEqual(["index.js", "binding.gyp"]);
  });

  test("drops a PAX record behind a BOM, as node-tar's parseInt does", async () => {
    const tar = concatBytes([
      tarEntriesOnly(buildTar([{ name: "package/index.js", body: "// a\n" }])),
      tarEntriesOnly(buildTar([{ name: "PaxHeader", type: "x", body: "\uFEFF13 size=1024\n" }])),
      buildTarHeaderOnly({ name: "package/decoy.txt", size: 0 }),
      buildTar([{ name: "package/binding.gyp", body: "{}" }]),
    ]);
    expect((await parse(tar)).map((f) => f.path)).toEqual(["index.js", "decoy.txt", "binding.gyp"]);
  });

  test("ignores the size a directory record declares", async () => {
    // node-tar zeroes a directory's size, so a directory claiming a body would
    // swallow the entries npm goes on to extract.
    const tar = concatBytes([
      buildTarHeaderOnly({ name: "package/dir/", type: "5", size: 1024 }),
      buildTar([{ name: "package/binding.gyp", body: "{}" }]),
    ]);
    expect((await parse(tar)).map((f) => f.path)).toEqual(["binding.gyp"]);
  });

  test("ignores the size a `0` entry named like a directory declares", async () => {
    const tar = concatBytes([
      buildTarHeaderOnly({ name: "package/dir/", type: "0", size: 1024 }),
      buildTar([{ name: "package/binding.gyp", body: "{}" }]),
    ]);
    expect((await parse(tar)).map((f) => f.path)).toEqual(["binding.gyp"]);
  });

  test.each([
    ["an empty name", { name: "", size: 1024 }],
    ["a linkname on a regular file", { name: "package/decoy.txt", size: 1024, linkname: "t" }],
    ["a link with no linkname", { name: "package/decoy", type: "2", size: 1024, linkname: " " }],
  ])(
    "skips a header npm's reader rejects for %s, without consuming its body",
    async (_l, entry) => {
      // Each of these makes node-tar skip the block and read the next 512 bytes as
      // a header, so the declared body is really the entry that follows it.
      const header = buildTarHeaderOnly(entry);
      if (entry.linkname === " ") {
        header.fill(0, 157, 257);
        sealTarHeader(header, 0);
      }
      const tar = concatBytes([header, buildTar([{ name: "package/binding.gyp", body: "{}" }])]);
      const { files, suspicious } = await parseFull(tar);
      expect(files.map((f) => f.path)).toEqual(["binding.gyp"]);
      expect(suspicious).toContainEqual(
        expect.objectContaining({
          kind: "parser-differential",
          detail: expect.stringContaining("npm's reader rejects"),
        }),
      );
    },
  );

  test("does not prepend the ustar prefix to a PAX path", async () => {
    // node-tar builds the prefixed path but then replaces it wholesale with the
    // extended-header path, so the prefix survives only for an entry named by
    // its own header. Prepending it reported a nested path for a file npm writes
    // at the package root, where the gyp and manifest rules look.
    const tar = buildTar([
      { name: "PaxHeader", type: "x", body: "28 path=package/binding.gyp\n" },
      { name: "harmless.txt", prefix: "package/lib", body: "{}" },
    ]);
    expect((await parse(tar)).map((f) => f.path)).toEqual(["binding.gyp"]);
  });

  test.each([
    ["an all-digit PAX path", "12 path=123\n"],
    ["an empty PAX path", "8 path=\n"],
  ])("skips a header npm's reader rejects for %s", async (_label, record) => {
    // node-tar coerces an all-digit value to a number and its header decode
    // throws; an empty `path=` counts as present and fails its path check. Both
    // skip the block without consuming the body, and both leave the record
    // pending so the headers after it are skipped too.
    const tar = concatBytes([
      tarEntriesOnly(buildTar([{ name: "PaxHeader", type: "x", body: record }])),
      buildTarHeaderOnly({ name: "package/decoy.txt", size: 1024 }),
      buildTar([{ name: "package/binding.gyp", body: "{}" }]),
    ]);
    const { files, suspicious } = await parseFull(tar);
    expect(files).toEqual([]);
    expect(suspicious).toContainEqual(
      expect.objectContaining({
        kind: "parser-differential",
        detail: expect.stringContaining("npm's reader rejects"),
      }),
    );
  });

  test("honors a PAX size of zero rather than falling back to the header", async () => {
    const tar = concatBytes([
      tarEntriesOnly(buildTar([{ name: "PaxHeader", type: "x", body: "9 size=0\n" }])),
      buildTar([{ name: "package/decoy.txt", body: "0123456789" }]),
    ]);
    const [decoy] = await parse(tar);
    expect(decoy.path).toBe("decoy.txt");
    expect(decoy.size).toBe(0);
  });

  test("prefers a local PAX size over a global one, and applies both to metadata", async () => {
    const tar = concatBytes([
      tarEntriesOnly(buildTar([{ name: "GlobalPaxHeader", type: "g", body: "12 size=1024\n" }])),
      tarEntriesOnly(buildTar([{ name: "PaxHeader", type: "x", body: "9 size=5\n" }])),
      buildTarHeaderOnly({ name: "package/decoy.txt", size: 99 }),
      new Uint8Array(TAR_BLOCK),
      buildTar([{ name: "package/binding.gyp", body: "{}" }]),
    ]);
    // The global size governs the `x` block that follows it, and the local size
    // then governs the entry — the same boundaries npm's reader walks.
    expect((await parse(tar)).map((f) => f.path)).toEqual(["decoy.txt", "binding.gyp"]);
  });

  test("discloses a regular entry whose path is not representable", async () => {
    const tar = buildTar([
      { name: "package/index.js", body: "// a\n" },
      { name: "package/lib\\evil.js", body: "1\n" },
    ]);
    const { files, suspicious } = await parseFull(tar);
    expect(files.map((f) => f.path)).toEqual(["index.js"]);
    expect(suspicious).toContainEqual(
      expect.objectContaining({
        kind: "parser-differential",
        path: "package/lib\\evil.js",
        detail: expect.stringContaining("not representable as a safe relative path"),
      }),
    );
  });

  test("reads the ustar prefix only when the ustar magic is present", async () => {
    const withMagic = buildTar([{ name: "binding.gyp", prefix: "package/lib", body: "{}" }]);
    expect((await parse(withMagic)).map((f) => f.path)).toEqual(["lib/binding.gyp"]);

    // Without the magic node-tar ignores bytes 345+, so the entry npm sees is
    // the bare name — the package root, where the gyp rules look.
    const withoutMagic = buildTar([{ name: "binding.gyp", prefix: "package/lib", body: "{}" }]);
    withoutMagic.fill(0, 257, 265);
    sealTarHeader(withoutMagic, 0);
    expect((await parse(withoutMagic)).map((f) => f.path)).toEqual(["binding.gyp"]);
  });

  test("reads entries hidden behind a lone all-zero block", async () => {
    const tar = concatBytes([
      tarEntriesOnly(buildTar([{ name: "package/index.js", body: "// a\n" }])),
      new Uint8Array(TAR_BLOCK),
      buildTar([{ name: "package/test.txt", body: "123\n" }]),
    ]);
    const { files, suspicious } = await parseFull(tar);
    expect(files.map((f) => f.path)).toEqual(["index.js", "test.txt"]);
    expect(suspicious).toContainEqual({
      kind: "parser-differential",
      path: "<archive>",
      detail:
        "1 entry follows an all-zero block that is not part of the two-block end-of-archive marker; a reader that ends the archive at the first all-zero block never sees them",
    });
  });

  test("counts every entry a first-block reader would miss", async () => {
    const tar = concatBytes([
      tarEntriesOnly(buildTar([{ name: "package/index.js", body: "// a\n" }])),
      new Uint8Array(TAR_BLOCK),
      buildTar([
        { name: "package/test.txt", body: "123\n" },
        { name: "package/lib/extra.js", body: "// b\n" },
      ]),
    ]);
    const { files, suspicious } = await parseFull(tar);
    expect(files.map((f) => f.path)).toEqual(["index.js", "test.txt", "lib/extra.js"]);
    expect(suspicious.find((entry) => entry.kind === "parser-differential").detail).toContain(
      "2 entries follow",
    );
  });

  test("keeps reading past repeated single zero blocks separated by entries", async () => {
    const tar = concatBytes([
      new Uint8Array(TAR_BLOCK),
      tarEntriesOnly(buildTar([{ name: "package/a.js", body: "// a\n" }])),
      new Uint8Array(TAR_BLOCK),
      buildTar([{ name: "package/b.js", body: "// b\n" }]),
    ]);
    const { files, suspicious } = await parseFull(tar);
    expect(files.map((f) => f.path)).toEqual(["a.js", "b.js"]);
    expect(suspicious.filter((entry) => entry.kind === "parser-differential")).toHaveLength(1);
  });

  test("does not flag a well-formed archive", async () => {
    const { files, suspicious } = await parseFull(
      buildTar([{ name: "package/a.js", body: "// a\n" }]),
    );
    expect(files.map((f) => f.path)).toEqual(["a.js"]);
    expect(suspicious).toEqual([]);
  });

  test("tolerates an archive that ends after a single zero block", async () => {
    const tar = concatBytes([
      tarEntriesOnly(buildTar([{ name: "package/a.js", body: "// a\n" }])),
      new Uint8Array(TAR_BLOCK),
    ]);
    const { files, suspicious } = await parseFull(tar);
    expect(files.map((f) => f.path)).toEqual(["a.js"]);
    expect(suspicious).toEqual([]);
  });

  test.each([
    ["npm package.json", "package/package.json"],
    ["PyPI sdist PKG-INFO", "foo-1.0.0/PKG-INFO"],
    ["PyPI sdist pyproject.toml", "foo-1.0.0/pyproject.toml"],
    ["root PKG-INFO", "PKG-INFO"],
  ])(
    "fails closed on an oversized root manifest (%s) instead of nulling the identity",
    async (_name, path) => {
      // A root manifest too large to inspect must fail the scan: skipping it
      // would leave package identity/dependency metadata uninspected and only
      // surface a finding, downgrading the trust-boundary failure.
      const limits = { maxFiles: 100, maxTarBytes: 1024 };
      const tar = buildTar([{ name: path, body: "x".repeat(2048) }]);
      await expect(parse(tar, limits)).rejects.toThrow(/invalid tar entry size/);
    },
  );

  test("fails closed when a root manifest is crowded out of the retention budget", async () => {
    // Earlier manifest-named (non-root) entries fill the 2×maxTarBytes headroom,
    // so the real root PKG-INFO cannot be retained. Skipping it would leave
    // identity/dependency metadata unread, so the parse fails closed instead of
    // degrading the trust-boundary failure to a content-skipped finding.
    const limits = { maxFiles: 100, maxTarBytes: 500 };
    const tar = buildTar([
      { name: "a/b/METADATA", body: new Uint8Array(500).fill(0x61) },
      { name: "c/d/METADATA", body: new Uint8Array(500).fill(0x62) },
      { name: "foo-1.0.0/PKG-INFO", body: "Metadata-Version: 2.1\nName: foo\nVersion: 1.0.0\n" },
    ]);
    await expect(parse(tar, limits)).rejects.toThrow(/invalid tar entry size/);
  });

  test("retains a PyPI sdist manifest (PKG-INFO) even under budget pressure", async () => {
    // The tgz path is shared with PyPI sdists, whose manifest is PKG-INFO under a
    // version directory. It must be force-retained the same way package.json is.
    const limits = { maxFiles: 100, maxTarBytes: 950 };
    const filler = new Uint8Array(900).fill(0x61);
    const tar = buildTar([
      { name: "foo-1.0.0/big.bin", body: filler },
      { name: "foo-1.0.0/PKG-INFO", body: "Metadata-Version: 2.1\nName: foo\nVersion: 1.0.0\n" },
    ]);
    const { files } = await parseFull(tar, limits);
    const manifest = files.find((file) => file.path.endsWith("PKG-INFO"));
    expect(manifest?.textSample).toContain("Name: foo");
    expect(manifest?.flags ?? []).not.toContain("content-skipped");
  });

  test("distinguishes per-file-limit skips from cumulative-budget skips", async () => {
    const limits = { maxFiles: 100, maxTarBytes: 1024 };
    const tar = buildTar([
      { name: "package/huge.node", body: new Uint8Array(2048).fill(0x42) },
      { name: "package/filler.bin", body: new Uint8Array(1000).fill(0x61) },
      { name: "package/late.js", body: "x".repeat(100) },
    ]);
    const { suspicious } = await parseFull(tar, limits);
    // Oversized bodies keep their per-file entry (the notable prepackaged-
    // binary pattern); the bulk budget demotion is one archive-level notice.
    const huge = suspicious.find((s) => s.path === "huge.node");
    const late = suspicious.find((s) => s.path === "late.js");
    expect(huge.detail).toContain("per-file inspection limit");
    expect(late).toBeUndefined();
    const budget = suspicious.find((s) => s.kind === "retention-tier");
    expect(budget.path).toBe("<archive>");
    expect(budget.detail).toContain("cumulative retention budget");
  });

  test("demotes bodies past the full-inspection tier instead of failing the parse", async () => {
    // Two-tier cap: maxFiles bounds text retention, maxEntries bounds the walk.
    // numpy's sdist (8k+ files, mostly vendored build system) is the shape this
    // exists for — the archive parses, and tail files are hash-only.
    const limits = { maxFiles: 2, maxTarBytes: 1 << 20 };
    const tar = buildTar([
      { name: "package/a.js", body: "const a = 1;\n" },
      { name: "package/b.js", body: "const b = 2;\n" },
      { name: "package/c.js", body: "const c = 3;\n" },
      { name: "package/d.js", body: "const d = 4;\n" },
    ]);
    const { files, suspicious } = await tarParser.readTarStream(
      new Response(tar).body,
      limits.maxFiles,
      limits.maxTarBytes,
      Infinity,
      10,
    );
    expect(files).toHaveLength(4);
    expect(files[0].textSample).toContain("const a");
    expect(files[1].textSample).toContain("const b");
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
    const tar = buildTar(
      Array.from({ length: 6 }, (_, i) => ({ name: `package/f${i}.js`, body: "x\n" })),
    );
    await expect(
      tarParser.readTarStream(new Response(tar).body, 2, 1 << 20, Infinity, 5),
    ).rejects.toThrow(/archive contains too many files/);
  });

  test("counts non-regular records toward the hard entry cap", async () => {
    const tar = buildTar(
      Array.from({ length: 6 }, (_, i) => ({
        name: `package/link-${i}`,
        type: "2",
        body: "",
      })),
    );
    await expect(
      tarParser.readTarStream(new Response(tar).body, 2, 1 << 20, Infinity, 5),
    ).rejects.toThrow(/archive contains too many files/);
  });

  test("keeps the retention-tier notice when per-file entries already filled the suspicious cap", async () => {
    // An archive can stuff the capped suspicious list with per-file entries
    // (here: symlinks) before any demotion happens; the aggregate coverage
    // disclosure must still be emitted, not silently dropped by the cap.
    const tar = buildTar([
      { name: "package/l1", type: "2", body: "" },
      { name: "package/l2", type: "2", body: "" },
      { name: "package/l3", type: "2", body: "" },
      { name: "package/a.bin", body: new Uint8Array(400).fill(0x61) },
      { name: "package/b.bin", body: new Uint8Array(400).fill(0x62) },
    ]);
    const { suspicious } = await tarParser.readTarStream(
      new Response(tar).body,
      2,
      500,
      Infinity,
      10,
    );
    const notice = suspicious.find((s) => s.kind === "retention-tier");
    expect(notice?.detail).toContain("cumulative retention budget");
    expect(notice?.detail).toContain("1 additional file bodies");
  });

  test("retains manifests past the full-inspection tier", async () => {
    // Identity evidence must not be starved by an archive padded with files:
    // PKG-INFO arrives after the tier is filled and must still carry text.
    const tar = buildTar([
      { name: "foo-1.0.0/a.js", body: "const a = 1;\n" },
      { name: "foo-1.0.0/b.js", body: "const b = 2;\n" },
      { name: "foo-1.0.0/PKG-INFO", body: "Metadata-Version: 2.1\nName: foo\nVersion: 1.0.0\n" },
    ]);
    const { files } = await tarParser.readTarStream(
      new Response(tar).body,
      2,
      1 << 20,
      Infinity,
      10,
    );
    const manifest = files.find((file) => file.path.endsWith("PKG-INFO"));
    expect(manifest?.textSample).toContain("Name: foo");
    expect(manifest?.flags ?? []).not.toContain("content-skipped");
  });

  test("releases a replaced duplicate's bytes so later files are not needlessly skipped", async () => {
    // Both copies of dup.bin fit the budget at their own decision point, so the
    // old accounting counted 1200 bytes for a 600-byte record and then wrongly
    // skipped other.bin. The replacement must release the earlier body's budget.
    const limits = { maxFiles: 100, maxTarBytes: 2000 };
    const tar = buildTar([
      { name: "package/dup.bin", body: new Uint8Array(600).fill(0x61) },
      { name: "package/dup.bin", body: new Uint8Array(600).fill(0x62) },
      { name: "package/other.bin", body: new Uint8Array(900).fill(0x63) },
    ]);
    const { files, suspicious } = await parseFull(tar, limits);
    const other = files.find((file) => file.path === "other.bin");
    expect(other?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(other?.flags ?? []).not.toContain("content-skipped");
    expect(suspicious.map((s) => s.kind)).toContain("duplicate");
  });

  test("retains a duplicate that only fits once the earlier copy's bytes are released", async () => {
    // maxTarBytes 1000, two 900-byte copies of one path. The last-write-wins copy
    // is the bytes a consumer receives; it only fits if the budget check discounts
    // the earlier copy it replaces, or that content goes uninspected.
    const limits = { maxFiles: 100, maxTarBytes: 1000 };
    const tar = buildTar([
      { name: "package/a.js", body: new Uint8Array(900).fill(0x61) },
      { name: "package/a.js", body: new Uint8Array(900).fill(0x62) },
    ]);
    const { files, suspicious } = await parseFull(tar, limits);
    const a = files.filter((file) => file.path === "a.js");
    expect(a).toHaveLength(1);
    expect(a[0].flags ?? []).not.toContain("content-skipped");
    // The retained bytes are the last-write-wins copy (0x62 → "b"), not the first.
    expect(a[0].textSample).toBe("b".repeat(900));
    expect(suspicious.map((s) => s.kind)).toContain("duplicate");
  });

  test("isRetainedManifestPath matches ecosystem manifests by basename", () => {
    expect(tarParser.isRetainedManifestPath("package.json")).toBe(true);
    expect(tarParser.isRetainedManifestPath("foo-1.0.0/PKG-INFO")).toBe(true);
    expect(tarParser.isRetainedManifestPath("foo-1.0.0/pyproject.toml")).toBe(true);
    expect(tarParser.isRetainedManifestPath("foo/bar.whl/METADATA")).toBe(true);
    expect(tarParser.isRetainedManifestPath("lib/index.js")).toBe(false);
    expect(tarParser.isRetainedManifestPath("")).toBe(false);
    expect(tarParser.isRetainedManifestPath(null)).toBe(false);
  });

  test("isRootManifestPath anchors to the archive root, not the basename anywhere", () => {
    expect(tarParser.isRootManifestPath("package.json")).toBe(true);
    expect(tarParser.isRootManifestPath("PKG-INFO")).toBe(true);
    expect(tarParser.isRootManifestPath("pyproject.toml")).toBe(true);
    expect(tarParser.isRootManifestPath("foo-1.0.0/PKG-INFO")).toBe(true);
    expect(tarParser.isRootManifestPath("foo-1.0.0/pyproject.toml")).toBe(true);
    // Nested/vendored files that merely share the basename are not root manifests.
    expect(tarParser.isRootManifestPath("vendor/dep/package.json")).toBe(false);
    expect(tarParser.isRootManifestPath("foo-1.0.0/sub/PKG-INFO")).toBe(false);
    expect(tarParser.isRootManifestPath("a/b/pyproject.toml")).toBe(false);
    // package.json is only the root at the top level (npm strips the package/ prefix).
    expect(tarParser.isRootManifestPath("foo-1.0.0/package.json")).toBe(false);
    expect(tarParser.isRootManifestPath("")).toBe(false);
    expect(tarParser.isRootManifestPath(null)).toBe(false);
  });

  test("skips a deeply-nested oversized manifest-named file instead of failing the scan", async () => {
    // Only root manifests fail closed when oversized; a vendored file that merely
    // shares the basename deeper in the tree is skipped, not fatal for the scan.
    const limits = { maxFiles: 100, maxTarBytes: 1024 };
    const tar = buildTar([
      { name: "package/package.json", body: JSON.stringify({ name: "pkg", version: "1.0.0" }) },
      { name: "package/vendor/dep/package.json", body: "x".repeat(2048) },
      { name: "package/vendor/py/sub/PKG-INFO", body: "y".repeat(2048) },
    ]);
    const { files, suspicious } = await parseFull(tar, limits);
    expect(parsePackageJson(files)?.name).toBe("pkg");
    for (const nested of ["vendor/dep/package.json", "vendor/py/sub/PKG-INFO"]) {
      expect(files.find((f) => f.path === nested)?.flags).toEqual(["content-skipped"]);
      expect(suspicious.some((s) => s.path === nested)).toBe(true);
    }
  });

  test("retains a manifest via headroom once the shared budget is exhausted", async () => {
    const limits = { maxFiles: 100, maxTarBytes: 500 };
    const tar = buildTar([
      { name: "package/filler.bin", body: new Uint8Array(500).fill(0x61) },
      { name: "foo-1.0.0/PKG-INFO", body: "Metadata-Version: 2.1\nName: foo\nVersion: 1.0.0\n" },
    ]);
    const { files } = await parseFull(tar, limits);
    const manifest = files.find((f) => f.path.endsWith("PKG-INFO"));
    expect(manifest?.textSample).toContain("Name: foo");
    expect(manifest?.flags ?? []).not.toContain("content-skipped");
  });

  test("always retains the root npm manifest even after nested manifests exhaust the headroom", async () => {
    // Nested package.json files spend the shared 2×maxTarBytes manifest headroom,
    // but the real root manifest must still be inspected or parsePackageJson goes
    // null and every npm identity/script/dependency check is silently disabled.
    const limits = { maxFiles: 100, maxTarBytes: 500 };
    const tar = buildTar([
      { name: "a/package.json", body: new Uint8Array(500).fill(0x61) },
      { name: "b/package.json", body: new Uint8Array(500).fill(0x62) },
      {
        name: "package/package.json",
        body: JSON.stringify({
          name: "pkg",
          version: "1.0.0",
          scripts: { postinstall: "node x.js" },
        }),
      },
    ]);
    const { files } = await parseFull(tar, limits);
    const root = files.find((f) => f.path === "package.json");
    expect(root?.textSample).toContain("postinstall");
    expect(root?.flags ?? []).not.toContain("content-skipped");
    expect(parsePackageJson(files)?.name).toBe("pkg");
  });

  test("bounds manifest retention headroom to twice the per-file cap", async () => {
    // Manifests bypass the shared budget but only up to a second maxTarBytes, so
    // a tar stuffed with manifest-named files cannot amplify retained memory.
    const limits = { maxFiles: 100, maxTarBytes: 500 };
    const tar = buildTar([
      { name: "a/package.json", body: new Uint8Array(500).fill(0x61) },
      { name: "b/package.json", body: new Uint8Array(400).fill(0x62) },
      { name: "c/package.json", body: new Uint8Array(400).fill(0x63) },
    ]);
    const { files } = await parseFull(tar, limits);
    expect(files.find((f) => f.path === "a/package.json")?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(files.find((f) => f.path === "b/package.json")?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(files.find((f) => f.path === "c/package.json")?.flags).toEqual(["content-skipped"]);
  });
});

describe("sniffNativeArtifact", () => {
  const { sniffNativeArtifact } = tarParser;

  function withMagic(bytes, length = 64) {
    // Zero padding stands in for the header fields a real container carries.
    const body = new Uint8Array(length);
    body.set(bytes, 0);
    return body;
  }

  test("identifies ELF, Mach-O, wasm, and PE containers by leading bytes", () => {
    expect(sniffNativeArtifact(withMagic([0x7f, 0x45, 0x4c, 0x46]))).toBe("elf");
    expect(sniffNativeArtifact(withMagic([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]))).toBe(
      "wasm",
    );
    // 64-bit little-endian Mach-O as stored on disk (arm64/x86_64 binaries).
    expect(sniffNativeArtifact(withMagic([0xcf, 0xfa, 0xed, 0xfe]))).toBe("macho");
    expect(sniffNativeArtifact(withMagic([0xfe, 0xed, 0xfa, 0xce]))).toBe("macho");
    // MZ plus the NUL-padded DOS header every real PE carries.
    expect(sniffNativeArtifact(withMagic([0x4d, 0x5a, 0x90, 0x00]))).toBe("pe");
  });

  test("splits fat Mach-O from Java class files sharing 0xCAFEBABE", () => {
    // Universal binary: two architectures.
    expect(sniffNativeArtifact(withMagic([0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00, 0x00, 0x02]))).toBe(
      "macho",
    );
    // Java class file: version 52 (Java 8) occupies the same bytes.
    expect(sniffNativeArtifact(withMagic([0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00, 0x00, 0x34]))).toBe(
      null,
    );
  });

  test("does not flag text that merely starts with MZ", () => {
    const prose = encoder.encode(
      "MZ stands for Mark Zbikowski, who designed the DOS executable format header.",
    );
    expect(sniffNativeArtifact(prose)).toBe(null);
    expect(sniffNativeArtifact(encoder.encode("MZ"))).toBe(null);
    expect(sniffNativeArtifact(new Uint8Array(0))).toBe(null);
    expect(sniffNativeArtifact(undefined)).toBe(null);
  });
});

describe("createHeadCapture", () => {
  test("retains the first bytes across chunk boundaries and ignores the rest", () => {
    const capture = tarParser.createHeadCapture(8);
    capture.update(new Uint8Array([1, 2, 3]));
    capture.update(new Uint8Array([4, 5, 6, 7, 8, 9]));
    capture.update(new Uint8Array([10]));
    expect([...capture.bytes()]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});

describe("native artifact flags on parsed files", () => {
  test("flags a retained extensionless native binary via magic bytes", async () => {
    const elf = new Uint8Array(256);
    elf.set([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00], 0);
    const tar = buildTar([{ name: "package/bin/cli-linux-x64", body: elf }]);
    const files = await parse(tar);
    expect(files[0].flags).toEqual(["native-elf", "binary"]);
    expect(files[0].textSample).toBeUndefined();
  });

  test("flags an oversized content-skipped extensionless binary via its captured head", async () => {
    // The regression behind this rule: a release ships win/linux/mac binaries,
    // only the .exe matched the extension check, and the oversized ELF and
    // Mach-O bodies were skipped before any content inspection could run.
    const limits = { maxFiles: 100, maxTarBytes: 1024 };
    const elf = new Uint8Array(4096);
    elf.set([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00], 0);
    const macho = new Uint8Array(4096);
    macho.set([0xcf, 0xfa, 0xed, 0xfe], 0);
    const tar = buildTar([
      { name: "package/bin/cli-linux-x64", body: elf },
      { name: "package/bin/cli-darwin-arm64", body: macho },
    ]);
    const { files } = await parseFull(tar, limits);
    expect(files[0].flags).toEqual(["content-skipped", "native-elf"]);
    expect(files[1].flags).toEqual(["content-skipped", "native-macho"]);
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
          peerDependencies: { host: "^2.0.0", required: "^1.0.0" },
          peerDependenciesMeta: {
            host: { optional: true },
            required: { optional: false },
            malformed: "yes",
          },
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
    expect(parsed?.peerDependenciesMeta).toEqual({
      host: { optional: true },
      required: { optional: false },
    });
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

describe("boundedByteStream", () => {
  // The sandbox pipes compressed tgz wire bytes through this cap before the
  // DecompressionStream: gzip can decode a huge input to almost nothing, so
  // the decompressed budget alone does not bound download size/inflater CPU.
  const streamOf = (bytes) =>
    new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.subarray(0, 32));
        controller.enqueue(bytes.subarray(32));
        controller.close();
      },
    });

  test("passes bytes through under the cap", async () => {
    const bytes = new Uint8Array(64).fill(7);
    const out = new Uint8Array(
      await new Response(tarParser.boundedByteStream(streamOf(bytes), 64)).arrayBuffer(),
    );
    expect(out).toEqual(bytes);
  });

  test("fails closed, tagged, when raw bytes exceed the cap", async () => {
    const bytes = new Uint8Array(64).fill(7);
    await expect(
      new Response(tarParser.boundedByteStream(streamOf(bytes), 63)).arrayBuffer(),
    ).rejects.toMatchObject({
      tarSafety: true,
      message: "archive expands beyond safety limit",
    });
  });

  test("a cap overflow reaches the parser tagged through the gzip pipe", async () => {
    // The exact composition the sandbox tgz branch uses. The tag must survive
    // pipeThrough(DecompressionStream) so the sandbox maps the overflow to a
    // 413 and acquireBaselineNpm can degrade to a no-baseline scan — an
    // untagged error would fail the whole scan instead.
    const body = new Uint8Array(65536);
    crypto.getRandomValues(body); // incompressible: gzip output ≈ input
    const tar = buildTar([{ name: "package/blob.bin", body }]);
    const cs = new CompressionStream("gzip");
    const writer = cs.writable.getWriter();
    writer.write(tar);
    writer.close();
    const compressed = new Uint8Array(await new Response(cs.readable).arrayBuffer());
    const src = new ReadableStream({
      start(controller) {
        for (let i = 0; i < compressed.length; i += 512) {
          controller.enqueue(compressed.subarray(i, Math.min(i + 512, compressed.length)));
        }
        controller.close();
      },
    });
    const piped = tarParser
      .boundedByteStream(src, 4096)
      .pipeThrough(new DecompressionStream("gzip"));
    await expect(tarParser.readTarStream(piped, 100, 1 << 20, 1 << 20)).rejects.toMatchObject({
      tarSafety: true,
      message: "archive expands beyond safety limit",
    });
  });
});

describe("digestArchiveStream", () => {
  // Binds a scan to the bytes it reviewed: the sandbox hashes the archive's
  // wire bytes so "the publisher removed this file" can be told apart from
  // "we did not receive the whole artifact".
  const CAP = 1 << 20;

  const streamOf = (bytes, chunk = 512) =>
    new ReadableStream({
      start(controller) {
        for (let i = 0; i < bytes.length; i += chunk) {
          controller.enqueue(bytes.subarray(i, Math.min(i + chunk, bytes.length)));
        }
        controller.close();
      },
    });

  async function sha1Hex(bytes) {
    const digest = await crypto.subtle.digest("SHA-1", bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  async function sha256Hex(bytes) {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  async function sha512Hex(bytes) {
    const digest = await crypto.subtle.digest("SHA-512", bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  // A body whose reader rejects overlapping reads the way workerd's does.
  // `digestArchiveStream` only ever calls getReader(), so this stands in for a
  // real stream without node's more permissive queueing hiding the bug.
  function strictSingleReadSource(bytes, onViolation, chunk = 512) {
    let offset = 0;
    let pending = false;
    return {
      getReader() {
        return {
          async read() {
            if (pending) {
              onViolation();
              throw new TypeError(
                "This ReadableStream only supports a single pending read request at a time",
              );
            }
            pending = true;
            await new Promise((resolve) => setTimeout(resolve, 0));
            pending = false;
            if (offset >= bytes.length) return { value: undefined, done: true };
            const value = bytes.subarray(offset, Math.min(offset + chunk, bytes.length));
            offset += value.byteLength;
            return { value, done: false };
          },
          cancel() {
            offset = bytes.length;
            return Promise.resolve();
          },
        };
      },
    };
  }

  test("digests the whole stream a consumer reads to the end", async () => {
    const bytes = new Uint8Array(4096).fill(3);
    const archive = tarParser.digestArchiveStream(streamOf(bytes), CAP);
    const passed = new Uint8Array(await new Response(archive.body).arrayBuffer());

    expect(passed).toEqual(bytes);
    expect(await archive.digest()).toBe(await sha1Hex(bytes));
  });

  test("can bind one archive to multiple registry digest algorithms", async () => {
    const bytes = new Uint8Array(4096).fill(7);
    const archive = tarParser.digestArchiveStream(streamOf(bytes), CAP, [
      "SHA-1",
      "SHA-256",
      "SHA-512",
    ]);
    await new Response(archive.body).arrayBuffer();

    expect(await archive.digest()).toEqual({
      "SHA-1": await sha1Hex(bytes),
      "SHA-256": await sha256Hex(bytes),
      "SHA-512": await sha512Hex(bytes),
    });
  });

  test("keeps draining the source after a consumer stops early and cancels", async () => {
    // The tar reader's shape: it stops at the end-of-archive marker and
    // cancels, leaving the trailing blocks and gzip footer unread. An inline
    // digest tap would hash only that prefix and report a mismatch on every
    // healthy scan.
    const bytes = new Uint8Array(4096);
    crypto.getRandomValues(bytes);
    const archive = tarParser.digestArchiveStream(streamOf(bytes), CAP);
    const reader = archive.body.getReader();
    await reader.read();
    await reader.cancel();

    expect(await archive.digest()).toBe(await sha1Hex(bytes));
  });

  test("completes the digest for a consumer that abandons the stream without cancelling", async () => {
    // The production shape: cancellation crosses boundedByteStream and the
    // DecompressionStream asynchronously, so the digest is usually requested
    // before the cancel arrives. digest() must finish the archive itself
    // rather than report "unverified" on every healthy scan.
    const bytes = new Uint8Array(4096);
    crypto.getRandomValues(bytes);
    const archive = tarParser.digestArchiveStream(streamOf(bytes), CAP);
    const reader = archive.body.getReader();
    await reader.read();

    expect(await archive.digest()).toBe(await sha1Hex(bytes));
  });

  test("cancels the source without draining it when archive parsing fails", async () => {
    // A malformed first header must fail fast. The sandbox calls abort() on
    // this path, so hostile bytes after the parse error are neither downloaded
    // nor hashed for a verdict that will be discarded.
    const totalBytes = 4 << 20;
    const chunkSize = 64 << 10;
    let emitted = 0;
    let sourceCancelled = false;
    const source = new ReadableStream(
      {
        pull(controller) {
          if (emitted >= totalBytes) {
            controller.close();
            return;
          }
          const chunk = new Uint8Array(Math.min(chunkSize, totalBytes - emitted));
          // A sealed header whose size field is not octal: the checksum has to
          // be valid for the reader to reach the size at all (a bad checksum is
          // a block npm's reader skips, so this one skips it too).
          if (emitted === 0) {
            chunk.set(buildTar([{ name: "package/x.js", body: "abc" }]).subarray(0, 512), 0);
            chunk.set(encoder.encode("XYZZZZZZZZZ\0"), 124);
            sealTarHeader(chunk, 0);
          }
          emitted += chunk.byteLength;
          controller.enqueue(chunk);
        },
        cancel() {
          sourceCancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const archive = tarParser.digestArchiveStream(source, CAP);

    await expect(tarParser.readTarStream(archive.body, 100, CAP, CAP)).rejects.toThrow(
      "invalid tar entry size",
    );
    await archive.abort();

    expect(sourceCancelled).toBe(true);
    expect(emitted).toBeLessThanOrEqual(3 * chunkSize);
    expect(await archive.digest()).toBeNull();
  });

  test("digests a real gzipped tar read through readTarStream", async () => {
    // The exact composition the sandbox tgz branch uses, end to end: the
    // digest must equal the sha1 of the .tgz wire bytes even though the parser
    // stops at the end-of-archive marker.
    const tar = buildTar([
      { name: "package/package.json", body: encoder.encode('{"name":"demo"}') },
      { name: "package/index.js", body: encoder.encode("module.exports = 1\n") },
    ]);
    const cs = new CompressionStream("gzip");
    const writer = cs.writable.getWriter();
    writer.write(tar);
    writer.close();
    const compressed = new Uint8Array(await new Response(cs.readable).arrayBuffer());

    const archive = tarParser.digestArchiveStream(streamOf(compressed), CAP);
    const { files } = await tarParser.readTarStream(
      tarParser.boundedByteStream(archive.body, CAP).pipeThrough(new DecompressionStream("gzip")),
      100,
      CAP,
      CAP,
    );

    expect(files.map((file) => file.path)).toEqual(["package.json", "index.js"]);
    expect(await archive.digest()).toBe(await sha1Hex(compressed));
  });

  test("reports no digest when the source errors", async () => {
    const failing = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.error(new Error("connection reset"));
      },
    });
    const archive = tarParser.digestArchiveStream(failing, CAP);

    await expect(new Response(archive.body).arrayBuffer()).rejects.toThrow();
    expect(await archive.digest()).toBeNull();
  });

  test("reports no digest when the archive exceeds the digest cap", async () => {
    const bytes = new Uint8Array(4096).fill(9);
    const archive = tarParser.digestArchiveStream(streamOf(bytes), 1024);
    const passed = new Uint8Array(await new Response(archive.body).arrayBuffer());

    // Passing bytes through is unaffected: only verification is abandoned.
    expect(passed).toEqual(bytes);
    expect(await archive.digest()).toBeNull();
  });

  test("never issues two concurrent reads to the source", async () => {
    // workerd's ReadableStream rejects a second read while one is pending
    // ("only supports a single pending read request at a time"), and node's
    // does not — so every unit test here would pass with the read chaining
    // deleted while the real sandbox returned null on every scan. This source
    // enforces workerd's rule so the invariant is pinned in the fast suite.
    const bytes = new Uint8Array(4096);
    crypto.getRandomValues(bytes);
    let violations = 0;
    const source = strictSingleReadSource(bytes, () => violations++);

    const archive = tarParser.digestArchiveStream(source, CAP);
    const reader = archive.body.getReader();
    // Read and drain overlap here exactly as they do in the sandbox: a cancel
    // crossing boundedByteStream and the DecompressionStream lands after
    // digest() has already started finishing the archive.
    const firstRead = reader.read();
    const digested = archive.digest();
    await firstRead;

    expect(await digested).toBe(await sha1Hex(bytes));
    expect(violations).toBe(0);
  });

  test("reports no digest when hashing a chunk fails mid-stream", async () => {
    // The dangerous shape is not the failure, it is what follows it: if the
    // hash failure escapes the pass-through's error handling, digest() reads
    // the rest of the source, observes EOF, and returns a well-formed hash
    // over the archive minus one chunk — a mismatch accusing a publisher of
    // bytes they did stage.
    const unhashable = {
      get byteLength() {
        throw new Error("digest failed");
      },
    };
    const source = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(512).fill(1));
        controller.enqueue(unhashable);
        controller.enqueue(new Uint8Array(512).fill(2));
        controller.close();
      },
    });
    const archive = tarParser.digestArchiveStream(source, CAP);

    await expect(new Response(archive.body).arrayBuffer()).rejects.toThrow();
    expect(await archive.digest()).toBeNull();
  });

  test("fails a consumer read still in flight when the archive is aborted", async () => {
    // abort() returns early from every `aborted` guard without enqueuing,
    // closing, or erroring, so a consumer waiting on `body` would hang rather
    // than see the abort.
    const stalled = new ReadableStream({
      pull() {
        return new Promise(() => {});
      },
    });
    const archive = tarParser.digestArchiveStream(stalled, CAP);
    const pending = archive.body.getReader().read();

    await archive.abort();

    await expect(pending).rejects.toThrow();
    expect(await archive.digest()).toBeNull();
  });

  test("reports no digest when the source fails during the post-cancel drain", async () => {
    // A download that dies after the parser stopped reading must not be
    // reported as a digest mismatch: absent evidence is "unverified".
    let controllerRef;
    const flaky = new ReadableStream({
      start(controller) {
        controllerRef = controller;
        controller.enqueue(new Uint8Array([1, 2, 3]));
      },
    });
    const archive = tarParser.digestArchiveStream(flaky, CAP);
    const reader = archive.body.getReader();
    await reader.read();
    const cancelled = reader.cancel();
    controllerRef.error(new Error("connection reset"));
    await cancelled;

    expect(await archive.digest()).toBeNull();
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
    "normalizePeerDependenciesMeta",
    "normalizeStringList",
    "canonicalizePath",
    "hasUnicodeConfusables",
    "isRootGypPath",
    "hasImplicitNodeGypInstall",
    "isSafePaxPath",
    "normalizeTarPath",
    "parsePax",
    "describeNonRegularType",
    "sha256Hex",
    "createSha256Digester",
    "createDigester",
    "digestArchiveStream",
    "createStreamCursor",
    "shouldSkipTextSample",
    "clipTextSample",
    "sniffNativeArtifact",
    "createHeadCapture",
    "summarizeFile",
    "summarizeSkippedFile",
    "isRetainedManifestPath",
    "isRootManifestPath",
    "tarError",
    "tarHeaderChecksum",
    "isRejectedTarNumber",
    "readTarStream",
    "readUint16Le",
    "readUint32Le",
    "inflateRawBounded",
    "boundedByteStream",
    "pumpDeflatedZipEntry",
    "digestSkippedZipEntry",
    "inflateRetainedZipEntry",
    "readZipStream",
    "findZipEndOfCentralDirectory",
    "readStreamBounded",
    "readZipArchiveBuffered",
    "parsePackageJson",
  ];

  test("every required parser export keeps its function name", () => {
    for (const name of SANDBOX_EXPORT_NAMES) {
      // oxlint-disable-next-line import/namespace -- this test intentionally verifies the dynamic export contract.
      const fn = tarParser[name];
      expect(typeof fn, `${name} must be exported`).toBe("function");
      expect(fn.name, `${name} must keep its declared name`).toBe(name);
    }
  });

  test("concatenated source parses and runs without module-level dependencies", () => {
    // oxlint-disable-next-line import/namespace -- every export name is exercised from the contract list above.
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
  normalized: normalizeTarPath("package/index.js"),
  stripped: normalizeTarPath("dist/index.js", "strip1")
};`,
    );
    // `stripped` also pins that the strip modes stay inline literals: a shared
    // constant would be a module-level dependency this rendered source lacks.
    expect(run()).toEqual({
      safe: true,
      unsafe: false,
      normalized: "index.js",
      stripped: "index.js",
    });
  });
});
