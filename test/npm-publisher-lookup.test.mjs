import { afterEach, describe, expect, test, vi } from "vitest";
import {
  fetchNpmBuildIdentity,
  fetchNpmTrustConfigs,
} from "../server/lib/ecosystems/npm/publisher-lookup";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function respond(status, body) {
  const fetchMock = vi.fn(async () =>
    body === undefined
      ? new Response(null, { status })
      : new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        }),
  );
  globalThis.fetch = fetchMock;
  return fetchMock;
}

const config = {
  id: "tc_1",
  type: "github",
  claims: { repository: "acme/tool", workflow_ref: { file: "publish.yml" } },
  permissions: ["createStagedPackage"],
};

describe("fetchNpmTrustConfigs", () => {
  test("calls the escaped trust route with the org token and parses the list", async () => {
    const fetchMock = respond(200, [config]);

    const result = await fetchNpmTrustConfigs(
      "https://registry.npmjs.org",
      "npm_token",
      "@scope/pkg",
    );

    expect(result).toEqual({
      state: "checked",
      configs: [
        {
          id: "tc_1",
          provider: "github",
          repository: "acme/tool",
          workflowFile: "publish.yml",
          environment: null,
          directPublish: false,
          stagePublish: true,
        },
      ],
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://registry.npmjs.org/-/package/%40scope%2Fpkg/trust");
    expect(init.headers.authorization).toBe("Bearer npm_token");
  });

  test.each([401, 403, 404, 429, 500])(
    "reports %s from the public registry as unavailable",
    async (status) => {
      respond(status, { error: "no" });
      const result = await fetchNpmTrustConfigs("https://registry.npmjs.org", "npm_token", "pkg");
      expect(result).toEqual({ state: "unavailable", httpStatus: status });
    },
  );

  test("reports a custom registry without the route as unsupported", async () => {
    respond(404, { error: "no" });
    const result = await fetchNpmTrustConfigs("https://npm.example.invalid", "npm_token", "pkg");
    expect(result).toEqual({ state: "unsupported", httpStatus: 404 });
  });

  test("never throws on transport failure, bad names, or non-list bodies", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("boom");
    });
    expect(await fetchNpmTrustConfigs("https://registry.npmjs.org", "t", "pkg")).toEqual({
      state: "unavailable",
      httpStatus: null,
    });
    expect(await fetchNpmTrustConfigs("https://registry.npmjs.org", "t", "../pkg")).toEqual({
      state: "unavailable",
      httpStatus: null,
    });
    respond(200, { configs: [] });
    expect(await fetchNpmTrustConfigs("https://registry.npmjs.org", "t", "pkg")).toEqual({
      state: "unavailable",
      httpStatus: 200,
    });
  });
});

describe("fetchNpmBuildIdentity", () => {
  test("asks the public attestation route without credentials", async () => {
    const fetchMock = respond(404);

    const result = await fetchNpmBuildIdentity("https://registry.npmjs.org", "@scope/pkg", "1.0.0");

    expect(result).toBeNull();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://registry.npmjs.org/-/npm/v1/attestations/%40scope%2Fpkg@1.0.0");
    expect(init.headers.authorization).toBeUndefined();
  });

  test("returns the build identity from a SLSA attestation", async () => {
    const payload = Buffer.from(
      JSON.stringify({
        _type: "https://in-toto.io/Statement/v1",
        predicateType: "https://slsa.dev/provenance/v1",
        predicate: {
          buildDefinition: {
            externalParameters: {
              workflow: {
                ref: "refs/tags/v1.0.0",
                repository: "https://github.com/acme/tool",
                path: ".github/workflows/publish.yml",
              },
            },
          },
        },
      }),
    ).toString("base64");
    respond(200, {
      attestations: [
        {
          predicateType: "https://slsa.dev/provenance/v1",
          bundle: { dsseEnvelope: { payload, payloadType: "application/vnd.in-toto+json" } },
        },
      ],
    });

    expect(await fetchNpmBuildIdentity("https://registry.npmjs.org", "tool", "1.0.0")).toEqual({
      repository: "acme/tool",
      workflowPath: ".github/workflows/publish.yml",
      ref: "refs/tags/v1.0.0",
      builderId: null,
    });
  });

  test("skips the request for missing or malformed coordinates", async () => {
    const fetchMock = respond(200, { attestations: [] });
    expect(await fetchNpmBuildIdentity("https://registry.npmjs.org", "tool", null)).toBeNull();
    expect(
      await fetchNpmBuildIdentity("https://registry.npmjs.org", "tool", "1.0.0/../x"),
    ).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
