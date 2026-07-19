import { describe, expect, test } from "vitest";
import { packageDiffPath, parseDiffSpec } from "../src/lib/package-diff-path";

describe("packageDiffPath", () => {
  test("builds an unscoped npm path", () => {
    expect(packageDiffPath("npm", "react", "18.2.0", "18.3.0")).toBe("/diff/react/18.2.0/18.3.0");
  });

  test("keeps the scope readable while encoding the segments", () => {
    expect(packageDiffPath("npm", "@preact/signals", "1.0.0", "1.1.0")).toBe(
      "/diff/@preact/signals/1.0.0/1.1.0",
    );
  });

  test("encodes version build metadata", () => {
    expect(packageDiffPath("npm", "pkg", "1.0.0+build.1", "1.0.1")).toBe(
      "/diff/pkg/1.0.0%2Bbuild.1/1.0.1",
    );
  });

  test("prefixes PyPI paths and keeps PEP 440 epoch markers path-safe", () => {
    expect(packageDiffPath("pypi", "requests", "2.31.0", "2.32.0")).toBe(
      "/diff/pypi/requests/2.31.0/2.32.0",
    );
    // encodeURIComponent leaves "!" untouched; it is path-safe as-is.
    expect(packageDiffPath("pypi", "pkg", "1!1.0", "1!1.1")).toBe("/diff/pypi/pkg/1!1.0/1!1.1");
  });
});

describe("parseDiffSpec", () => {
  test("round-trips npm and PyPI specs", () => {
    for (const spec of [
      { ecosystem: "npm", packageName: "react", fromVersion: "18.2.0", toVersion: "18.3.0" },
      {
        ecosystem: "npm",
        packageName: "@preact/signals",
        fromVersion: "1.0.0",
        toVersion: "1.1.0",
      },
      { ecosystem: "npm", packageName: "pkg", fromVersion: "1.0.0+build.1", toVersion: "1.0.1" },
      { ecosystem: "pypi", packageName: "requests", fromVersion: "2.31.0", toVersion: "2.32.0" },
      { ecosystem: "pypi", packageName: "pkg", fromVersion: "1!1.0", toVersion: "1!1.1" },
    ]) {
      expect(
        parseDiffSpec(
          packageDiffPath(spec.ecosystem, spec.packageName, spec.fromVersion, spec.toVersion),
        ),
      ).toEqual(spec);
    }
  });

  test("an npm package literally named pypi keeps the un-prefixed form", () => {
    expect(parseDiffSpec("/diff/pypi/1.0.0/2.0.0")).toEqual({
      ecosystem: "npm",
      packageName: "pypi",
      fromVersion: "1.0.0",
      toVersion: "2.0.0",
    });
    expect(parseDiffSpec("/diff/pypi/pypi/1.0.0/2.0.0")).toEqual({
      ecosystem: "pypi",
      packageName: "pypi",
      fromVersion: "1.0.0",
      toVersion: "2.0.0",
    });
  });

  test("returns null for the landing form and partial specs", () => {
    expect(parseDiffSpec("/diff")).toBeNull();
    expect(parseDiffSpec("/diff/")).toBeNull();
    expect(parseDiffSpec("/diff/react")).toBeNull();
    expect(parseDiffSpec("/diff/react/1.0.0")).toBeNull();
    expect(parseDiffSpec("/diff/@scope/pkg/1.0.0")).toBeNull();
    expect(parseDiffSpec("/diff/react/1.0.0/1.0.1/extra")).toBeNull();
    expect(parseDiffSpec("/diff/pypi/requests/1.0.0/1.0.1/extra")).toBeNull();
  });

  test("returns null for other routes", () => {
    expect(parseDiffSpec("/dashboard")).toBeNull();
    expect(parseDiffSpec("/diffx/react/1.0.0/1.0.1")).toBeNull();
  });
});
