import { beforeEach, describe, expect, test, vi } from "vitest";

// The narrowest layer for the /diff/<name> resolver: the fake-registry e2e
// cannot exercise the public diff endpoints (they are disabled for custom
// registries), so the resolve-and-route logic is covered here with the API
// layer stubbed out.
vi.mock("../src/models/api", () => ({
  apiFetch: vi.fn(),
  errorMessage: (err) => (err instanceof Error ? err.message : String(err)),
}));

import { apiFetch } from "../src/models/api";
import { getPublicDiffVersions, resolveSuggestedDiffPath } from "../src/models/package-diff";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveSuggestedDiffPath", () => {
  test("resolves the suggested pair to a full diff path", async () => {
    apiFetch.mockResolvedValueOnce({
      packageName: "@scope/dep",
      versions: [],
      suggested: { from: "1.0.0", to: "1.1.0" },
    });

    await expect(resolveSuggestedDiffPath("resolve-ok")).resolves.toEqual({
      path: "/diff/@scope/dep/1.0.0/1.1.0",
    });
  });

  test("reports when the package has no diffable pair", async () => {
    apiFetch.mockResolvedValueOnce({ packageName: "solo", versions: [], suggested: null });

    await expect(resolveSuggestedDiffPath("resolve-solo")).resolves.toEqual({
      error: "This package needs at least two published versions to diff.",
    });
  });

  test("surfaces fetch failures as the error branch", async () => {
    apiFetch.mockRejectedValueOnce(new Error("package not found"));

    await expect(resolveSuggestedDiffPath("resolve-missing")).resolves.toEqual({
      error: "package not found",
    });
  });
});

describe("getPublicDiffVersions cache", () => {
  test("serves the redirect target from cache instead of refetching", async () => {
    apiFetch.mockResolvedValue({ packageName: "cached", versions: [], suggested: null });

    await getPublicDiffVersions("cache-hit");
    await getPublicDiffVersions("cache-hit");

    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  test("evicts failed fetches so a retry hits the network", async () => {
    apiFetch
      .mockRejectedValueOnce(new Error("registry hiccup"))
      .mockResolvedValueOnce({ packageName: "flaky", versions: [], suggested: null });

    await expect(getPublicDiffVersions("cache-retry")).rejects.toThrow("registry hiccup");
    await expect(getPublicDiffVersions("cache-retry")).resolves.toMatchObject({
      packageName: "flaky",
    });
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });
});
