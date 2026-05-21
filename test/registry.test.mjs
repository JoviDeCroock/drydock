import { describe, expect, test } from "vitest";
import { isValidNpmPackageName } from "../server/lib/registry.ts";

describe("npm package name validation", () => {
  test("accepts well-formed unscoped and scoped names", () => {
    expect(isValidNpmPackageName("acme")).toBe(true);
    expect(isValidNpmPackageName("acme-tool")).toBe(true);
    expect(isValidNpmPackageName("@acme/tool")).toBe(true);
    expect(isValidNpmPackageName("@acme-co/some_pkg.name")).toBe(true);
  });

  test("rejects names with traversal, slashes, or shell metacharacters", () => {
    expect(isValidNpmPackageName("..")).toBe(false);
    expect(isValidNpmPackageName("../foo")).toBe(false);
    expect(isValidNpmPackageName("foo/bar")).toBe(false);
    expect(isValidNpmPackageName("foo bar")).toBe(false);
    expect(isValidNpmPackageName("foo?bar")).toBe(false);
    expect(isValidNpmPackageName("FOO")).toBe(false);
    expect(isValidNpmPackageName("")).toBe(false);
    expect(isValidNpmPackageName("a".repeat(215))).toBe(false);
  });
});
