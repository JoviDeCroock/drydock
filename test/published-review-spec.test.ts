import { describe, expect, test } from "vitest";
import { parsePackageSpec } from "../src/models/published-review";

describe("published review package spec", () => {
  test("reads a bare name as the latest published version", () => {
    expect(parsePackageSpec("react")).toEqual({ packageName: "react", version: null });
    expect(parsePackageSpec("  react  ")).toEqual({ packageName: "react", version: null });
  });

  test("splits a version off an unscoped name", () => {
    expect(parsePackageSpec("react@19.0.0")).toEqual({
      packageName: "react",
      version: "19.0.0",
    });
  });

  test("keeps a scope attached to the name", () => {
    expect(parsePackageSpec("@scope/pkg")).toEqual({ packageName: "@scope/pkg", version: null });
    expect(parsePackageSpec("@scope/pkg@1.2.3")).toEqual({
      packageName: "@scope/pkg",
      version: "1.2.3",
    });
  });

  test("treats a dangling separator as no version rather than an empty one", () => {
    expect(parsePackageSpec("react@")).toEqual({ packageName: "react", version: null });
  });

  test("rejects input with no package name", () => {
    expect(parsePackageSpec("")).toBeNull();
    expect(parsePackageSpec("   ")).toBeNull();
    expect(parsePackageSpec("@")).toEqual({ packageName: "@", version: null });
  });
});
