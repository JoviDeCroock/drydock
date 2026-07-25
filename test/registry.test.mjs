import { describe, expect, test } from "vitest";
import {
  compareSemver,
  isValidNpmPackageName,
  pickBaselineVersion,
  pickPreviousVersion,
} from "../server/lib/ecosystems/npm/registry";

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

describe("registry baseline selection", () => {
  test("prefers the staged dist-tag target when it is published", () => {
    const metadata = {
      versions: {
        "1.4.0": {},
        "2.0.0-beta.2": {},
      },
      "dist-tags": {
        latest: "1.4.0",
        beta: "2.0.0-beta.2",
      },
    };

    expect(pickBaselineVersion(metadata, "2.0.0-beta.3", "beta")).toMatchObject({
      version: "2.0.0-beta.2",
      tag: "beta",
      source: "dist-tag",
      distTagVersion: "2.0.0-beta.2",
    });
  });

  test("falls back to the semver predecessor instead of a newer published channel", () => {
    const metadata = {
      versions: {
        "1.0.0": {},
        "1.1.0": {},
        "2.0.0": {},
      },
      "dist-tags": {
        latest: "2.0.0",
      },
    };

    expect(pickBaselineVersion(metadata, "1.2.0", "maintenance")).toMatchObject({
      version: "1.1.0",
      source: "semver-predecessor",
      distTagVersion: null,
    });
  });

  test("falls back when the staged tag points at the staged version", () => {
    const metadata = {
      versions: {
        "1.0.0": {},
        "1.1.0": {},
      },
      "dist-tags": {
        latest: "1.1.0",
      },
    };

    expect(pickBaselineVersion(metadata, "1.1.0", "latest")).toMatchObject({
      version: "1.0.0",
      tag: "latest",
      source: "semver-predecessor",
      distTagVersion: "1.1.0",
    });
  });

  test("keeps the legacy helper as an untagged predecessor picker", () => {
    expect(
      pickPreviousVersion(
        {
          versions: {
            "1.0.0": {},
            "1.1.0-beta.2": {},
            "1.1.0-beta.10": {},
            "2.0.0": {},
          },
        },
        "1.1.0-beta.11",
      ),
    ).toBe("1.1.0-beta.10");
  });

  test("sorts semver prereleases before releases and numeric prerelease ids numerically", () => {
    expect(compareSemver("1.0.0-beta.10", "1.0.0-beta.2")).toBeGreaterThan(0);
    expect(compareSemver("1.0.0", "1.0.0-beta.10")).toBeGreaterThan(0);
  });
});
