import { afterEach, describe, expect, test, vi } from "vitest";
import { fetchWithinBaseUrl, pathWithinBaseUrl } from "../server/lib/platform/url-scope";

const within = (url: string, base: string) => pathWithinBaseUrl(new URL(url), new URL(base));

describe("pathWithinBaseUrl", () => {
  test("a base at the origin root owns every path on its origin", () => {
    expect(
      within("https://registry.npmjs.org/-/stage/x/tarball", "https://registry.npmjs.org"),
    ).toBe("/-/stage/x/tarball");
    expect(within("https://registry.npmjs.org/pkg", "https://registry.npmjs.org/")).toBe("/pkg");
  });

  test("every credentialed npmjs.org endpoint Drydock builds is inside the default registry", () => {
    const npm = "https://registry.npmjs.org";
    for (const path of [
      "/-/whoami",
      "/-/stage?perPage=1",
      "/-/stage/npm%3Astage%3Aabc123",
      "/-/stage/npm%3Astage%3Aabc123/tarball",
      "/@scope%2fpkg",
      "/@scope/pkg",
      "/-/package/%40scope%2Fpkg/version/1.0.0-rc.1%2Bbuild.5/status",
      "/@scope/pkg/-/pkg-1.0.0.tgz",
      "/pkg/-/pkg-1.0.0.tgz",
    ]) {
      expect(within(`${npm}${path}`, npm), path).toBe(path.split("?")[0]);
    }
  });

  test("a base under a path owns only that subtree, with or without a trailing slash", () => {
    for (const base of ["https://host.test/npm", "https://host.test/npm/"]) {
      expect(within("https://host.test/npm/-/stage/x/tarball", base)).toBe("/-/stage/x/tarball");
      expect(within("https://host.test/npm", base)).toBeNull();
      expect(within("https://host.test/npm-evil/pkg", base)).toBeNull();
      expect(within("https://host.test/other/pkg", base)).toBeNull();
      expect(within("https://host.test/pkg", base)).toBeNull();
    }
  });

  test("dot segments are resolved by the parser before the check, encoded or not", () => {
    expect(within("https://host.test/npm/../pkg", "https://host.test/npm")).toBeNull();
    expect(within("https://host.test/npm/%2e%2e/pkg", "https://host.test/npm")).toBeNull();
    expect(within("https://host.test/npm/a/../pkg", "https://host.test/npm")).toBe("/pkg");
  });

  test("a dot segment hidden by encoding or a separator the parser keeps is outside any base", () => {
    for (const base of ["https://host.test/npm", "https://host.test"]) {
      const prefix = new URL(base).pathname.replace(/\/$/, "");
      for (const hidden of [
        "/-/stage/..%2f..%2f..%2f..%2fadmin/tarball",
        "/..%2f..%2fadmin",
        "/pkg/-/..%2F..%2Fadmin%2fx.tgz",
        "/..%5c..%5cadmin",
        "/..;/admin",
        "/%252e%252e%252fadmin",
        "/%25252e%25252e/admin",
        "/%2e%2e%2fadmin",
        "/.%2fpkg",
        "/pkg%zz",
        "/..%3fadmin",
        "/..%23admin",
        "/..%00/admin",
        "/%252e%252e%253fadmin",
      ]) {
        expect(within(`https://host.test${prefix}${hidden}`, base), hidden).toBeNull();
      }
    }
  });

  test("a decoded control character is outside any base", () => {
    for (const path of ["/pkg%00", "/pkg%0a", "/pkg%0D%0Ax", "/pkg%7f", "/pkg%2500"]) {
      expect(within(`https://host.test/npm${path}`, "https://host.test/npm"), path).toBeNull();
    }
  });

  test("dots inside a segment and encoded scope slashes stay inside", () => {
    const base = "https://host.test/npm";
    expect(within("https://host.test/npm/pkg/-/pkg-1.0.0.tgz", base)).toBe("/pkg/-/pkg-1.0.0.tgz");
    expect(within("https://host.test/npm/@scope%2fpkg", base)).toBe("/@scope%2fpkg");
    expect(within("https://host.test/npm/...pkg/a..b", base)).toBe("/...pkg/a..b");
  });

  test("another scheme, host, or port is outside the base", () => {
    for (const url of [
      "http://host.test/npm/pkg",
      "https://other.test/npm/pkg",
      "https://host.test:8443/npm/pkg",
    ]) {
      expect(within(url, "https://host.test/npm")).toBeNull();
    }
  });
});

