import { describe, expect, test } from "vitest";
import { buildNpmStagedPackagesUrl, npmStagedPackagesUrlFor } from "../src/lib/npm-staged-url";

describe("npm staged packages urls", () => {
  test("builds the npm web page with a package filter", () => {
    expect(buildNpmStagedPackagesUrl("left-pad")).toBe(
      "https://www.npmjs.com/settings/~/staged-packages/?page=0&perPage=10&filterPackage=left-pad",
    );
  });

  test("encodes scoped package names before placing them in query params", () => {
    expect(buildNpmStagedPackagesUrl(" @pracht/experiments ")).toBe(
      "https://www.npmjs.com/settings/~/staged-packages/?page=0&perPage=10&filterPackage=%40pracht%2Fexperiments",
    );
  });

  test("omits redirects when package name is unavailable", () => {
    expect(buildNpmStagedPackagesUrl(null)).toBeNull();
    expect(buildNpmStagedPackagesUrl(" ")).toBeNull();
  });

  test("only links non-workflow-gate npm staged scans", () => {
    expect(npmStagedPackagesUrlFor({ source: "manual", packageName: "left-pad" })).toBe(
      "https://www.npmjs.com/settings/~/staged-packages/?page=0&perPage=10&filterPackage=left-pad",
    );

    expect(
      npmStagedPackagesUrlFor({ source: "workflow_gate", packageName: "left-pad" }),
    ).toBeNull();
  });
});
