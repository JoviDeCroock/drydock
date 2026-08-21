import { afterEach, describe, expect, test, vi } from "vitest";
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
import { ATPM_RECORD_CACHE_SCOPE } from "../../server/lib/ecosystems/atpm/public-diff";

// The registry is the single answer to "how can a release of this kind reach
// Drydock?". These assertions pin the capability matrix so adding or removing a
// capability is a deliberate, visible change rather than a silent one.
describe("ecosystem capability registry", () => {
  afterEach(() => vi.useRealTimers());
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
      // atpm is public-diff only, and that one surface covers both published
      // releases and staged candidates: both are public records in the
      // publisher's own repository. Drydock neither stages nor approves an
      // atpm release.
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
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-19T12:00:00.000Z"));
    const adapter = getPublicDiffAdapter("atpm");
    expect(adapter?.payloadVersion).toBe("v10");
    expect(adapter?.rulesVersionSegment).toContain("atpm-14+identity-3");
    // Provenance verification and the trusted-publisher record are part of the
    // trust boundary, so a change to either must invalidate cached pairs too.
    expect(adapter?.rulesVersionSegment).toContain("provenance-9+publisher-1");
    expect(ATPM_RECORD_CACHE_SCOPE).toBe("atpm-public-record-14-provenance-9-absolute-expiry-v1");
    expect(adapter?.cacheTtlSeconds).toBe(5 * 60);
    expect(publicDiffVersionCacheControl(adapter!)).toBe("public, max-age=300");
    expect(publicDiffVersionCacheControl(adapter!, "2026-08-19T12:02:00.000Z")).toBe(
      "public, max-age=120",
    );
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
