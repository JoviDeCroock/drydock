// @ts-nocheck
// Property-based / fuzz coverage for the archive parsers (issue #311, Phase 6).
//
// The tarball + wheel parsers run on fully untrusted bytes inside the sandbox
// (server/lib/tar-parser.js, driven by server/lib/sandbox.ts). The hand-written
// regression specs in tar-parser.test.mjs / zip-parser.test.mjs pin specific
// known-tricky inputs; this suite asserts the *invariants* that must hold for
// EVERY input — so a future change that opens a path-escape, count/size-cap
// bypass, or an unbounded loop fails here even without someone hand-writing the
// exact malicious archive.
//
// The two load-bearing security invariants:
//   1. Path safety — every emitted file.path is structurally safe: relative,
//      with no traversal segment, Windows drive letter, backslash, or NUL, so
//      it can never escape the extraction root. The normalizer properties prove
//      normalizeTarPath / normalizeZipPath only ever return structurally-safe
//      paths (or null); the parser properties prove the parser only emits what
//      the normalizer returned. Together: no input surfaces an unsafe path.
//   2. Fail-closed — for arbitrary or corrupted bytes the parser either returns
//      a bounded, path-safe result or throws an Error. It must never hang,
//      throw a non-Error, exceed the file-count / byte caps, or leak an unsafe
//      path.
//
// A fixed seed keeps CI deterministic (the invariants are total, so a varying
// seed would only ever surface a real bug); fast-check prints the seed + the
// shrunk counterexample on failure so any regression is reproducible.

import fc from "fast-check";
import { describe, expect, test } from "vitest";
import * as parser from "../server/lib/tar-parser.js";
import { buildTar, buildZip, encoder } from "./helpers/archive-fixtures.mjs";

const {
  normalizeTarPath,
  normalizeZipPath,
  canonicalizePath,
  isSafePaxPath,
  shouldSkipTextSample,
  readTar,
  readZipArchive,
} = parser;

const SEED = 0xc0ffee;

// In-suite run counts are kept modest so `pnpm run verify` stays fast. Set
// FUZZ_RUNS to scale properties up for deep/nightly exploration, e.g.
// `pnpm run fuzz` (FUZZ_RUNS=20000). The invariants are total, so more runs
// only widen coverage — they never make a healthy parser fail. `cap` bounds the
// expensive async properties (those that build + hash large archives) so a deep
// run pours iterations into the cheap pure-function properties without timing
// out on the heavy ones.
function runs(base, cap = Infinity) {
  const override = Number(process.env.FUZZ_RUNS);
  const effective = Number.isFinite(override) && override > 0 ? override : base;
  return Math.min(effective, cap);
}

// Tight limits so the fuzz generators can actually reach the cap branches
// (the production sandbox uses 2500 files / 25 MB — see SANDBOX_MAX_* in
// sandbox.ts). Round-trip properties use roomy limits so a valid archive is
// never rejected for tripping a cap.
const FUZZ_LIMITS = { maxFiles: 32, maxBytes: 1 << 20 };
const ROOMY_LIMITS = { maxFiles: 2_500, maxBytes: 25 * 1024 * 1024 };

