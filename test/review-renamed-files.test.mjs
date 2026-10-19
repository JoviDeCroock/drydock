import { describe, expect, test } from "vitest";
import { pairRenamedFiles } from "../server/lib/review/renamed-files";

const file = (path, textSample, flags = []) => ({ path, textSample, flags });
const body = (seed, rows = 40) =>
  Array.from(
    { length: rows },
    (_, index) => `export function ${seed}Row${index}(row) { return row.cells[${index}]; }`,
  ).join("\n");

describe("renamed file pairing", () => {
  test("pairs a chunk with its predecessor by content, whatever the hash says", () => {
    const pairs = pairRenamedFiles(
      [
        file("dist/chunk-YQNCOY6V.js", body("format")),
        file("dist/chunk-AB12CD34.js", body("parse")),
      ],
      [
        file("dist/chunk-64MTZBJ6.js", `${body("format")}\nexport const v = 2;`),
        file("dist/chunk-ZZ99ZZ99.js", body("render")),
      ],
    );

    expect([...pairs]).toEqual([["dist/chunk-64MTZBJ6.js", "dist/chunk-YQNCOY6V.js"]]);
  });

  test("tolerates re-mangled short identifiers in minified output", () => {
    const minified = (a, b) =>
      Array.from(
        { length: 40 },
        (_, index) => `function ${a}${index}(${b}){return ${b}.cells[${index}]+${b}.offset}`,
      ).join(";");
    const pairs = pairRenamedFiles(
      [file("dist/index-D1vYaNWZ.cjs", minified("formatRow", "e"))],
      [file("dist/index-Bqjv9TxC.cjs", minified("formatRow", "t"))],
    );

    expect(pairs.get("dist/index-Bqjv9TxC.cjs")).toBe("dist/index-D1vYaNWZ.cjs");
  });

  test("a removed file pairs with at most one added file, the closest", () => {
    const original = body("format");
    const pairs = pairRenamedFiles(
      [file("dist/a-11111111.js", original)],
      [
        file("dist/b-22222222.js", `${original}\n${body("extra", 10)}`),
        file("dist/c-33333333.js", `${original}\nexport const v = 2;`),
      ],
    );

    expect([...pairs]).toEqual([["dist/c-33333333.js", "dist/a-11111111.js"]]);
  });

  test("a chunk the release substantially rewrote does not pair", () => {
    // Two thirds of the predecessor kept, a third replaced: Jaccard 0.5.
    const pairs = pairRenamedFiles(
      [file("dist/chunk-YQNCOY6V.js", `${body("keep", 30)}\n${body("old", 15)}`)],
      [file("dist/chunk-64MTZBJ6.js", `${body("keep", 30)}\n${body("new", 15)}`)],
    );

    expect(pairs.size).toBe(0);
  });

  test("an added file pairs with at most one predecessor", () => {
    const pairs = pairRenamedFiles(
      [file("dist/a-11111111.js", body("format")), file("dist/b-11111111.js", body("format"))],
      [file("dist/c-22222222.js", body("format"))],
    );

    expect([...pairs]).toEqual([["dist/c-22222222.js", "dist/a-11111111.js"]]);
  });

  test("never pairs across directories, extensions, binaries or non-code files", () => {
    const pairs = pairRenamedFiles(
      [
        file("dist/one-11111111.js", body("one")),
        file("dist/two-11111111.cjs", body("two")),
        file("dist/three-11111111.js", body("three"), ["binary"]),
        file("dist/four-11111111.txt", body("four")),
        file("dist/types-11111111.d.ts", body("five")),
      ],
      [
        file("lib/one-22222222.js", body("one")),
        file("dist/two-22222222.mjs", body("two")),
        file("dist/three-22222222.js", body("three")),
        file("dist/four-22222222.txt", body("four")),
        file("dist/types-22222222.ts", body("five")),
      ],
    );

    expect(pairs.size).toBe(0);
  });

  test("leaves files unpaired once the shingling budget is spent", () => {
    const text = body("format");
    const previous = [file("dist/a-11111111.js", text)];
    const staged = [file("dist/a-22222222.js", text)];

    expect(pairRenamedFiles(previous, staged).size).toBe(1);
    expect(pairRenamedFiles(previous, staged, text.length).size).toBe(0);
  });

  test("bounds overlap counting when every shingle hits a full posting list", () => {
    // Identical removed files fill each posting list, so a release adding
    // many copies would cost list length per shingle on top of its characters.
    const text = Array.from({ length: 4_000 }, (_, index) => `q${index}x`).join(";");
    const previous = Array.from({ length: 32 }, (_, index) => file(`d/r${index}.js`, text));
    const staged = Array.from({ length: 1_744 }, (_, index) => file(`d/a${index}.js`, text));

    const start = performance.now();
    const pairs = pairRenamedFiles(previous, staged);
    const elapsed = performance.now() - start;

    expect(pairs.size).toBeLessThanOrEqual(32);
    expect(elapsed).toBeLessThan(2_500);
  }, 30_000);
});