describe("fetchWithinBaseUrl", () => {
  const BASE = "https://host.test/npm";
  const AUTH = "Bearer scoped-token";

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Each entry answers one hop; the recorder keeps what every hop carried.
  function stubHops(...responses: Array<() => Response>) {
    const hops: Array<{ url: string; authorization: string | null; redirect: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        hops.push({
          url: request.url,
          authorization: request.headers.get("authorization"),
          redirect: request.redirect,
        });
        const next = responses[hops.length - 1];
        if (!next) throw new Error(`unexpected hop ${request.url}`);
        return next();
      }),
    );
    return hops;
  }

  const redirect =
    (location: string, status = 302) =>
    () =>
      new Response(null, { status, headers: { location } });
  const ok = () => new Response("ok");

  test("a same-origin redirect out of the base path loses the credential", async () => {
    const hops = stubHops(redirect("/admin/y"), ok);
    const response = await fetchWithinBaseUrl(`${BASE}/same`, BASE, {
      headers: { authorization: AUTH },
    });
    expect(await response.text()).toBe("ok");
    expect(hops).toEqual([
      { url: `${BASE}/same`, authorization: AUTH, redirect: "manual" },
      { url: "https://host.test/admin/y", authorization: null, redirect: "manual" },
    ]);
  });

  test("redirects inside the base keep the credential; once dropped it stays dropped", async () => {
    const hops = stubHops(
      redirect(`${BASE}/moved`, 301),
      redirect("https://cdn.test/blob", 307),
      redirect(`${BASE}/back`, 308),
      ok,
    );
    await fetchWithinBaseUrl(`${BASE}/start`, BASE, { headers: { authorization: AUTH } });
    expect(hops.map((hop) => [hop.url, hop.authorization])).toEqual([
      [`${BASE}/start`, AUTH],
      [`${BASE}/moved`, AUTH],
      ["https://cdn.test/blob", null],
      [`${BASE}/back`, null],
    ]);
  });

  test("a redirect that hides a dot segment loses the credential", async () => {
    const hops = stubHops(redirect("/npm/..%2fadmin"), ok);
    await fetchWithinBaseUrl(`${BASE}/start`, BASE, { headers: { authorization: AUTH } });
    expect(hops[1]).toMatchObject({ url: `${BASE}/..%2fadmin`, authorization: null });
  });

  test("on the default npmjs.org registry a same-origin redirect keeps the credential and another host does not", async () => {
    const npm = "https://registry.npmjs.org";
    const hops = stubHops(
      redirect(`${npm}/@scope/pkg/-/pkg-1.0.0.tgz`, 301),
      redirect("https://cdn.npmjs.example/blob.tgz", 302),
      ok,
    );
    const response = await fetchWithinBaseUrl(`${npm}/@scope%2fpkg/-/pkg-1.0.0.tgz`, npm, {
      headers: { authorization: AUTH },
    });
    expect(await response.text()).toBe("ok");
    expect(hops.map((hop) => [hop.url, hop.authorization])).toEqual([
      [`${npm}/@scope%2fpkg/-/pkg-1.0.0.tgz`, AUTH],
      [`${npm}/@scope/pkg/-/pkg-1.0.0.tgz`, AUTH],
      ["https://cdn.npmjs.example/blob.tgz", null],
    ]);
  });

  test("a URL outside the base never carries the credential", async () => {
    const hops = stubHops(ok);
    await fetchWithinBaseUrl("https://host.test/admin", BASE, { headers: { authorization: AUTH } });
    expect(hops[0]?.authorization).toBeNull();
  });

  test("a 3xx without a location is the answer, and a redirect loop is refused", async () => {
    stubHops(() => new Response(null, { status: 304 }));
    expect((await fetchWithinBaseUrl(`${BASE}/x`, BASE)).status).toBe(304);

    stubHops(...Array.from({ length: 21 }, () => redirect(`${BASE}/loop`)));
    await expect(fetchWithinBaseUrl(`${BASE}/loop`, BASE)).rejects.toThrow("too many redirects");
  });

  test("a redirect to a non-http(s) URL is refused, not followed", async () => {
    for (const location of [
      "data:application/octet-stream;base64,AAAA",
      "file:///etc/passwd",
      "blob:https://host.test/x",
    ]) {
      const hops = stubHops(redirect(location), ok);
      await expect(
        fetchWithinBaseUrl(`${BASE}/x`, BASE, { headers: { authorization: AUTH } }),
        location,
      ).rejects.toThrow("non-http(s)");
      expect(hops).toHaveLength(1);
    }
  });

  test("redirect hops share one deadline instead of each getting a fresh timeout", async () => {
    let hops = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        hops++;
        const signal = init?.signal;
        // Each hop is slow but inside the per-attempt timeout on its own.
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 40);
          signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(signal.reason);
          });
        });
        return new Response(null, { status: 302, headers: { location: `${BASE}/next` } });
      }),
    );

    await expect(
      fetchWithinBaseUrl(`${BASE}/slow`, BASE, { timeoutMs: 100, attempts: 1 }),
    ).rejects.toThrow("fetch timeout");
    expect(hops).toBeLessThanOrEqual(4);
  });
});