// The structural guarantee a normalized package path must satisfy: relative,
// no traversal segments, no backslash / NUL / Windows drive, bounded length.
// Equivalent to the postconditions of normalizeTarPath / normalizeZipPath.
function isStructurallySafePath(path) {
  if (typeof path !== "string" || path.length === 0 || path.length > 512) return false;
  if (path.startsWith("/")) return false;
  if (path.includes("\\") || path.includes("\0")) return false;
  if (/^[A-Za-z]:/.test(path)) return false;
  return path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

// Path segments that always normalize to themselves: ASCII, never `.`/`..`,
// never the `package/` prefix the tar normalizer strips. Joined paths are
// therefore fixed points of both normalizers, so a valid archive round-trips
// to exactly the paths we put in.
const SEGMENT = fc.constantFrom(
  "a",
  "b",
  "lib",
  "src",
  "dist",
  "index",
  "util",
  "core",
  "mod",
  "x1",
  "y2",
  "z3",
  "sub",
  "deep",
  "leaf",
  "bin",
  "test",
  "data",
);
const EXT = fc.constantFrom("", ".js", ".mjs", ".py", ".json", ".txt");
const safePathArb = fc
  .tuple(fc.array(SEGMENT, { minLength: 1, maxLength: 5 }), EXT)
  .map(([segments, ext]) => segments.join("/") + ext);

// Printable bodies that decodeText returns verbatim (no control-char noise), so
// textSample round-trips exactly.
const textBodyArb = fc.constantFrom(
  "export const x = 1;\n",
  "// note\n",
  "module.exports = {};\n",
  "print('hi')\n",
  "{}\n",
  "data data data\n",
  "",
);

// Strings that exercise the path-normalization edge cases: traversal, prefixes,
// separators, NUL/backslash, drive letters, unicode confusables, plus broad
// unicode for good measure.
const trickyPathArb = fc.oneof(
  fc.string(),
  fc.string({ unit: "binary" }),
  fc
    .array(
      fc.constantFrom(
        "..",
        ".",
        "/",
        "//",
        "\\",
        "\0",
        "package/",
        "C:",
        "z:",
        "a",
        "b",
        "lib",
        "​",
        "⁄",
        "／",
        "﻿",
        "x".repeat(200),
      ),
      { maxLength: 8 },
    )
    .map((parts) => parts.join("")),
);

function mutate(bytes, mutations) {
  const copy = bytes.slice();
  if (copy.length === 0) return copy;
  for (const { index, value } of mutations) copy[index % copy.length] = value;
  return copy;
}
const mutationsArb = fc.array(
  fc.record({ index: fc.nat(), value: fc.integer({ min: 0, max: 255 }) }),
  { minLength: 1, maxLength: 16 },
);

// Shared fail-closed assertion. `run` resolves to { files, suspicious }; the
// caller supplies the total-bytes bound that should hold for a successful parse.
async function expectFailClosed(run, { maxFiles, perFileMax, totalMax }) {
  let result;
  try {
    result = await run();
  } catch (error) {
    // Any rejection must be a real Error (no string throws, no undefined) — a
    // bounded, inspectable failure rather than a crash.
    expect(error).toBeInstanceOf(Error);
    return;
  }
  expect(Array.isArray(result.files)).toBe(true);
  expect(result.files.length).toBeLessThanOrEqual(maxFiles);
  let total = 0;
  for (const file of result.files) {
    // The load-bearing security invariant: every emitted path is structurally
    // safe (relative, no traversal/drive/backslash/NUL), so it can never escape
    // the extraction root regardless of how hostile the input bytes are.
    expect(isStructurallySafePath(file.path)).toBe(true);
    expect(file.size).toBeLessThanOrEqual(perFileMax);
    total += file.size;
  }
  expect(total).toBeLessThanOrEqual(totalMax);
  if (Array.isArray(result.suspicious)) {
    // suspicious is capped at maxFiles entries plus a single limit marker.
    expect(result.suspicious.length).toBeLessThanOrEqual(maxFiles + 1);
  }
}

describe("path normalizer invariants", () => {
  test("normalizeTarPath output is always structurally safe", () => {
    // Idempotence is deliberately NOT asserted: normalizeTarPath strips exactly
    // one `package/` npm wrapper, so `package/package/x` → `package/x` (a real
    // file in a `package/` subdir, matching npm's single-level unwrap), which is
    // not a fixed point. Stripping repeatedly would desync the scanner's path
    // from what npm installs — a worse bug than the non-idempotence. Structural
    // safety is the invariant that actually matters, and it is total.
    fc.assert(
      fc.property(trickyPathArb, (raw) => {
        const out = normalizeTarPath(raw);
        if (out === null) return;
        expect(isStructurallySafePath(out)).toBe(true);
      }),
      // `package//C:` is the fuzz-found drive-letter escape (#311); replay it
      // every run so the regression is guarded independent of numRuns.
      { seed: SEED, numRuns: runs(1000), examples: [["package//C:"], ["package//Z:evil"]] },
    );
  });

  test("normalizeTarPath strips exactly one package/ wrapper", () => {
    // Pin the single-strip semantics that make the normalizer non-idempotent.
    expect(normalizeTarPath("package/package/x")).toBe("package/x");
    expect(normalizeTarPath("package/lib/index.js")).toBe("lib/index.js");
  });

  test("normalizeZipPath output is always safe and idempotent", () => {
    // Unlike tar, the wheel/zip normalizer does no wrapper-stripping, so its
    // output is a genuine fixed point — assert that too.
    fc.assert(
      fc.property(trickyPathArb, (raw) => {
        const out = normalizeZipPath(raw);
        if (out === null) return;
        expect(isStructurallySafePath(out)).toBe(true);
        expect(normalizeZipPath(out)).toBe(out);
      }),
      { seed: SEED, numRuns: runs(1000) },
    );
  });

  test("canonicalizePath is idempotent", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary" }), (raw) => {
        const once = canonicalizePath(raw);
        expect(canonicalizePath(once)).toBe(once);
      }),
      { seed: SEED, numRuns: runs(1000) },
    );
  });

  test("isSafePaxPath implies no NUL or backslash", () => {
    fc.assert(
      fc.property(trickyPathArb, (raw) => {
        if (!isSafePaxPath(raw)) return;
        expect(raw.includes("\0")).toBe(false);
        expect(raw.includes("\\")).toBe(false);
      }),
      { seed: SEED, numRuns: runs(1000) },
    );
  });
});

