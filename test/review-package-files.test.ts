import { describe, expect, test } from "vitest";
import { isOutsidePackageFilesAllowlist } from "../server/lib/review/package-files";

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
