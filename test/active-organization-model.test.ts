import { afterEach, describe, expect, test, vi } from "vitest";
import {
  activeOrganizationId,
  applyActiveOrganizationFromUrl,
  pinOrganization,
  pinnedOrganizationId,
  setActiveOrganizationId,
  unpinOrganization,
} from "../src/models/active-organization";
import { apiFetch } from "../src/models/api";

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
  unpinOrganization();
  setActiveOrganizationId(null);
  vi.unstubAllGlobals();
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

describe("an organization pinned by the page's URL", () => {
  function requestHeaders() {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    return async () => {
      await apiFetch("/api/v1/anything");
      const [, init] = fetchMock.mock.calls.at(-1) as unknown as [string, RequestInit];
      return init.headers as Record<string, string>;
    };
  }

  test("is sent strictly with every request so the server refuses a non-member", async () => {
    const headers = requestHeaders();
    setActiveOrganizationId("org_remembered");
    expect(await headers()).toMatchObject({ "x-organization-id": "org_remembered" });
    expect(await headers()).not.toHaveProperty("x-organization-strict");

    pinOrganization("org_from_link");
    expect(activeOrganizationId.value).toBe("org_from_link");
    expect(pinnedOrganizationId.value).toBe("org_from_link");
    expect(await headers()).toMatchObject({
      "x-organization-id": "org_from_link",
      "x-organization-strict": "1",
    });

    // Leaving the page keeps the organization remembered but not strict.
    unpinOrganization();
    expect(activeOrganizationId.value).toBe("org_from_link");
    expect(await headers()).not.toHaveProperty("x-organization-strict");
  });

  test("names the refusal instead of passing on a bare forbidden", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "forbidden", code: "not_organization_member" }), {
            status: 403,
          }),
      ),
    );
    await expect(apiFetch("/api/v1/anything")).rejects.toThrow(
      "You are not a member of this organization.",
    );
  });
});
