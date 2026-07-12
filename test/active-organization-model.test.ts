import { afterEach, describe, expect, test } from "vitest";
import {
  activeOrganizationId,
  applyActiveOrganizationFromUrl,
  setActiveOrganizationId,
} from "../src/models/active-organization";

interface WindowStub {
  replacedTo: string | null;
}

// The node test environment has no `window`; stand up the minimal surface the
// helper touches (location.href to read, history.replaceState to strip the param).
function stubWindow(href: string): WindowStub {
  const stub: WindowStub = { replacedTo: null };
  (globalThis as { window?: unknown }).window = {
    location: { href },
    history: {
      state: { marker: "keep" },
      replaceState: (_state: unknown, _title: string, next: string) => {
        stub.replacedTo = next;
      },
    },
  };
  return stub;
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  setActiveOrganizationId(null);
});

describe("applyActiveOrganizationFromUrl", () => {
  test("adopts ?org= into the active organization and strips only that param", () => {
    const win = stubWindow("https://drydock.test/dashboard/settings?tab=integrations&org=org_9");

    applyActiveOrganizationFromUrl();

    expect(activeOrganizationId.value).toBe("org_9");
    // Keeps the tab param, drops org, leaves the path intact.
    expect(win.replacedTo).toBe("/dashboard/settings?tab=integrations");
  });

  test("strips the org param from a scan deep-link", () => {
    const win = stubWindow("https://drydock.test/dashboard/scans/scan_1?org=org_9");

    applyActiveOrganizationFromUrl();

    expect(activeOrganizationId.value).toBe("org_9");
    expect(win.replacedTo).toBe("/dashboard/scans/scan_1");
  });

  test("is a no-op when no org param is present", () => {
    setActiveOrganizationId("existing_org");
    const win = stubWindow("https://drydock.test/dashboard/settings?tab=integrations");

    applyActiveOrganizationFromUrl();

    expect(activeOrganizationId.value).toBe("existing_org");
    expect(win.replacedTo).toBeNull();
  });

  test("does nothing outside the browser", () => {
    setActiveOrganizationId("existing_org");

    expect(() => applyActiveOrganizationFromUrl()).not.toThrow();
    expect(activeOrganizationId.value).toBe("existing_org");
  });
});
