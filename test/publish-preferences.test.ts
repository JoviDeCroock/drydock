import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const STORAGE_KEY = "drydock:open-npm-after-decision";

function stubLocalStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
  return store;
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe("openNpmAfterDecision", () => {
  test("defaults to off when nothing is stored", async () => {
    stubLocalStorage();

    const { openNpmAfterDecision } = await import("../src/models/publish-preferences");

    expect(openNpmAfterDecision.value).toBe(false);
  });

  test("starts on when the browser remembered the preference", async () => {
    stubLocalStorage({ [STORAGE_KEY]: "true" });

    const { openNpmAfterDecision } = await import("../src/models/publish-preferences");

    expect(openNpmAfterDecision.value).toBe(true);
  });

  test("persists opting in and clears the key on opting back out", async () => {
    const store = stubLocalStorage();

    const { openNpmAfterDecision, setOpenNpmAfterDecision } =
      await import("../src/models/publish-preferences");

    setOpenNpmAfterDecision(true);
    expect(openNpmAfterDecision.value).toBe(true);
    expect(store.get(STORAGE_KEY)).toBe("true");

    setOpenNpmAfterDecision(false);
    expect(openNpmAfterDecision.value).toBe(false);
    expect(store.has(STORAGE_KEY)).toBe(false);
  });

  test("falls back to an in-memory preference when localStorage is blocked", async () => {
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };

    const { openNpmAfterDecision, setOpenNpmAfterDecision } =
      await import("../src/models/publish-preferences");

    expect(openNpmAfterDecision.value).toBe(false);
    expect(() => setOpenNpmAfterDecision(true)).not.toThrow();
    expect(openNpmAfterDecision.value).toBe(true);
  });

  test("works without localStorage at all", async () => {
    delete (globalThis as { localStorage?: unknown }).localStorage;

    const { openNpmAfterDecision, setOpenNpmAfterDecision } =
      await import("../src/models/publish-preferences");

    expect(openNpmAfterDecision.value).toBe(false);
    expect(() => setOpenNpmAfterDecision(true)).not.toThrow();
    expect(openNpmAfterDecision.value).toBe(true);
  });
});
