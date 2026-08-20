import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { NpmStageGateway } from "../../server/lib/sandbox";

interface CapturedRequest {
  url: string;
  method: string;
  authorization: string | null;
  userAgent: string | null;
}

function setupGateway(
  props: {
    npmToken?: string;
    npmRegistry?: string;
    publicArtifactUrls?: string[];
  },
  // Scripted upstream, for the redirect tests. Defaults to a plain 200 so every
  // existing case reads as before.
  respond: (request: Request) => Response = () => new Response("upstream-ok", { status: 200 }),
) {
  const captured: CapturedRequest[] = [];
  const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    captured.push({
      url: request.url,
      method: request.method,
      authorization: request.headers.get("authorization"),
      userAgent: request.headers.get("user-agent"),
    });
    return respond(request);
  });
  vi.stubGlobal("fetch", fetchSpy);

  const ctx = createExecutionContext() as ExecutionContext & {
    props: { npmToken?: string; npmRegistry?: string; publicArtifactUrls?: string[] };
  };
  ctx.props = props;
  const gateway = new (NpmStageGateway as unknown as new (
    ctx: ExecutionContext,
    env: Cloudflare.Env,
  ) => { fetch(request: Request): Promise<Response> })(ctx, env);
  return { gateway, captured };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("NpmStageGateway runtime credential injection", () => {
  test("attaches Authorization on staged-tarball requests", async () => {
    const { gateway, captured } = setupGateway({ npmToken: "npm_secret_token_123" });
    const res = await gateway.fetch(
      new Request("https://registry.npmjs.org/-/stage/stage-abc123/tarball"),
    );
    expect(res.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0].authorization).toBe("Bearer npm_secret_token_123");
    expect(captured[0].userAgent).toBe("staged-publish-review/0.3");
  });

  test("blocks published .tgz tarballs without forwarding the npm token", async () => {
    const { gateway, captured } = setupGateway({ npmToken: "npm_secret_token_xyz" });
    const res = await gateway.fetch(new Request("https://registry.npmjs.org/pkg/-/pkg-1.2.3.tgz"));
    expect(res.status).toBe(403);
    expect(captured).toHaveLength(0);
  });

  test("attaches Authorization on package-metadata requests", async () => {
    const { gateway, captured } = setupGateway({ npmToken: "npm_secret_meta" });
    const res = await gateway.fetch(new Request("https://registry.npmjs.org/@scope%2fpkg"));
    expect(res.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0].authorization).toBe("Bearer npm_secret_meta");
  });

  test("blocks foreign origins without forwarding or sending the token", async () => {
    const { gateway, captured } = setupGateway({ npmToken: "npm_should_not_leak" });
    const res = await gateway.fetch(
      new Request("https://example.com/-/stage/stage-abc123/tarball"),
    );
    expect(res.status).toBe(403);
    expect(captured).toHaveLength(0);
  });

  test("blocks state-changing methods even on allowed paths", async () => {
    const { gateway, captured } = setupGateway({ npmToken: "npm_should_not_leak" });
    const res = await gateway.fetch(
      new Request("https://registry.npmjs.org/-/stage/stage-abc123/tarball", { method: "POST" }),
    );
    expect(res.status).toBe(403);
    expect(captured).toHaveLength(0);
  });

  test("blocks /-/whoami and other unrelated registry paths", async () => {
    const { gateway, captured } = setupGateway({ npmToken: "npm_should_not_leak" });

    const whoami = await gateway.fetch(new Request("https://registry.npmjs.org/-/whoami"));
    expect(whoami.status).toBe(403);

    const readme = await gateway.fetch(new Request("https://registry.npmjs.org/pkg/readme"));
    expect(readme.status).toBe(403);

    expect(captured).toHaveLength(0);
  });

  test("omits Authorization when no npm token is configured", async () => {
    const { gateway, captured } = setupGateway({});
    const res = await gateway.fetch(
      new Request("https://registry.npmjs.org/-/stage/stage-no-token/tarball"),
    );
    expect(res.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0].authorization).toBeNull();
    expect(captured[0].userAgent).toBe("staged-publish-review/0.3");
  });

  test("allows exact public artifact URLs without forwarding npm credentials", async () => {
    const publicUrl = "https://files.pythonhosted.org/packages/aa/bb/demo-1.0.0-py3-none-any.whl";
    const { gateway, captured } = setupGateway({
      npmToken: "npm_should_not_reach_public_artifact",
      publicArtifactUrls: [publicUrl],
    });

    const res = await gateway.fetch(new Request(publicUrl));

    expect(res.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0].authorization).toBeNull();
  });

  test("blocks non-exact public artifact URLs without forwarding npm credentials", async () => {
    const { gateway, captured } = setupGateway({
      npmToken: "npm_should_not_leak",
      publicArtifactUrls: [
        "https://files.pythonhosted.org/packages/aa/bb/demo-1.0.0-py3-none-any.whl",
      ],
    });

    const res = await gateway.fetch(
      new Request("https://files.pythonhosted.org/packages/aa/bb/other-1.0.0-py3-none-any.whl"),
    );

    expect(res.status).toBe(403);
    expect(captured).toHaveLength(0);
  });

  test("respects custom registry origins supplied via props", async () => {
    const { gateway, captured } = setupGateway({
      npmToken: "npm_custom_registry_token",
      npmRegistry: "https://registry.example.com",
    });

    const allowed = await gateway.fetch(
      new Request("https://registry.example.com/-/stage/stage-custom/tarball"),
    );
    expect(allowed.status).toBe(200);
    expect(captured[0].authorization).toBe("Bearer npm_custom_registry_token");

    const blocked = await gateway.fetch(
      new Request("https://registry.npmjs.org/-/stage/stage-custom/tarball"),
    );
    expect(blocked.status).toBe(403);
    expect(captured).toHaveLength(1);
  });
});

