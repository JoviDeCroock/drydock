// @ts-nocheck
import { describe, expect, test } from "vitest";
import * as tarParser from "../server/lib/tar-parser.js";

const {
  decodeText,
  gunzipBounded,
  isSafePaxPath,
  normalizeTarPath,
  parsePackageJson,
  parsePax,
  readTar,
} = tarParser;

// Minimal POSIX/ustar tar writer for fixture archives.
//
// Each header is exactly 512 bytes; entry bodies are zero-padded to a
// multiple of 512. The archive is terminated with two zero blocks.
const BLOCK = 512;
const encoder = new TextEncoder();

function pad(bytes, length) {
  if (bytes.length > length) throw new Error("field overflow: " + bytes.length + " > " + length);
  const out = new Uint8Array(length);
  out.set(bytes, 0);
  return out;
}

function octal(value, length) {
  const text = value.toString(8).padStart(length - 1, "0");
  return pad(encoder.encode(text + "\0"), length);
}

function header({ name = "", size = 0, type = "0", prefix = "" }) {
  const buf = new Uint8Array(BLOCK);
  buf.set(pad(encoder.encode(name), 100), 0);
  buf.set(pad(encoder.encode("0000644"), 8), 100); // mode
  buf.set(pad(encoder.encode("0000000"), 8), 108); // uid
  buf.set(pad(encoder.encode("0000000"), 8), 116); // gid
  buf.set(octal(size, 12), 124);
  buf.set(pad(encoder.encode("00000000000"), 12), 136); // mtime
  // checksum placeholder (8 spaces) — readTar doesn't validate it
  buf.set(pad(encoder.encode("        "), 8), 148);
  buf[156] = type.charCodeAt(0);
  buf.set(pad(encoder.encode(""), 100), 157); // linkname
  buf.set(pad(encoder.encode("ustar"), 6), 257);
  buf.set(pad(encoder.encode("00"), 2), 263);
  buf.set(pad(encoder.encode(prefix), 155), 345);
  return buf;
}

function body(content) {
  const bytes = content instanceof Uint8Array ? content : encoder.encode(content);
  const padded = Math.ceil(bytes.length / BLOCK) * BLOCK;
  const out = new Uint8Array(padded);
  out.set(bytes, 0);
  return out;
}

function buildTar(entries) {
  const parts = [];
  for (const entry of entries) {
    const data = entry.body ?? "";
    const bytes = data instanceof Uint8Array ? data : encoder.encode(data);
    parts.push(header({ ...entry, size: bytes.length }));
    parts.push(body(bytes));
  }
  parts.push(new Uint8Array(BLOCK * 2)); // end-of-archive
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

const PARSE_LIMITS = { maxFiles: 250, maxBytesPerFile: 64 * 1024, maxTarBytes: 25 * 1024 * 1024 };

function parse(tar, limits = PARSE_LIMITS) {
  return readTar(tar.buffer, limits.maxFiles, limits.maxBytesPerFile, limits.maxTarBytes);
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

  test("flags `truncated` when a file body exceeds maxBytesPerFile", async () => {
    const big = new Uint8Array(2048).fill(0x41); // 'A' x 2048
    const tar = buildTar([{ name: "package/large.txt", body: big }]);
    const files = await parse(tar, { ...PARSE_LIMITS, maxBytesPerFile: 1024 });
    expect(files[0].flags).toContain("truncated");
    expect(files[0].size).toBe(2048);
    expect(files[0].textSample?.length).toBe(1024);
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

  test("skips hardlink and symlink entries entirely", async () => {
    const tar = buildTar([
      { name: "package/symlink", type: "2", body: "" },
      { name: "package/hardlink", type: "1", body: "" },
      { name: "package/real.js", body: "real\n" },
    ]);
    const files = await parse(tar);
    expect(files.map((f) => f.path)).toEqual(["real.js"]);
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
        }),
      },
    ];
    const parsed = parsePackageJson(files);
    expect(parsed?.name).toBe("@scope/pkg");
    expect(parsed?.version).toBe("1.2.3");
    expect(parsed?.scripts?.preinstall).toBe("node bad.js");
    expect(parsed?.dependencies?.foo).toBe("1.0.0");
    expect(parsed?.devDependencies).toEqual({});
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
    "isSafePaxPath",
    "normalizeTarPath",
    "parsePax",
    "sha256Hex",
    "summarizeFile",
    "readTar",
    "parsePackageJson",
    "gunzipBounded",
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
