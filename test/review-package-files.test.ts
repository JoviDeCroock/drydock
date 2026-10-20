import { describe, expect, test } from "vitest";
import {
  compilePackageFilesAllowlist,
  isOutsidePackageFilesAllowlist,
} from "../server/lib/review/package-files";

function outside(
  files: string[],
  paths: string[],
  extra: Record<string, unknown> = {},
  manifests: Record<string, unknown> = {},
) {
  const allowlist = compilePackageFilesAllowlist(
    { files, ...extra },
    { files, ...extra },
    { packedManifest: (path) => manifests[path] },
  );
  const result = allowlist?.outsidePaths(paths);
  return paths.filter((path) => result?.has(path));
}

describe("isOutsidePackageFilesAllowlist", () => {
  test("treats nested files covered by package.json glob entries as declared", () => {
    const packageJson = {
      files: ["**/*.js", "**/*.cjs", "**/*.d.ts", "**/*.d.cts", "**/*.map"],
    };

    expect(
      isOutsidePackageFilesAllowlist("__cjs/link/http/createSignalIfSupported.d.cts", packageJson),
    ).toBe(false);
    expect(
      isOutsidePackageFilesAllowlist("link/http/createSignalIfSupported.js", packageJson),
    ).toBe(false);
  });

  test("treats root-level files covered by package.json glob entries as declared", () => {
    const packageJson = { files: ["**/*.js", "**/*.md"] };

    expect(isOutsidePackageFilesAllowlist("version.js", packageJson)).toBe(false);
    expect(isOutsidePackageFilesAllowlist("CHANGELOG.md", packageJson)).toBe(false);
  });

  test("still flags files that are not covered by package.json entries", () => {
    const packageJson = { files: ["dist", "**/*.d.ts"] };

    expect(isOutsidePackageFilesAllowlist("router_init.js", packageJson)).toBe(true);
  });
});

