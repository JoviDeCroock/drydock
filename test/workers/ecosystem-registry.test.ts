import { describe, expect, test } from "vitest";
import {
  ECOSYSTEMS,
  getEcosystem,
  getPublicDiffAdapter,
  getStagedAdapter,
  getWorkflowGateAdapter,
  isEcosystemId,
  supportedPublicDiffEcosystems,
  supportedStagedEcosystems,
  supportedWorkflowGateEcosystems,
  UnsupportedEcosystemError,
} from "../../server/lib/ecosystems";
import { publicDiffVersionCacheControl } from "../../server/routes/public-diff";

// The registry is the single answer to "how can a release of this kind reach
// Drydock?". These assertions pin the capability matrix so adding or removing a
// capability is a deliberate, visible change rather than a silent one.
describe("ecosystem capability registry", () => {
  test("declares the expected capability matrix", () => {
    const matrix = Object.fromEntries(
      ECOSYSTEMS.map((eco) => [
        eco.id,
        {
          staged: Boolean(eco.staged),
          gate: Boolean(eco.gate),
          publicDiff: Boolean(eco.publicDiff),
        },
      ]),
    );
    expect(matrix).toEqual({
      npm: { staged: true, gate: true, publicDiff: true },
      // PyPI cannot stage a candidate in the registry; releases arrive by gate.
      pypi: { staged: false, gate: true, publicDiff: true },
      // VS Code is gate-only: no Marketplace staging, not on /diff.
      vscode: { staged: false, gate: true, publicDiff: false },
      // atpm is public-diff-only: releases live in the publisher's own AT
      // Protocol repository, which Drydock reads but cannot stage or gate.
      atpm: { staged: false, gate: false, publicDiff: true },
    });
  });

  test("every module's id matches its key and its adapters agree on ecosystem", () => {
    for (const eco of ECOSYSTEMS) {
      expect(getEcosystem(eco.id)).toBe(eco);
      expect(isEcosystemId(eco.id)).toBe(true);
      if (eco.gate) expect(eco.gate.ecosystem).toBe(eco.id);
      if (eco.publicDiff) expect(eco.publicDiff.ecosystem).toBe(eco.id);
      if (eco.staged) expect(eco.staged.id).toBe(eco.id);
    }
  });

  test("capability listings match the declared modules", () => {
    expect(supportedWorkflowGateEcosystems().sort()).toEqual(["npm", "pypi", "vscode"]);
    expect(supportedPublicDiffEcosystems().sort()).toEqual(["atpm", "npm", "pypi"]);
    expect(supportedStagedEcosystems()).toEqual(["npm"]);
  });

  test("resolvers return the adapter a module declares", () => {
    expect(getWorkflowGateAdapter("vscode")).toBe(getEcosystem("vscode")?.gate);
    expect(getPublicDiffAdapter("pypi")).toBe(getEcosystem("pypi")?.publicDiff);
    expect(getStagedAdapter("npm")).toBe(getEcosystem("npm")?.staged);
  });

  test("bounds atpm computed pairs to its mutable resolution lifetime", () => {
    const adapter = getPublicDiffAdapter("atpm");
    expect(adapter?.payloadVersion).toBe("v3");
    expect(adapter?.rulesVersionSegment).toContain("identity-2");
    expect(adapter?.cacheTtlSeconds).toBe(5 * 60);
    expect(publicDiffVersionCacheControl(adapter!)).toBe("public, max-age=300");
    expect(publicDiffVersionCacheControl(getPublicDiffAdapter("npm")!)).toBe(
      "public, max-age=300, stale-while-revalidate=600",
    );
  });

  test("a missing capability fails closed rather than falling back", () => {
    // PyPI has no staged adapter; asking for one must throw, not silently
    // resolve to another ecosystem's reviewer.
    expect(() => getStagedAdapter("pypi")).toThrow(UnsupportedEcosystemError);
    expect(getPublicDiffAdapter("vscode")).toBeUndefined();
    expect(() => getWorkflowGateAdapter("cargo")).toThrow(UnsupportedEcosystemError);
  });

  test("unknown ecosystem ids are rejected", () => {
    expect(getEcosystem("cargo")).toBeUndefined();
    expect(isEcosystemId("cargo")).toBe(false);
  });
});
