import { describe, expect, test, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {},
}));

const { SANDBOX_MAX_FILES, evaluateNpmStageGatewayRequest } = await import("../server/lib/sandbox");

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
  });

  // The sandbox URL-encodes the stage id, and the stage-id grammar allows `:`.
  test("allows a staged tarball whose stage id contains a colon, encoded or not", () => {
    for (const id of [encodeURIComponent("npm:stage:abc123"), "npm:stage:abc123"]) {
      expect(
        evaluateNpmStageGatewayRequest(`${registry}/-/stage/${id}/tarball`, "GET", registry),
      ).toEqual({ allowed: true, credentialed: true, kind: "staged-tarball" });
    }
    for (const id of ["ab%3A", "stage%2F..%2Fadmin", "stage%ZZ123", "%2Dstage123"]) {
      expect(
        evaluateNpmStageGatewayRequest(`${registry}/-/stage/${id}/tarball`, "GET", registry),
      ).toEqual({ allowed: false, credentialed: false, kind: "blocked" });
    }
  });

  // The sandbox never reads packuments; the parent Worker does.
  test("blocks package metadata", () => {
    expect(
      evaluateNpmStageGatewayRequest("https://registry.npmjs.org/@scope%2fpkg", "GET", registry),
    ).toEqual({ allowed: false, credentialed: false, kind: "blocked" });
  });

  test("blocks published .tgz tarballs (fetched by the trusted parent, not the sandbox)", () => {
    expect(
      evaluateNpmStageGatewayRequest(
        "https://registry.npmjs.org/pkg/-/pkg-1.2.3.tgz",
        "GET",
        registry,
      ),
    ).toEqual({
      allowed: false,
      credentialed: false,
      kind: "blocked",
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
      ["https://registry.npmjs.org/pkg/-/pkg-1.2.3.tgz", "GET"],
    ];

    for (const [url, method] of blocked) {
      expect(evaluateNpmStageGatewayRequest(url, method, registry)).toEqual({
        allowed: false,
        credentialed: false,
        kind: "blocked",
      });
    }
  });

  test("allows exact public artifact URLs without credentials", () => {
    expect(
      evaluateNpmStageGatewayRequest(
        "https://files.pythonhosted.org/packages/aa/bb/demo-1.0.0-py3-none-any.whl",
        "GET",
        registry,
        ["https://files.pythonhosted.org/packages/aa/bb/demo-1.0.0-py3-none-any.whl"],
      ),
    ).toEqual({
      allowed: true,
      credentialed: false,
      kind: "public-artifact",
    });

    expect(
      evaluateNpmStageGatewayRequest(
        "https://files.pythonhosted.org/packages/aa/bb/other-1.0.0-py3-none-any.whl",
        "GET",
        registry,
        ["https://files.pythonhosted.org/packages/aa/bb/demo-1.0.0-py3-none-any.whl"],
      ),
    ).toEqual({
      allowed: false,
      credentialed: false,
      kind: "blocked",
    });
  });
});

describe("sandbox archive limits", () => {
  test("defaults allow 2,500 files", () => {
    expect(SANDBOX_MAX_FILES).toBe(2_500);
  });
});
