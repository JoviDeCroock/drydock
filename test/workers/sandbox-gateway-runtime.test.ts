import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { NpmStageGateway } from "../../server/lib/sandbox";

interface CapturedRequest {
  url: string;
  method: string;
  redirect: RequestRedirect;
  authorization: string | null;
  userAgent: string | null;
}

function setupGateway(props: { npmToken?: string; allowedUrl: string; credentialed?: boolean }) {
  const captured: CapturedRequest[] = [];
  const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    captured.push({
      url: request.url,
      method: request.method,
      redirect: request.redirect,
      authorization: request.headers.get("authorization"),
      userAgent: request.headers.get("user-agent"),
    });
    return new Response("upstream-ok", { status: 200 });
  });
  vi.stubGlobal("fetch", fetchSpy);

  const ctx = createExecutionContext() as ExecutionContext & {
    props: { npmToken?: string; allowedUrl: string; credentialed?: boolean };
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
  test("attaches Authorization on the pinned URL", async () => {
    const allowedUrl = "https://registry.npmjs.org/-/stage/stage-abc123/tarball";
    const { gateway, captured } = setupGateway({
      npmToken: "npm_secret_token_123",
      allowedUrl,
    });
    const res = await gateway.fetch(new Request(allowedUrl));
    expect(res.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0].authorization).toBe("Bearer npm_secret_token_123");
    expect(captured[0].redirect).toBe("manual");
    expect(captured[0].userAgent).toBe("staged-publish-review/0.3");
  });

  test("blocks any URL other than the pinned one", async () => {
    const allowedUrl = "https://registry.npmjs.org/-/stage/stage-abc123/tarball";
    const { gateway, captured } = setupGateway({
      npmToken: "npm_should_not_leak",
      allowedUrl,
    });

    const otherStage = await gateway.fetch(
      new Request("https://registry.npmjs.org/-/stage/stage-other/tarball"),
    );
    expect(otherStage.status).toBe(403);

    const metadata = await gateway.fetch(new Request("https://registry.npmjs.org/@scope%2fpkg"));
    expect(metadata.status).toBe(403);

    const foreign = await gateway.fetch(
      new Request("https://example.com/-/stage/stage-abc123/tarball"),
    );
    expect(foreign.status).toBe(403);

    expect(captured).toHaveLength(0);
  });

  test("blocks state-changing methods on the pinned URL", async () => {
    const allowedUrl = "https://registry.npmjs.org/-/stage/stage-abc123/tarball";
    const { gateway, captured } = setupGateway({
      npmToken: "npm_should_not_leak",
      allowedUrl,
    });
    const res = await gateway.fetch(new Request(allowedUrl, { method: "POST" }));
    expect(res.status).toBe(403);
    expect(captured).toHaveLength(0);
  });

  test("omits Authorization when no npm token is configured", async () => {
    const allowedUrl = "https://registry.npmjs.org/-/stage/stage-no-token/tarball";
    const { gateway, captured } = setupGateway({ allowedUrl });
    const res = await gateway.fetch(new Request(allowedUrl));
    expect(res.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0].authorization).toBeNull();
    expect(captured[0].userAgent).toBe("staged-publish-review/0.3");
  });

  test("allows exact public artifact URLs without forwarding npm credentials", async () => {
    const publicUrl = "https://files.pythonhosted.org/packages/aa/bb/demo-1.0.0-py3-none-any.whl";
    const { gateway, captured } = setupGateway({
      npmToken: "npm_should_not_reach_public_artifact",
      allowedUrl: publicUrl,
      credentialed: false,
    });

    const res = await gateway.fetch(new Request(publicUrl));

    expect(res.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0].authorization).toBeNull();
  });

  test("blocks non-exact public artifact URLs without forwarding npm credentials", async () => {
    const { gateway, captured } = setupGateway({
      npmToken: "npm_should_not_leak",
      allowedUrl: "https://files.pythonhosted.org/packages/aa/bb/demo-1.0.0-py3-none-any.whl",
      credentialed: false,
    });

    const res = await gateway.fetch(
      new Request("https://files.pythonhosted.org/packages/aa/bb/other-1.0.0-py3-none-any.whl"),
    );

    expect(res.status).toBe(403);
    expect(captured).toHaveLength(0);
  });

  test("pins independently for custom registry origins", async () => {
    const allowedUrl = "https://registry.example.com/-/stage/stage-custom/tarball";
    const { gateway, captured } = setupGateway({
      npmToken: "npm_custom_registry_token",
      allowedUrl,
    });

    const allowed = await gateway.fetch(new Request(allowedUrl));
    expect(allowed.status).toBe(200);
    expect(captured[0].authorization).toBe("Bearer npm_custom_registry_token");

    const blocked = await gateway.fetch(
      new Request("https://registry.npmjs.org/-/stage/stage-custom/tarball"),
    );
    expect(blocked.status).toBe(403);
    expect(captured).toHaveLength(1);
  });
});
