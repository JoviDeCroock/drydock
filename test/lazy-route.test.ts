import { describe, expect, test } from "vitest";
import { surfaceLoadFailure } from "../src/features/error-report/lazy-route";

describe("surfaceLoadFailure", () => {
  test("resolves a failed chunk load to a component that rethrows the load error", async () => {
    const failure = new TypeError("Failed to fetch dynamically imported module");
    const loaded = await surfaceLoadFailure<() => null>(() => Promise.reject(failure))();

    expect(() => loaded.default()).toThrow(failure);
  });

  test("passes a successful load through unchanged", async () => {
    const Page = () => null;
    const loaded = await surfaceLoadFailure(() => Promise.resolve({ default: Page }))();

    expect(loaded.default).toBe(Page);
  });
});
