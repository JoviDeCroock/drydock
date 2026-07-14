import { describe, expect, test } from "vitest";
import { packageDiffPath, parseDiffSpec } from "../src/lib/package-diff-path";

describe("packageDiffPath", () => {
  test("builds an unscoped path", () => {
    expect(packageDiffPath("react", "18.2.0", "18.3.0")).toBe("/diff/react/18.2.0/18.3.0");
  });

  test("keeps the scope readable while encoding the segments", () => {
    expect(packageDiffPath("@preact/signals", "1.0.0", "1.1.0")).toBe(
      "/diff/@preact/signals/1.0.0/1.1.0",
    );
  });

  test("encodes version build metadata", () => {
    expect(packageDiffPath("pkg", "1.0.0+build.1", "1.0.1")).toBe(
      "/diff/pkg/1.0.0%2Bbuild.1/1.0.1",
    );
  });
});

describe("parseDiffSpec", () => {
  test("round-trips unscoped and scoped names", () => {
    for (const spec of [
      { packageName: "react", fromVersion: "18.2.0", toVersion: "18.3.0" },
      { packageName: "@preact/signals", fromVersion: "1.0.0", toVersion: "1.1.0" },
      { packageName: "pkg", fromVersion: "1.0.0+build.1", toVersion: "1.0.1" },
    ]) {
      expect(
        parseDiffSpec(packageDiffPath(spec.packageName, spec.fromVersion, spec.toVersion)),
      ).toEqual(spec);
    }
  });

  test("returns null for the landing form and partial specs", () => {
    expect(parseDiffSpec("/diff")).toBeNull();
    expect(parseDiffSpec("/diff/")).toBeNull();
    expect(parseDiffSpec("/diff/react")).toBeNull();
    expect(parseDiffSpec("/diff/react/1.0.0")).toBeNull();
    expect(parseDiffSpec("/diff/@scope/pkg/1.0.0")).toBeNull();
    expect(parseDiffSpec("/diff/react/1.0.0/1.0.1/extra")).toBeNull();
  });

  test("returns null for other routes", () => {
    expect(parseDiffSpec("/dashboard")).toBeNull();
    expect(parseDiffSpec("/diffx/react/1.0.0/1.0.1")).toBeNull();
  });
});
