import { describe, expect, test, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {},
}));

const { isAllowedPublicArtifactUrl, isAllowedPublishedTarballUrl, matchAllowedRequest } =
  await import("../server/lib/sandbox.ts");

describe("npm stage gateway URL pinning", () => {
  const stagedTarball = "https://registry.npmjs.org/-/stage/stage-abc123/tarball";

  test("allows the exact pinned URL via GET", () => {
    expect(matchAllowedRequest(stagedTarball, "GET", stagedTarball)).toEqual({ allowed: true });
  });

  test("blocks anything that is not the pinned URL", () => {
    const cases = [
      // different path on the same origin
      ["https://registry.npmjs.org/-/stage/stage-other/tarball", "GET"],
      ["https://registry.npmjs.org/-/whoami", "GET"],
      ["https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz", "GET"],
      ["https://registry.npmjs.org/@scope%2fpkg", "GET"],
      // different origin
      ["https://example.com/-/stage/stage-abc123/tarball", "GET"],
      // different protocol
      ["http://registry.npmjs.org/-/stage/stage-abc123/tarball", "GET"],
      // any non-GET on the pinned URL
      [stagedTarball, "POST"],
      [stagedTarball, "PUT"],
      [stagedTarball, "DELETE"],
      // appended query string the parent didn't authorise
      [`${stagedTarball}?x=1`, "GET"],
    ];

    for (const [url, method] of cases) {
      expect(matchAllowedRequest(url, method, stagedTarball)).toEqual({ allowed: false });
    }
  });

  test("rejects malformed URLs without throwing", () => {
    expect(matchAllowedRequest("not a url", "GET", stagedTarball)).toEqual({ allowed: false });
    expect(matchAllowedRequest(stagedTarball, "GET", "not a url")).toEqual({ allowed: false });
  });

  test("requires https on the pinned URL too", () => {
    const httpAllowed = "http://registry.npmjs.org/-/stage/stage-abc123/tarball";
    expect(matchAllowedRequest(httpAllowed, "GET", httpAllowed)).toEqual({ allowed: false });
  });

  test("only lets registry-issued published tarballs become pinned tarball URLs", () => {
    const registry = "https://registry.npmjs.org";
    expect(
      isAllowedPublishedTarballUrl("https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz", registry),
    ).toBe(true);
    expect(isAllowedPublishedTarballUrl("https://registry.npmjs.org/-/whoami", registry)).toBe(
      false,
    );
    expect(isAllowedPublishedTarballUrl("https://registry.npmjs.org/@scope%2fpkg", registry)).toBe(
      false,
    );
    expect(isAllowedPublishedTarballUrl("https://example.com/pkg/-/pkg-1.0.0.tgz", registry)).toBe(
      false,
    );
  });

  test("allows exact public artifact URLs to be pinned without credentials", () => {
    const artifact = "https://files.pythonhosted.org/packages/aa/bb/demo-1.0.0-py3-none-any.whl";
    expect(isAllowedPublicArtifactUrl(artifact, [artifact])).toBe(true);
    expect(
      isAllowedPublicArtifactUrl(
        "https://files.pythonhosted.org/packages/aa/bb/other-1.0.0-py3-none-any.whl",
        [artifact],
      ),
    ).toBe(false);
    expect(isAllowedPublicArtifactUrl(artifact.replace("https:", "http:"), [artifact])).toBe(false);
  });
});
