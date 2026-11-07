import { describe, expect, test } from "vitest";
import { npmManifestHasOnlyMetadataChanges } from "../server/lib/dependency-review/manifests";

describe("npm manifest metadata changes", () => {
  test("metadata, scripts, and package publication fields need no dependency review", () => {
    const before = JSON.stringify({
      name: "app",
      version: "1.0.0",
      description: "Before",
      scripts: { test: "vitest" },
      dependencies: { preact: "10.0.0" },
    });
    const after = JSON.stringify({
      name: "renamed-app",
      version: "1.1.0",
      description: "After",
      scripts: { test: "vitest run", build: "vite build" },
      dependencies: { preact: "10.0.0" },
      license: "MIT",
      repository: "https://example.test/app",
      files: ["dist"],
      exports: { ".": "./dist/index.js" },
      publishConfig: { access: "public" },
    });
    expect(npmManifestHasOnlyMetadataChanges(before, after)).toBe(true);
  });

  test("object key reordering preserves dependency declarations", () => {
    expect(
      npmManifestHasOnlyMetadataChanges(
        '{"dependencies":{"a":"1","b":"2"},"pnpm":{"overrides":{"a":"1","b":"2"}}}',
        '{"pnpm":{"overrides":{"b":"2","a":"1"}},"dependencies":{"b":"2","a":"1"}}',
      ),
    ).toBe(true);
  });

  test.each([
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
    "overrides",
    "resolutions",
    "pnpm",
    "peerDependenciesMeta",
    "bundledDependencies",
    "packageManager",
    "futureResolverOption",
  ])("changing, adding, or removing %s requires review", (field) => {
    const before = JSON.stringify({ [field]: { a: "1" } });
    const after = JSON.stringify({ [field]: { a: "2" } });
    expect(npmManifestHasOnlyMetadataChanges(before, after)).toBe(false);
    expect(npmManifestHasOnlyMetadataChanges("{}", after)).toBe(false);
    expect(npmManifestHasOnlyMetadataChanges(before, "{}")).toBe(false);
  });

  test("workspace membership and array ordering are preserved", () => {
    expect(
      npmManifestHasOnlyMetadataChanges(
        '{"workspaces":["packages/a","packages/b"]}',
        '{"workspaces":["packages/a","packages/c"]}',
      ),
    ).toBe(false);
    expect(
      npmManifestHasOnlyMetadataChanges(
        '{"workspaces":["packages/a","packages/b"]}',
        '{"workspaces":["packages/b","packages/a"]}',
      ),
    ).toBe(false);
  });

  test.each(["{", "null", "[]", '"app"', "1"])(
    "an invalid manifest %s cannot prove unchanged dependencies",
    (invalid) => {
      expect(npmManifestHasOnlyMetadataChanges(invalid, "{}")).toBe(false);
      expect(npmManifestHasOnlyMetadataChanges("{}", invalid)).toBe(false);
    },
  );

  test("excessively nested resolver configuration fails closed", () => {
    const deep = `{"futureResolverOption":${"[".repeat(20_000)}0${"]".repeat(20_000)}}`;
    expect(npmManifestHasOnlyMetadataChanges(deep, deep)).toBe(false);
  });
});
