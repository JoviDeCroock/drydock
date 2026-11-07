import { describe, expect, test } from "vitest";
import { isRouteLoadFailure, surfaceLoadFailure } from "../src/features/error-report/lazy-route";

describe("surfaceLoadFailure", () => {
  test("resolves a failed chunk load to a component that rethrows the load error", async () => {
    const failure = new TypeError("Failed to fetch dynamically imported module");
    const loaded = await surfaceLoadFailure<() => null>(() => Promise.reject(failure))();

    expect(() => loaded.default()).toThrow(failure);
    expect(isRouteLoadFailure(failure)).toBe(true);
  });

  test("does not mark an error a page throws while rendering as a load failure", () => {
    expect(isRouteLoadFailure(new Error("render failed"))).toBe(false);
    expect(isRouteLoadFailure("not an error")).toBe(false);
  });

  test("passes a successful load through unchanged", async () => {
    const Page = () => null;
    const loaded = await surfaceLoadFailure(() => Promise.resolve({ default: Page }))();

    expect(loaded.default).toBe(Page);
  });
});
