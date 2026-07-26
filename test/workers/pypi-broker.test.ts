import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createPyPiBroker } from "../../server/lib/ecosystems/pypi/broker";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.unstubAllGlobals();
});

interface LoadConfig {
  env: Record<string, unknown>;
}

function buildLoaderMock() {
  const loads: LoadConfig[] = [];
  return {
    loads,
    binding: {
      load: vi.fn((config: LoadConfig) => {
        loads.push(config);
        return {
          getEntrypoint: () => ({
            fetch: vi.fn(
              async () =>
                new Response(
                  JSON.stringify({
                    files: [{ path: "stub.txt", size: 1, sha256: "00", flags: [] }],
                    packageJson: null,
                  }),
                  { status: 200, headers: { "content-type": "application/json" } },
                ),
            ),
          }),
        };
      }),
    },
  };
}

interface GatewayProps {
  npmToken?: string;
  npmRegistry?: string;
  publicArtifactUrls?: string[];
}

function buildCtxWithGateway() {
  const gatewayProps: GatewayProps[] = [];
  const ctx = createExecutionContext() as ExecutionContext & {
    exports: { NpmStageGateway(options: { props: GatewayProps }): Fetcher };
  };
  ctx.exports = {
    NpmStageGateway: vi.fn((options: { props: GatewayProps }) => {
      gatewayProps.push(options.props);
      return { fetch: vi.fn() } as unknown as Fetcher;
    }),
  };
  return { ctx, gatewayProps };
}

function brokerCtx(executionCtx: ExecutionContext, loaderBinding: unknown) {
  return {
    env: { ...env, LOADER: loaderBinding } as Cloudflare.Env,
    executionCtx,
    db: {} as never,
    session: {} as never,
  };
}

describe("createPyPiBroker public artifact download", () => {
  test("downloads a wheel as zip through an uncredentialed, URL-pinned gateway", async () => {
    const wheelUrl = "https://files.pythonhosted.org/packages/demo-1.1.0-py3-none-any.whl";
    const loader = buildLoaderMock();
    const { ctx, gatewayProps } = buildCtxWithGateway();
    const broker = createPyPiBroker(brokerCtx(ctx, loader.binding), { organizationId: "org_1" });

    const result = await broker.downloadPublicArtifact({ url: wheelUrl, kind: "wheel" });

    expect(result.files).toHaveLength(1);
    expect(loader.loads).toHaveLength(1);
    expect(loader.loads[0].env.ARCHIVE_FORMAT).toBe("zip");
    // The gateway must never receive an npm token, and its public-artifact
    // allowlist must contain exactly the single URL being fetched.
    expect(gatewayProps).toHaveLength(1);
    expect(gatewayProps[0].npmToken).toBeUndefined();
    expect(gatewayProps[0].publicArtifactUrls).toEqual([wheelUrl]);
  });

  test("downloads an sdist as tgz", async () => {
    const sdistUrl = "https://files.pythonhosted.org/packages/demo-1.1.0.tar.gz";
    const loader = buildLoaderMock();
    const { ctx, gatewayProps } = buildCtxWithGateway();
    const broker = createPyPiBroker(brokerCtx(ctx, loader.binding), { organizationId: "org_1" });

    await broker.downloadPublicArtifact({ url: sdistUrl, kind: "sdist" });

    expect(loader.loads[0].env.ARCHIVE_FORMAT).toBe("tgz");
    expect(gatewayProps[0].npmToken).toBeUndefined();
    expect(gatewayProps[0].publicArtifactUrls).toEqual([sdistUrl]);
  });

  test("rejects non-https artifact URLs before loading the sandbox", async () => {
    const loader = buildLoaderMock();
    const { ctx } = buildCtxWithGateway();
    const broker = createPyPiBroker(brokerCtx(ctx, loader.binding), { organizationId: "org_1" });

    await expect(
      broker.downloadPublicArtifact({
        url: "http://files.pythonhosted.org/packages/a.whl",
        kind: "wheel",
      }),
    ).rejects.toThrow();
    expect(loader.loads).toHaveLength(0);
  });

  test("rejects foreign HTTPS artifact URLs before loading the sandbox", async () => {
    const loader = buildLoaderMock();
    const { ctx, gatewayProps } = buildCtxWithGateway();
    const broker = createPyPiBroker(brokerCtx(ctx, loader.binding), { organizationId: "org_1" });

    await expect(
      broker.downloadPublicArtifact({
        url: "https://example.com/packages/a.whl",
        kind: "wheel",
      }),
    ).rejects.toThrow(/not allowed/);
    expect(loader.loads).toHaveLength(0);
    expect(gatewayProps).toHaveLength(0);
  });
});

describe("createPyPiBroker project metadata", () => {
  test("returns parsed metadata from pypi.org", async () => {
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      expect(url).toBe("https://pypi.org/pypi/demo-package/json");
      return Response.json({ info: { name: "demo-package", version: "1.1.0" } });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const { ctx } = buildCtxWithGateway();
    const loader = buildLoaderMock();
    const broker = createPyPiBroker(brokerCtx(ctx, loader.binding), { organizationId: "org_1" });

    const metadata = await broker.fetchProjectMetadata("demo-package");
    expect(metadata?.info?.version).toBe("1.1.0");
  });

  test("returns null when pypi.org responds with an error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not found", { status: 404 })),
    );

    const { ctx } = buildCtxWithGateway();
    const loader = buildLoaderMock();
    const broker = createPyPiBroker(brokerCtx(ctx, loader.binding), { organizationId: "org_1" });

    expect(await broker.fetchProjectMetadata("missing-package")).toBeNull();
  });
});