describe("compilePackageFilesAllowlist follows npm-packlist", () => {
  test("a leading slash only anchors an entry to the package root", () => {
    expect(
      outside(
        ["/dist", "/assets", "/dist-raw/NODE-LICENSE.md"],
        ["dist/chunk-6IOGQ2V3.js", "assets/cjs_shims.js", "dist-raw/NODE-LICENSE.md", "router.js"],
      ),
    ).toEqual(["router.js"]);
  });

  test("a negated directory entry drops the directory's contents", () => {
    expect(
      outside(["/dist/", "!/dist/test"], ["dist/index.js", "dist/test/hook.js", "dist/testing.js"]),
    ).toEqual(["dist/test/hook.js"]);
  });

  test("a trailing /* widens to /** while other globs do not pull in a matched directory", () => {
    expect(outside(["bin/*"], ["bin/cli.js", "bin/utils/constants.js"])).toEqual([]);
    expect(outside(["dist*"], ["dist-raw.js", "dist-raw/payload.js"])).toEqual([
      "dist-raw/payload.js",
    ]);
  });

  test("** inside a segment is a single-segment star", () => {
    expect(
      outside(["/dist-raw/**.js"], ["dist-raw/node-options.js", "dist-raw/nested/payload.js"]),
    ).toEqual(["dist-raw/nested/payload.js"]);
  });

  test("brace sets, character classes and !(…) extglobs match like minimatch", () => {
    expect(
      outside(
        ["/index.{d.ts.map,d.ts,js}", "src/**/*.[ch]pp", "dist/cjs/**/!(*.tsbuildinfo)"],
        [
          "index.js",
          "index.d.ts",
          "src/util/binder.cpp",
          "src/util/binder.hpp",
          "src/util/binder.js",
          "dist/cjs/internal/Action.js",
          "dist/cjs/tsconfig.tsbuildinfo",
        ],
      ),
    ).toEqual(["src/util/binder.js", "dist/cjs/tsconfig.tsbuildinfo"]);
  });

  test("later negations win, and a slashless negation applies at every depth", () => {
    expect(
      outside(
        ["lib", "!lib/**/*.map", "src", "!__tests__"],
        ["lib/a.js", "lib/a.js.map", "src/index.js", "src/__tests__/index.test.js"],
      ),
    ).toEqual(["lib/a.js.map", "src/__tests__/index.test.js"]);
  });

  test("a slashless include reaches into walked directories only", () => {
    expect(
      outside(["lib/**/*.js", "*.json"], ["lib/a/data.json", "evil/payload.json", "x.json"]),
    ).toEqual(["evil/payload.json"]);
  });

  test("a literal file entry survives a later negation, as npm makes it a strict rule", () => {
    expect(
      outside(["browser.d.ts", "index.mjs", "!*.d.ts"], ["browser.d.ts", "other.d.ts"]),
    ).toEqual(["other.d.ts"]);
  });

  test("always-packed files are exempt, and only where npm packs them", () => {
    expect(
      outside(
        ["dist"],
        [
          "package.json",
          "README.md",
          "README",
          "LICENSE",
          "CHANGELOG.md",
          "History.md",
          "dist/README.md",
          "dist/sub/package.json",
          "cli.js",
          "bin.mjs",
          "browser.js",
          "evil/README.md",
          "docs/CHANGELOG.md",
          "notice.js",
          "CHANGELOG",
        ],
        { bin: { cli: "./cli.js", other: "bin.mjs" }, browser: "./browser.js" },
      ),
    ).toEqual(["evil/README.md", "docs/CHANGELOG.md", "notice.js", "CHANGELOG"]);
  });

  test("README, LICENSE and package.json are always packed at the root only", () => {
    expect(
      outside(
        ["dist/*.js"],
        [
          "dist/index.js",
          "dist/README.cjs",
          "dist/README",
          "dist/LICENSE",
          "dist/package.json",
          "README.cjs",
        ],
      ),
    ).toEqual(["dist/README.cjs", "dist/README", "dist/LICENSE", "dist/package.json"]);
  });

  test("only declared bundled dependencies and what they depend on are exempt", () => {
    const paths = [
      "node_modules/spdx-expression-parse/AUTHORS",
      "node_modules/spdx-exceptions/index.json",
      "node_modules/@scope/nested/index.js",
      "node_modules/undeclared/index.js",
      "node_modules/spdx-expression-parse",
      "lib/node_modules/x/index.js",
    ];
    const manifests = {
      "node_modules/spdx-expression-parse/package.json": {
        dependencies: { "spdx-exceptions": "^2.1.0" },
        optionalDependencies: { "@scope/nested": "1.0.0" },
      },
    };
    expect(
      outside(["lib/"], paths, { bundleDependencies: ["spdx-expression-parse"] }, manifests),
    ).toEqual(["node_modules/undeclared/index.js", "node_modules/spdx-expression-parse"]);
    expect(
      outside(["lib/"], ["node_modules/a/index.js", "node_modules/b/index.js"], {
        bundleDependencies: true,
        dependencies: { a: "1.0.0" },
      }),
    ).toEqual(["node_modules/b/index.js"]);
    expect(outside(["dist"], paths)).toEqual(paths);
  });

  test("matching is case-insensitive like npm-packlist's nocase", () => {
    expect(outside(["Dist"], ["dist/index.js", "DIST/other.js"])).toEqual([]);
  });

  test("pathological patterns stay linear", () => {
    const started = Date.now();
    const files = [`${"*a".repeat(40)}b`, `{${"x,".repeat(200)}y}`, "**/**/**/**/**/**/z"];
    const allowlist = compilePackageFilesAllowlist({ files });
    allowlist?.outsidePaths([`${"a".repeat(5_000)}/${"a/".repeat(200)}c`]);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("a manifest whose patterns exhaust the matching budget falls back to its literal entries", () => {
    const paths = Array.from(
      { length: 2_500 },
      (_, index) => `${"a".repeat(40)}/${"a".repeat(40)}/${"a".repeat(30)}${index}.js`,
    );
    for (const files of [
      Array.from({ length: 1_000 }, () => "**/**/**/*a*a*a*a*b"),
      [`${"**/".repeat(300)}*a*a*b`],
    ]) {
      const started = Date.now();
      const result = compilePackageFilesAllowlist({ files })?.outsidePaths(paths);
      expect(Date.now() - started).toBeLessThan(3_000);
      expect(result?.size).toBe(paths.length);
    }
  });

  test("a budget-exhausting manifest still reports a file outside its literal entries", () => {
    const files = [...Array.from({ length: 60 }, () => `*${"a".repeat(100)}b`), "dist"];
    const dist = Array.from({ length: 40 }, (_, index) => `dist/${"a".repeat(200)}${index}.js`);
    const started = Date.now();
    expect(outside(files, [...dist, "lib/hidden.js", "package.json", "README.md"])).toEqual([
      "lib/hidden.js",
    ]);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  test("a manifest past the entry or length cap falls back to its literal entries", () => {
    const many = [...Array.from({ length: 1_000 }, (_, index) => `dir${index}/*.js`), "lib"];
    expect(outside(many, ["dir1/a.js", "lib/a.js", "src/a.js"])).toEqual(["dir1/a.js", "src/a.js"]);
    const long = [`*${"a".repeat(1_100)}`, "lib"];
    expect(outside(long, ["lib/a.js", "src/a.js"])).toEqual(["src/a.js"]);
  });

  test("a manifest whose expanded patterns pass the compile cap falls back to its literal entries", () => {
    // 999 hostile entries plus `lib` stays inside the entry cap, so only the
    // compile cap can stop these from compiling.
    const braces = `{${Array.from({ length: 64 }, (_, index) => `b${index}`).join(",")}}`;
    const entry = (index: number) => `${"a".repeat(700)}${index}${braces}`;
    const matched = `${"a".repeat(700)}0b63`;
    expect(outside([entry(0), entry(1), "lib"], [matched, "lib/a.js"])).toEqual([]);
    const hostile = [...Array.from({ length: 999 }, (_, index) => entry(index)), "lib"];
    expect(outside(hostile, [matched, "lib/a.js"])).toEqual([matched]);

    const negated = (alternatives: number) =>
      `{${Array.from({ length: 64 }, (_, index) => index).join(",")}}${"p".repeat(100)}!(${Array.from({ length: alternatives }, (_, index) => `n${index}`).join("|")})`;
    const negatedMatch = `0${"p".repeat(100)}x.js`;
    expect(outside([negated(10), "lib"], [negatedMatch, "lib/a.js"])).toEqual([]);
    expect(outside([negated(150), "lib"], [negatedMatch, "lib/a.js"])).toEqual([negatedMatch]);
  });

  test("empty alternatives still count against the compile cap", () => {
    // Each `!(||…)` alternative is empty, so a length-only charge costs nothing
    // while every one still compiles a pattern.
    const empties = `/{${",".repeat(63)}}!(${"|".repeat(955)})`;
    const files = [...Array.from({ length: 999 }, () => empties), "lib"];
    expect(outside(files, ["x.js", "lib/a.js"])).toEqual(["x.js"]);
  });

  test("character classes cost the matcher every range they test", () => {
    const paths = [
      "lib/a.js",
      ...Array.from({ length: 2_500 }, (_, i) => `${i}${"a".repeat(505)}`),
    ];
    for (const files of [
      [...Array.from({ length: 8 }, () => `*[${"b-c".repeat(339)}]`), "lib"],
      [...Array.from({ length: 2 }, () => `*[${"~".repeat(1_018)}]`), "lib"],
    ]) {
      const started = performance.now();
      expect(outside(files, paths)).toHaveLength(2_500);
      expect(performance.now() - started).toBeLessThan(3_000);
    }
  });

  test("unclosed character classes are charged for rescanning their segment", () => {
    const files = [...Array.from({ length: 236 }, (_, i) => `${"[".repeat(1_020)}${i}`), "lib"];
    const started = performance.now();
    expect(outside(files, ["lib/a.js", "x.js"])).toEqual(["x.js"]);
    expect(performance.now() - started).toBeLessThan(500);
  });

  test("the literal fallback still applies `!` entries", () => {
    const filler = Array.from({ length: 1_000 }, (_, index) => `d${index}/*.js`);
    expect(
      outside(
        ["lib", "!lib/evil.js", "!__tests__", ...filler],
        ["lib/evil.js", "lib/ok.js", "lib/__tests__/a.test.js"],
      ),
    ).toEqual(["lib/evil.js", "lib/__tests__/a.test.js"]);
    // A glob negation could carve anything out of a literal directory, so only
    // literal file entries stay covered.
    expect(
      outside(["lib", "index.js", "!lib/*.map", ...filler], ["lib/a.js", "index.js", "lib/a.map"]),
    ).toEqual(["lib/a.js", "lib/a.map"]);
    for (const negation of ["!", "!./", "!.", "!lib//evil.js", "!lib/evil\\.js"]) {
      expect(outside(["lib", negation, ...filler], ["lib/evil.js"]), negation).toEqual([
        "lib/evil.js",
      ]);
    }
    expect(outside(["src\\lib", ...filler], ["src/lib/a.js"])).toEqual(["src/lib/a.js"]);
  });

  test("the literal fallback stays linear in the archive's paths", () => {
    const files = [...Array.from({ length: 100_000 }, (_, index) => `missing-${index}/x`), "lib"];
    const paths = [...Array.from({ length: 20_000 }, (_, index) => `src/f${index}.js`), "lib/a.js"];
    const started = performance.now();
    const result = outside(files, [...paths, "lib", "libx/a.js"]);
    expect(performance.now() - started).toBeLessThan(3_000);
    expect(result).toHaveLength(20_001);
    expect(result).not.toContain("lib/a.js");
    expect(result).toContain("libx/a.js");
  });
});
