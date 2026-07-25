import { describe, expect, test } from "vitest";
import {
  buildNpmReleaseManifest,
  NPM_RELEASE_MANIFEST_SCHEMA,
  parseNpmReleaseManifest,
} from "../server/lib/adapters/npm/manifest";

const SHA = "a".repeat(64);

describe("npm release manifest", () => {
  test("builds + round-trips a valid manifest", () => {
    const manifest = buildNpmReleaseManifest("@scope/pkg", "1.2.3", [
      { path: "dist/scope-pkg-1.2.3.tgz", sha256: SHA },
    ]);
    expect(manifest).toEqual({
      schema: NPM_RELEASE_MANIFEST_SCHEMA,
      ecosystem: "npm",
      package: "@scope/pkg",
      version: "1.2.3",
      artifacts: [{ path: "dist/scope-pkg-1.2.3.tgz", sha256: SHA }],
    });
    expect(parseNpmReleaseManifest(manifest)).toEqual(manifest);
  });

  test("lowercases the declared sha256", () => {
    const manifest = buildNpmReleaseManifest("pkg", "1.0.0", [
      { path: "pkg.tgz", sha256: SHA.toUpperCase() },
    ]);
    expect(manifest.artifacts[0].sha256).toBe(SHA);
  });

  test("accepts a semver prerelease + build version", () => {
    expect(() =>
      buildNpmReleaseManifest("pkg", "2.0.0-beta.1+build.5", [{ path: "pkg.tgz", sha256: SHA }]),
    ).not.toThrow();
  });

  test("rejects a non-npm ecosystem", () => {
    expect(() =>
      parseNpmReleaseManifest({
        schema: NPM_RELEASE_MANIFEST_SCHEMA,
        ecosystem: "pypi",
        package: "pkg",
        version: "1.0.0",
        artifacts: [{ path: "pkg.tgz", sha256: SHA }],
      }),
    ).toThrow(/ecosystem must be npm/);
  });

  test("accepts a legacy uppercase package name", () => {
    // npm enforces lowercase only for new names; legacy packages like JSONStream
    // still publish, so the gate must not reject them at manifest synthesis.
    expect(() =>
      buildNpmReleaseManifest("JSONStream", "1.0.0", [{ path: "p.tgz", sha256: SHA }]),
    ).not.toThrow();
    expect(() =>
      buildNpmReleaseManifest("@MyScope/Pkg", "1.0.0", [{ path: "p.tgz", sha256: SHA }]),
    ).not.toThrow();
  });

  test("rejects an invalid package name", () => {
    expect(() =>
      buildNpmReleaseManifest("Invalid Name", "1.0.0", [{ path: "p.tgz", sha256: SHA }]),
    ).toThrow(/valid npm package name/);
    // A name that smuggles a path separator or control character must still fail.
    expect(() =>
      buildNpmReleaseManifest("../evil", "1.0.0", [{ path: "p.tgz", sha256: SHA }]),
    ).toThrow(/valid npm package name/);
  });

  test("rejects an unsafe version string", () => {
    expect(() =>
      buildNpmReleaseManifest("pkg", "../../etc", [{ path: "p.tgz", sha256: SHA }]),
    ).toThrow(/safe npm version/);
  });

  test("rejects a non-hex sha256", () => {
    expect(() =>
      buildNpmReleaseManifest("pkg", "1.0.0", [{ path: "p.tgz", sha256: "nope" }]),
    ).toThrow(/sha256/);
  });

  test("rejects a path-traversing artifact path", () => {
    expect(() =>
      buildNpmReleaseManifest("pkg", "1.0.0", [{ path: "../escape.tgz", sha256: SHA }]),
    ).toThrow(/path is not safe/);
  });

  test("rejects an empty artifact list", () => {
    expect(() => buildNpmReleaseManifest("pkg", "1.0.0", [])).toThrow(/at least one artifact/);
  });
});