describe("tar parser — valid archives round-trip", () => {
  const entriesArb = fc.uniqueArray(fc.record({ path: safePathArb, body: textBodyArb }), {
    selector: (entry) => entry.path,
    maxLength: 24,
  });

  test("emits exactly the input paths with intact bodies and no false suspicion", async () => {
    await fc.assert(
      fc.asyncProperty(entriesArb, async (entries) => {
        const tar = buildTar(entries.map((entry) => ({ name: entry.path, body: entry.body })));
        const { files, suspicious } = await readTar(
          tar.buffer,
          ROOMY_LIMITS.maxFiles,
          ROOMY_LIMITS.maxBytes,
        );

        expect(files.map((file) => file.path)).toEqual(entries.map((entry) => entry.path));
        // Clean ASCII paths must never be reported as confusable/duplicate/etc.
        expect(suspicious).toEqual([]);
        for (let i = 0; i < entries.length; i += 1) {
          const expectedBytes = encoder.encode(entries[i].body);
          expect(files[i].size).toBe(expectedBytes.length);
          expect(files[i].sha256).toMatch(/^[0-9a-f]{64}$/);
          if (entries[i].body && !shouldSkipTextSample(files[i].path)) {
            expect(files[i].textSample).toBe(entries[i].body);
          }
          expect(isStructurallySafePath(files[i].path)).toBe(true);
        }
      }),
      { seed: SEED, numRuns: runs(120, 1500) },
    );
  });
});

describe("tar parser — adversarial bytes fail closed", () => {
  test("arbitrary bytes never escape the parser invariants", async () => {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ maxLength: 4096 }), async (bytes) => {
        await expectFailClosed(() => readTar(bytes, FUZZ_LIMITS.maxFiles, FUZZ_LIMITS.maxBytes), {
          maxFiles: FUZZ_LIMITS.maxFiles,
          perFileMax: FUZZ_LIMITS.maxBytes,
          totalMax: bytes.length, // tar bodies are non-overlapping slices of the input
        });
      }),
      { seed: SEED, numRuns: runs(300, 8000) },
    );
  });

  test("byte-mutated valid tars fail closed", async () => {
    const baseArb = fc.uniqueArray(fc.record({ path: safePathArb, body: textBodyArb }), {
      selector: (entry) => entry.path,
      minLength: 1,
      maxLength: 8,
    });
    await fc.assert(
      fc.asyncProperty(baseArb, mutationsArb, async (entries, mutations) => {
        const tar = buildTar(entries.map((entry) => ({ name: entry.path, body: entry.body })));
        const corrupted = mutate(tar, mutations);
        await expectFailClosed(
          () => readTar(corrupted.buffer, FUZZ_LIMITS.maxFiles, FUZZ_LIMITS.maxBytes),
          {
            maxFiles: FUZZ_LIMITS.maxFiles,
            perFileMax: FUZZ_LIMITS.maxBytes,
            totalMax: corrupted.length,
          },
        );
      }),
      { seed: SEED, numRuns: runs(250, 8000) },
    );
  });

  test("honors the file-count cap", async () => {
    const manyArb = fc.uniqueArray(safePathArb, {
      selector: (p) => p,
      minLength: 1,
      maxLength: 40,
    });
    await fc.assert(
      fc.asyncProperty(manyArb, async (paths) => {
        const tar = buildTar(paths.map((path) => ({ name: path, body: "x\n" })));
        try {
          const { files } = await readTar(tar.buffer, 8, FUZZ_LIMITS.maxBytes);
          expect(files.length).toBeLessThanOrEqual(8);
        } catch (error) {
          expect(error).toBeInstanceOf(Error);
          expect(error.message).toMatch(/too many files/);
        }
      }),
      { seed: SEED, numRuns: runs(120, 2000) },
    );
  });
});

