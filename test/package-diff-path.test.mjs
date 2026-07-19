import { describe, expect, test } from "vitest";
import {
  dependencyDiffHref,
  packageDiffPath,
  packageOnlyDiffPath,
  parseDiffPackage,
  parseDiffSpec,
} from "../src/lib/package-diff-path";

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

describe("parseDiffPackage", () => {
  test("round-trips unscoped and scoped package-only paths", () => {
    expect(parseDiffPackage(packageOnlyDiffPath("react"))).toBe("react");
    expect(parseDiffPackage(packageOnlyDiffPath("@preact/signals"))).toBe("@preact/signals");
  });

  test("returns null for the landing form, full specs, and other routes", () => {
    expect(parseDiffPackage("/diff")).toBeNull();
    expect(parseDiffPackage("/diff/")).toBeNull();
    expect(parseDiffPackage("/diff/react/1.0.0/1.0.1")).toBeNull();
    expect(parseDiffPackage("/diff/@scope/pkg/1.0.0/1.1.0")).toBeNull();
    expect(parseDiffPackage("/diff/react/1.0.0")).toBeNull();
    expect(parseDiffPackage("/dashboard")).toBeNull();
  });
});

describe("dependencyDiffHref", () => {
  test("links a bump straight to the floor-to-floor version pair", () => {
    expect(
      dependencyDiffHref({
        key: "event-pubsub",
        status: "modified",
        previous: "4.3.0",
        staged: "5.0.0",
      }),
    ).toBe("/diff/event-pubsub/4.3.0/5.0.0");
    expect(
      dependencyDiffHref({ key: "left-pad", status: "modified", previous: "^1.2", staged: "~2" }),
    ).toBe("/diff/left-pad/1.2.0/2.0.0");
    expect(
      dependencyDiffHref({
        key: "@scope/dep",
        status: "modified",
        previous: ">=1.0.0 <2",
        staged: "2.0.0-beta.1",
      }),
    ).toBe("/diff/@scope/dep/1.0.0/2.0.0-beta.1");
  });

  test("links an added dependency to the package-only form", () => {
    expect(dependencyDiffHref({ key: "peacenotwar", status: "added", staged: "^9.1.3" })).toBe(
      "/diff/peacenotwar",
    );
  });

  test("falls back to the package-only form when specs have no version anchor", () => {
    for (const row of [
      { key: "dep", status: "modified", previous: "latest", staged: "next" },
      { key: "dep", status: "modified", previous: "*", staged: "2.0.0" },
      { key: "dep", status: "modified", previous: "1.0.0", staged: "github:someone/dep#main" },
      // Equal floors (a range widened from caret to tilde) leave no concrete
      // pair to link, so the package-only form is the safe target.
      { key: "dep", status: "modified", previous: "^1.0.0", staged: "~1.0.0" },
    ]) {
      expect(dependencyDiffHref(row)).toBe("/diff/dep");
    }
  });

  test("removed dependencies get no link", () => {
    expect(dependencyDiffHref({ key: "gone", status: "removed", previous: "^1.0.0" })).toBeNull();
  });
});
