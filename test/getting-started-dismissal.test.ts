import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const STORAGE_KEY = "drydock:getting-started-done";

function stubLocalStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
  return store;
}

// The module keeps per-session state, so each test gets a fresh copy of the
// whole graph — including the active-organization signal it reads.
async function loadModule() {
  vi.resetModules();
  const [gettingStarted, activeOrganization] = await Promise.all([
    import("../src/models/getting-started"),
    import("../src/models/active-organization"),
  ]);
  return { ...gettingStarted, ...activeOrganization };
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe("getting-started dismissal", () => {
  test("dismisses the active organization and remembers it", async () => {
    const store = stubLocalStorage();
    const { gettingStartedDismissed, dismissGettingStarted, setActiveOrganizationId } =
      await loadModule();
    setActiveOrganizationId("org-a");
    expect(gettingStartedDismissed.value).toBe(false);

    dismissGettingStarted();

    expect(gettingStartedDismissed.value).toBe(true);
    expect(JSON.parse(store.get(STORAGE_KEY) ?? "{}")).toEqual({ "org-a": true });
  });

  test("is per organization", async () => {
    stubLocalStorage();
    const { gettingStartedDismissed, dismissGettingStarted, setActiveOrganizationId } =
      await loadModule();
    setActiveOrganizationId("org-a");
    dismissGettingStarted();

    setActiveOrganizationId("org-b");

    // A second organization is a second onboarding.
    expect(gettingStartedDismissed.value).toBe(false);
  });

  test("a later session reads what an earlier one stored", async () => {
    stubLocalStorage({ [STORAGE_KEY]: JSON.stringify({ "org-a": true }) });
    const { gettingStartedDismissed, setActiveOrganizationId } = await loadModule();

    setActiveOrganizationId("org-a");

    expect(gettingStartedDismissed.value).toBe(true);
  });

  test("ignores a stored value that is not a map of dismissals", async () => {
    const store = stubLocalStorage({ [STORAGE_KEY]: '["org-a"]' });
    const { gettingStartedDismissed, dismissGettingStarted, setActiveOrganizationId } =
      await loadModule();
    setActiveOrganizationId("org-a");

    expect(gettingStartedDismissed.value).toBe(false);
    dismissGettingStarted();
    expect(gettingStartedDismissed.value).toBe(true);
    expect(JSON.parse(store.get(STORAGE_KEY) ?? "{}")).toEqual({ "org-a": true });
  });

  test("still hides the panel when the active organization is unknown", async () => {
    const store = stubLocalStorage();
    const { gettingStartedDismissed, dismissGettingStarted, setActiveOrganizationId } =
      await loadModule();
    setActiveOrganizationId(null);

    dismissGettingStarted();

    expect(gettingStartedDismissed.value).toBe(true);
    // Nothing worth persisting: the dismissal belongs to an organization that
    // could not be identified.
    expect(store.has(STORAGE_KEY)).toBe(false);
  });

  test("survives storage being blocked", async () => {
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
    const { gettingStartedDismissed, dismissGettingStarted, setActiveOrganizationId } =
      await loadModule();
    setActiveOrganizationId("org-a");

    expect(() => dismissGettingStarted()).not.toThrow();
    expect(gettingStartedDismissed.value).toBe(true);
  });
});