// `publicArtifactUrls` pins one exact URL, so a redirect off it is a way to
// reach a host no policy ever saw. That matters most for atpm, where the
// artifact host is a PDS named by the DID document of the party under review:
// the parent Worker vets that host before pinning it, and an unchecked redirect
// would route straight around the check.
describe("NpmStageGateway pinned-artifact redirects", () => {
  const PDS = "https://pds.example.com";
  const BLOB = `${PDS}/xrpc/com.atproto.sync.getBlob?did=did%3Aplc%3Aabc&cid=bafkreiabc`;

  function redirectOnce(target: string) {
    let redirected = false;
    return () => {
      if (redirected) return new Response("upstream-ok", { status: 200 });
      redirected = true;
      return new Response(null, { status: 302, headers: { location: target } });
    };
  }

  test("blocks a redirect that leaves the pinned origin", async () => {
    const { gateway, captured } = setupGateway(
      { publicArtifactUrls: [BLOB] },
      redirectOnce("https://attacker.example/internal"),
    );

    const res = await gateway.fetch(new Request(BLOB));

    expect(res.status).toBe(403);
    // The off-origin hop is never issued.
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe(BLOB);
  });

  test("blocks a protocol-relative redirect to another host", async () => {
    const { gateway, captured } = setupGateway(
      { publicArtifactUrls: [BLOB] },
      redirectOnce("//attacker.example/internal"),
    );
    expect((await gateway.fetch(new Request(BLOB))).status).toBe(403);
    expect(captured).toHaveLength(1);
  });

  test("follows a same-origin redirect, which is the vetted host", async () => {
    const { gateway, captured } = setupGateway(
      { publicArtifactUrls: [BLOB] },
      redirectOnce(`${PDS}/blobs/bafkreiabc`),
    );

    const res = await gateway.fetch(new Request(BLOB));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("upstream-ok");
    expect(captured.map((entry) => entry.url)).toEqual([BLOB, `${PDS}/blobs/bafkreiabc`]);
    // Still credential-free on every hop.
    expect(captured.every((entry) => entry.authorization === null)).toBe(true);
    expect(captured.every((entry) => entry.userAgent === "staged-publish-review/0.3")).toBe(true);
  });

  test("refuses an endless same-origin redirect chain", async () => {
    let hops = 0;
    const { gateway } = setupGateway({ publicArtifactUrls: [BLOB] }, () => {
      hops += 1;
      return new Response(null, {
        status: 302,
        headers: { location: `${PDS}/hop/${hops}` },
      });
    });

    const res = await gateway.fetch(new Request(BLOB));

    expect(res.status).toBe(403);
    // Bounded: the original plus the redirect budget, never an unbounded loop.
    expect(hops).toBe(4);
  });

  test("a 3xx with no Location is refused rather than served as the artifact", async () => {
    const { gateway } = setupGateway(
      { publicArtifactUrls: [BLOB] },
      () => new Response(null, { status: 302 }),
    );
    expect((await gateway.fetch(new Request(BLOB))).status).toBe(403);
  });

  test("credentialed registry requests keep the runtime's own redirect handling", async () => {
    // Unchanged on purpose: a registry that moves a staged tarball to a CDN must
    // keep working, and that path is same-origin-pinned by the registry policy
    // rather than by an artifact URL.
    const { gateway, captured } = setupGateway(
      { npmToken: "npm_token" },
      redirectOnce("https://cdn.npmjs.example/stage.tgz"),
    );

    const res = await gateway.fetch(
      new Request("https://registry.npmjs.org/-/stage/stage-abc123/tarball"),
    );

    // The gateway forwards once and lets the runtime resolve the 302, so the
    // spy sees exactly one request and the 302 comes straight back through.
    expect(res.status).toBe(302);
    expect(captured).toHaveLength(1);
    expect(captured[0].authorization).toBe("Bearer npm_token");
  });
});
