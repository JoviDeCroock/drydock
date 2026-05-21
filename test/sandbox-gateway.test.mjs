import { describe, expect, test, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {},
}));

const { evaluateNpmStageGatewayRequest } = await import("../server/lib/sandbox.ts");

describe("npm stage gateway policy", () => {
  const registry = "https://registry.npmjs.org";

  test("allows only expected credentialed npm GET endpoints", () => {
    expect(
      evaluateNpmStageGatewayRequest(
        "https://registry.npmjs.org/-/stage/stage-123/tarball",
        "GET",
        registry,
      ),
    ).toMatchObject({
      allowed: true,
      credentialed: true,
      kind: "staged-tarball",
    });
    expect(
      evaluateNpmStageGatewayRequest("https://registry.npmjs.org/@scope%2fpkg", "GET", registry),
    ).toMatchObject({
      allowed: true,
      credentialed: true,
      kind: "package-metadata",
    });
    expect(
      evaluateNpmStageGatewayRequest(
        "https://registry.npmjs.org/pkg/-/pkg-1.2.3.tgz",
        "GET",
        registry,
      ),
    ).toMatchObject({
      allowed: true,
      credentialed: true,
      kind: "published-tarball",
    });
  });

  test("blocks non-registry origins, non-GETs, and npm endpoints outside the allowlist", () => {
    const blocked = [
      ["https://example.com/-/stage/stage-123/tarball", "GET"],
      ["https://registry.npmjs.org/-/stage/stage-123/tarball", "POST"],
      ["https://registry.npmjs.org/-/stage", "GET"],
      ["https://registry.npmjs.org/-/whoami", "GET"],
      ["https://registry.npmjs.org/pkg", "PUT"],
      ["https://registry.npmjs.org/pkg/readme", "GET"],
    ];

    for (const [url, method] of blocked) {
      expect(evaluateNpmStageGatewayRequest(url, method, registry)).toEqual({
        allowed: false,
        credentialed: false,
        kind: "blocked",
      });
    }
  });
});
