import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { NpmStageGateway } from "../../server/lib/sandbox";

interface CapturedRequest {
  url: string;
  method: string;
  authorization: string | null;
  userAgent: string | null;
}

function setupGateway(props: { npmToken?: string; npmRegistry?: string }) {
  const captured: CapturedRequest[] = [];
  const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    captured.push({
      url: request.url,
      method: request.method,
      authorization: request.headers.get("authorization"),
      userAgent: request.headers.get("user-agent"),
    });
    return new Response("upstream-ok", { status: 200 });
  });
  vi.stubGlobal("fetch", fetchSpy);

  const ctx = createExecutionContext() as ExecutionContext & {
    props: { npmToken?: string; npmRegistry?: string };
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

  test("attaches Authorization on published-tarball requests", async () => {
    const { gateway, captured } = setupGateway({ npmToken: "npm_secret_token_xyz" });
    const res = await gateway.fetch(new Request("https://registry.npmjs.org/pkg/-/pkg-1.2.3.tgz"));
    expect(res.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0].authorization).toBe("Bearer npm_secret_token_xyz");
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