describe("zip parser — valid archives round-trip", () => {
  const entriesArb = fc.uniqueArray(
    fc.record({ path: safePathArb, body: textBodyArb, deflate: fc.boolean() }),
    { selector: (entry) => entry.path, maxLength: 24 },
  );

  test("emits exactly the input paths with intact bodies", async () => {
    await fc.assert(
      fc.asyncProperty(entriesArb, async (entries) => {
        const zip = buildZip(entries);
        const files = await readZipArchive(
          zip.buffer,
          ROOMY_LIMITS.maxFiles,
          ROOMY_LIMITS.maxBytes,
        );

        expect(files.map((file) => file.path)).toEqual(entries.map((entry) => entry.path));
        for (let i = 0; i < entries.length; i += 1) {
          const expectedBytes = encoder.encode(entries[i].body);
          expect(files[i].size).toBe(expectedBytes.length);
          expect(isStructurallySafePath(files[i].path)).toBe(true);
          if (entries[i].body && !shouldSkipTextSample(files[i].path)) {
            expect(files[i].textSample).toBe(entries[i].body);
          }
        }
      }),
      { seed: SEED, numRuns: runs(120, 1500) },
    );
  });
});

describe("zip parser — adversarial bytes fail closed", () => {
  const zipRun = (bytes) => async () => ({
    files: await readZipArchive(bytes, FUZZ_LIMITS.maxFiles, FUZZ_LIMITS.maxBytes),
    suspicious: [],
  });

  test("arbitrary bytes never escape the parser invariants", async () => {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ maxLength: 4096 }), async (bytes) => {
        await expectFailClosed(zipRun(bytes), {
          maxFiles: FUZZ_LIMITS.maxFiles,
          perFileMax: FUZZ_LIMITS.maxBytes,
          totalMax: FUZZ_LIMITS.maxBytes, // zip enforces a cumulative expansion cap
        });
      }),
      { seed: SEED, numRuns: runs(300, 8000) },
    );
  });

  test("byte-mutated valid zips fail closed", async () => {
    const baseArb = fc.uniqueArray(
      fc.record({ path: safePathArb, body: textBodyArb, deflate: fc.boolean() }),
      { selector: (entry) => entry.path, minLength: 1, maxLength: 8 },
    );
    await fc.assert(
      fc.asyncProperty(baseArb, mutationsArb, async (entries, mutations) => {
        const corrupted = mutate(buildZip(entries), mutations);
        await expectFailClosed(zipRun(corrupted), {
          maxFiles: FUZZ_LIMITS.maxFiles,
          perFileMax: FUZZ_LIMITS.maxBytes,
          totalMax: FUZZ_LIMITS.maxBytes,
        });
      }),
      { seed: SEED, numRuns: runs(250, 8000) },
    );
  });

  test("rejects a decompression bomb that overruns the byte cap", async () => {
    // A tiny deflate stream whose declared uncompressed size dwarfs the cap is
    // the zip-bomb shape; the parser must refuse before materializing it.
    const huge = new Uint8Array(2 * FUZZ_LIMITS.maxBytes); // zero-filled → compresses tiny
    const zip = buildZip([{ path: "dist/bomb.js", body: huge, deflate: true }]);
    await expect(
      readZipArchive(zip.buffer, FUZZ_LIMITS.maxFiles, FUZZ_LIMITS.maxBytes),
    ).rejects.toThrow(/expands beyond safety limit/);
  });
});

describe("regression invariants", () => {
  test("a payload buried past any fixed window still reaches the scanner (#191)", async () => {
    // Property form of the issue #191 acceptance test: regardless of how much
    // benign filler precedes the marker, the whole-file text sample must still
    // contain it — the parser must not clip to a fixed head.
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 200_000 }), async (fillerLen) => {
        const filler = "// pad\n".repeat(Math.ceil(fillerLen / 7));
        const marker = "eval(process.env.SECRET)\n";
        const body = encoder.encode(filler + marker);
        const tar = buildTar([{ name: "index.js", body }]);
        const { files } = await readTar(tar.buffer, ROOMY_LIMITS.maxFiles, ROOMY_LIMITS.maxBytes);
        expect(files).toHaveLength(1);
        expect(files[0].size).toBe(body.length);
        expect(files[0].textSample).toContain(marker);
      }),
      { seed: SEED, numRuns: runs(40, 300) },
    );
  });
});
