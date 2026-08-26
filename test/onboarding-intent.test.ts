import { afterEach, describe, expect, test, vi } from "vitest";
import {
  clearOnboardingIntent,
  readOnboardingIntent,
  rememberOnboardingIntent,
} from "../src/features/onboarding-intent";

const STORAGE_KEY = "drydock:onboarding-intent";

function stubLocalStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
  return store;
}

afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
  vi.useRealTimers();
});

describe("onboarding intent", () => {
  test("round-trips the package a reader came from", () => {
    const store = stubLocalStorage();

    rememberOnboardingIntent({ ecosystem: "npm", packageName: "left-pad" });

    expect(store.has(STORAGE_KEY)).toBe(true);
    const intent = readOnboardingIntent();
    expect(intent?.ecosystem).toBe("npm");
    expect(intent?.packageName).toBe("left-pad");
    expect(intent?.displayName).toBe(null);
    expect(typeof intent?.at).toBe("number");
  });

  test("keeps a readable spelling alongside the canonical name", () => {
    stubLocalStorage();

    rememberOnboardingIntent({
      ecosystem: "atpm",
      packageName: "@did:plc:abc123/counter",
      displayName: "@ebey.dev/counter",
    });

    expect(readOnboardingIntent()).toMatchObject({
      ecosystem: "atpm",
      packageName: "@did:plc:abc123/counter",
      displayName: "@ebey.dev/counter",
    });
  });

  test("reads as no intent when nothing was stored", () => {
    stubLocalStorage();

    expect(readOnboardingIntent()).toBe(null);
  });

  test("clearing removes the stored intent", () => {
    const store = stubLocalStorage();
    rememberOnboardingIntent({ ecosystem: "npm", packageName: "react" });

    clearOnboardingIntent();

    expect(store.has(STORAGE_KEY)).toBe(false);
    expect(readOnboardingIntent()).toBe(null);
  });

  test("drops a value that is not JSON", () => {
    const store = stubLocalStorage({ [STORAGE_KEY]: "{not json" });

    expect(readOnboardingIntent()).toBe(null);
    // The value is user-writable, so an unreadable one is discarded rather than
    // re-parsed on every dashboard load.
    expect(store.has(STORAGE_KEY)).toBe(false);
  });

  test.each([
    ["a JSON array", JSON.stringify([{ ecosystem: "npm", packageName: "react", at: Date.now() }])],
    ["a JSON scalar", JSON.stringify("react")],
    ["null", JSON.stringify(null)],
    ["an unknown ecosystem", JSON.stringify({ ecosystem: "cargo", packageName: "serde", at: 1 })],
    ["a missing package name", JSON.stringify({ ecosystem: "npm", at: Date.now() })],
    [
      "an empty package name",
      JSON.stringify({ ecosystem: "npm", packageName: "", at: Date.now() }),
    ],
    [
      "a non-string package name",
      JSON.stringify({ ecosystem: "npm", packageName: 42, at: Date.now() }),
    ],
    [
      "an absurdly long package name",
      JSON.stringify({ ecosystem: "npm", packageName: "x".repeat(257), at: Date.now() }),
    ],
    ["a missing timestamp", JSON.stringify({ ecosystem: "npm", packageName: "react" })],
    [
      "a non-numeric timestamp",
      JSON.stringify({ ecosystem: "npm", packageName: "react", at: "yesterday" }),
    ],
  ])("drops %s", (_label, raw) => {
    const store = stubLocalStorage({ [STORAGE_KEY]: raw });

    expect(readOnboardingIntent()).toBe(null);
    expect(store.has(STORAGE_KEY)).toBe(false);
  });

  test("ignores a non-string display name rather than the whole intent", () => {
    stubLocalStorage({
      [STORAGE_KEY]: JSON.stringify({
        ecosystem: "npm",
        packageName: "react",
        displayName: 7,
        at: Date.now(),
      }),
    });

    expect(readOnboardingIntent()).toMatchObject({ packageName: "react", displayName: null });
  });

  test("ages out a stale intent", () => {
    const store = stubLocalStorage();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    rememberOnboardingIntent({ ecosystem: "npm", packageName: "react" });

    vi.setSystemTime(new Date("2026-01-14T23:00:00Z"));
    expect(readOnboardingIntent()?.packageName).toBe("react");

    vi.setSystemTime(new Date("2026-01-16T00:00:00Z"));
    expect(readOnboardingIntent()).toBe(null);
    expect(store.has(STORAGE_KEY)).toBe(false);
  });

  test("refuses to store an unusable package name", () => {
    const store = stubLocalStorage();

    rememberOnboardingIntent({ ecosystem: "npm", packageName: "" });

    expect(store.has(STORAGE_KEY)).toBe(false);
  });

  test("survives storage being blocked", () => {
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

    expect(() =>
      rememberOnboardingIntent({ ecosystem: "npm", packageName: "react" }),
    ).not.toThrow();
    expect(readOnboardingIntent()).toBe(null);
    expect(() => clearOnboardingIntent()).not.toThrow();
  });

  test("works without localStorage at all", () => {
    delete (globalThis as { localStorage?: unknown }).localStorage;

    expect(() =>
      rememberOnboardingIntent({ ecosystem: "npm", packageName: "react" }),
    ).not.toThrow();
    expect(readOnboardingIntent()).toBe(null);
    expect(() => clearOnboardingIntent()).not.toThrow();
  });
});
