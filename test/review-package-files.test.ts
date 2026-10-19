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

  test("a manifest whose patterns exhaust the matching budget is not evaluated", () => {
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
      if (result) expect(result.size).toBe(paths.length);
    }
  });

  test("a manifest past the entry cap is not evaluated", () => {
    const files = Array.from({ length: 1_001 }, (_, index) => `dir${index}`);
    expect(compilePackageFilesAllowlist({ files })).toBeNull();
  });
});
