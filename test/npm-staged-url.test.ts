import { describe, expect, test } from "vitest";
import { buildNpmStagedPackagesUrl, npmStagedPackagesUrlFor } from "../src/lib/npm-staged-url";

describe("npm staged packages urls", () => {
  test("builds the npm web page from the whoami username", () => {
    expect(buildNpmStagedPackagesUrl("jovi")).toBe(
      "https://www.npmjs.com/settings/jovi/staged-packages",
    );
  });

  test("encodes and trims usernames before placing them in the path", () => {
    expect(buildNpmStagedPackagesUrl(" scoped user ")).toBe(
      "https://www.npmjs.com/settings/scoped%20user/staged-packages",
    );
  });

  test("omits redirects when whoami is unavailable", () => {
    expect(buildNpmStagedPackagesUrl(null)).toBeNull();
    expect(buildNpmStagedPackagesUrl(" ")).toBeNull();
  });

  test("only links non-workflow-gate npm staged scans", () => {
    const connection = { capabilitiesJson: { whoami: "maintainer" } };
    expect(npmStagedPackagesUrlFor({ source: "manual", packageName: "left-pad" }, connection)).toBe(
      "https://www.npmjs.com/settings/maintainer/staged-packages",
    );

    expect(
      npmStagedPackagesUrlFor({ source: "workflow_gate", packageName: "left-pad" }, connection),
    ).toBeNull();
  });

  test("prefers scoped package owners and skips non-npmjs registries", () => {
    expect(
      npmStagedPackagesUrlFor(
        { source: "manual", packageName: "@drydock/example" },
        {
          registryUrl: "https://registry.npmjs.org",
          capabilitiesJson: { whoami: "maintainer" },
        },
      ),
    ).toBe("https://www.npmjs.com/settings/drydock/staged-packages");

    expect(
      npmStagedPackagesUrlFor(
        { source: "manual", packageName: "left-pad" },
        {
          registryUrl: "https://registry.example.com",
          capabilitiesJson: { whoami: "maintainer" },
        },
      ),
    ).toBeNull();
  });
});
