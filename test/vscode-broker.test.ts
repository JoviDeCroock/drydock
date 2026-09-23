import { afterEach, describe, expect, test, vi } from "vitest";
import { createVscodeBroker } from "../server/lib/ecosystems/vscode/broker";

const EXTENSION_ID = "example.remote-text-fetcher";
const ASSET_URI =
  "https://example.gallerycdn.vsassets.io/extensions/example/remote-text-fetcher/0.9.0/123";

function marketplaceResponse(extensions: unknown[]): unknown {
  return { results: [{ extensions }] };
}

function extension(versions: unknown[]): unknown {
  return {
    publisher: { publisherName: "example" },
    extensionName: "remote-text-fetcher",
    versions,
  };
}

function stubFetch(response: Response): { bodies: unknown[] } {
  const bodies: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Promise.resolve(response);
    }),
  );
  return { bodies };
}

function broker() {
  return createVscodeBroker({} as never, { organizationId: "org_1" } as never);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("VS Code Marketplace version lookup", () => {
  test("asks for versions and asset URIs without per-version file manifests", async () => {
    const { bodies } = stubFetch(
      Response.json(
        marketplaceResponse([
          extension([
            { version: "0.9.0", lastUpdated: "2026-05-01T00:00:00Z", assetUri: ASSET_URI },
          ]),
        ]),
      ),
    );

    const versions = await broker().fetchExtensionVersions(EXTENSION_ID);

    expect(versions).toEqual([
      { version: "0.9.0", lastUpdated: "2026-05-01T00:00:00Z", assetUri: ASSET_URI, files: [] },
    ]);
    const flags = (bodies[0] as { flags: number }).flags;
    expect(flags & 1).toBe(1); // IncludeVersions
    expect(flags & 128).toBe(128); // IncludeAssetUri
    expect(flags & 2).toBe(0); // not IncludeFiles
  });

  test("an answer without the extension means no published versions", async () => {
    stubFetch(Response.json(marketplaceResponse([])));

    await expect(broker().fetchExtensionVersions(EXTENSION_ID)).resolves.toEqual([]);
  });

  test.each([
    ["a non-2xx answer", new Response("unavailable", { status: 503 })],
    ["a malformed answer", Response.json({ unexpected: true })],
    [
      "an answer over the byte cap",
      new Response("{}", { headers: { "content-length": String(64 * 1024 * 1024) } }),
    ],
  ])("%s is unavailable metadata, not an empty history", async (_label, response) => {
    stubFetch(response);

    await expect(broker().fetchExtensionVersions(EXTENSION_ID)).resolves.toBeNull();
  });
});
