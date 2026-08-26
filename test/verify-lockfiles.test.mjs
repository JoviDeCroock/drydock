import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  diffPackageVersions,
  parsePackageLock,
  parsePnpmLock,
} from "../packages/verify/src/index.mjs";

const fixture = (name) =>
  readFileSync(new URL(`fixtures/verify-lockfiles/${name}`, import.meta.url), "utf8");

describe("drydock verify lockfile parsing", () => {
  test("extracts unambiguous dependency pairs from package-lock v3", () => {
    const before = parsePackageLock(fixture("package-lock.before.json"));
    const after = parsePackageLock(fixture("package-lock.after.json"));

    expect(diffPackageVersions(before, after)).toEqual([
      { ecosystem: "npm", name: "@scope/tool", from: "2.0.0", to: "2.1.0" },
      { ecosystem: "npm", name: "shared", from: "2.0.0", to: "3.0.0" },
    ]);
  });

  test("reads the nested dependency tree from package-lock v1", () => {
    const versions = parsePackageLock(
      JSON.stringify({
        lockfileVersion: 1,
        dependencies: {
          parent: {
            version: "1.0.0",
            dependencies: { child: { version: "2.0.0" } },
          },
        },
      }),
    );
    expect(versions).toEqual(
      new Map([
        ["parent", new Set(["1.0.0"])],
        ["child", new Set(["2.0.0"])],
      ]),
    );
  });

  test("extracts package locators without mistaking snapshots or peer suffixes for versions", () => {
    const before = parsePnpmLock(fixture("pnpm-lock.before.yaml"));
    const after = parsePnpmLock(fixture("pnpm-lock.after.yaml"));

    expect(diffPackageVersions(before, after)).toEqual([
      { ecosystem: "npm", name: "@scope/tool", from: "2.0.0", to: "2.1.0" },
      { ecosystem: "npm", name: "react-dom", from: "19.1.0", to: "19.2.0" },
    ]);
  });

  test("reads legacy pnpm slash locators", () => {
    const versions = parsePnpmLock("packages:\n  /left-pad/1.3.0:\n  /@scope/tool/2.0.0:\n");
    expect(versions).toEqual(
      new Map([
        ["left-pad", new Set(["1.3.0"])],
        ["@scope/tool", new Set(["2.0.0"])],
      ]),
    );
  });

  test("omits an ambiguous many-to-one version change", () => {
    const before = new Map([["shared", new Set(["1.0.0", "2.0.0"])]]);
    const after = new Map([["shared", new Set(["3.0.0"])]]);
    expect(diffPackageVersions(before, after)).toEqual([]);
  });

  test("omits an ambiguous many-to-many version change", () => {
    const before = new Map([["shared", new Set(["1.0.0", "2.0.0"])]]);
    const after = new Map([["shared", new Set(["3.0.0", "4.0.0"])]]);
    expect(diffPackageVersions(before, after)).toEqual([]);
  });
});
