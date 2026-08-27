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

describe("getting-started done state", () => {
  test("keeps an open panel latched while the reader visits a scan", async () => {
    stubLocalStorage();
    const {
      closeGettingStartedPanel,
      gettingStartedPanelOpen,
      markGettingStartedDone,
      openGettingStartedPanel,
      setActiveOrganizationId,
    } = await loadModule();
    setActiveOrganizationId("org-a");
    openGettingStartedPanel("org-a");

    // Recording the decision can happen on the separate scan-detail route.
    // Completion prevents future opens, but the existing latch survives until
    // the returning dashboard renders the final tick and the reader closes it.
    markGettingStartedDone();

    expect(gettingStartedPanelOpen.value).toBe(true);
    closeGettingStartedPanel();
    expect(gettingStartedPanelOpen.value).toBe(false);
  });

  test("does not carry the open panel into another organization", async () => {
    stubLocalStorage();
    const { gettingStartedPanelOpen, openGettingStartedPanel, setActiveOrganizationId } =
      await loadModule();
    setActiveOrganizationId("org-a");
    openGettingStartedPanel("org-a");

    setActiveOrganizationId("org-b");

    expect(gettingStartedPanelOpen.value).toBe(false);
  });

  test("marks the active organization finished and remembers it", async () => {
    const store = stubLocalStorage();
    const { gettingStartedDone, markGettingStartedDone, setActiveOrganizationId } =
      await loadModule();
    setActiveOrganizationId("org-a");
    expect(gettingStartedDone.value).toBe(false);

    markGettingStartedDone();

    expect(gettingStartedDone.value).toBe(true);
    expect(JSON.parse(store.get(STORAGE_KEY) ?? "{}")).toEqual({ "org-a": true });
  });

  test("is per organization", async () => {
    stubLocalStorage();
    const { gettingStartedDone, markGettingStartedDone, setActiveOrganizationId } =
      await loadModule();
    setActiveOrganizationId("org-a");
    markGettingStartedDone();

    setActiveOrganizationId("org-b");

    // A second organization is a second onboarding.
    expect(gettingStartedDone.value).toBe(false);
  });

  test("a later session reads what an earlier one stored", async () => {
    stubLocalStorage({ [STORAGE_KEY]: JSON.stringify({ "org-a": true }) });
    const { gettingStartedDone, setActiveOrganizationId } = await loadModule();

    setActiveOrganizationId("org-a");

    expect(gettingStartedDone.value).toBe(true);
  });

  test("ignores a stored value that is not a map of finished organizations", async () => {
    const store = stubLocalStorage({ [STORAGE_KEY]: '["org-a"]' });
    const { gettingStartedDone, markGettingStartedDone, setActiveOrganizationId } =
      await loadModule();
    setActiveOrganizationId("org-a");

    expect(gettingStartedDone.value).toBe(false);
    markGettingStartedDone();
    expect(gettingStartedDone.value).toBe(true);
    expect(JSON.parse(store.get(STORAGE_KEY) ?? "{}")).toEqual({ "org-a": true });
  });

  test("still records a dismissal when the active organization is unknown", async () => {
    const store = stubLocalStorage();
    const { gettingStartedDone, markGettingStartedDone, setActiveOrganizationId } =
      await loadModule();
    setActiveOrganizationId(null);

    markGettingStartedDone();

    expect(gettingStartedDone.value).toBe(true);
    // Nothing worth persisting: it belongs to an organization that could not
    // be identified.
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
    const { gettingStartedDone, markGettingStartedDone, setActiveOrganizationId } =
      await loadModule();
    setActiveOrganizationId("org-a");

    expect(() => markGettingStartedDone()).not.toThrow();
    expect(gettingStartedDone.value).toBe(true);
  });
});
