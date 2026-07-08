import { createExecutionContext, env } from "cloudflare:test";
import { describe, expect, test, vi } from "vitest";
import {
  downloadInSandboxInline,
  downloadInSandboxStream,
  SandboxError,
} from "../../server/lib/sandbox";

interface LoaderRecord {
  globalOutboundProps: unknown;
  subRequestsLimit: number | undefined;
  receivedHeaders: Headers | null;
  receivedBody: Uint8Array | null;
}

function buildLoader(record: LoaderRecord) {
  const handler = vi.fn(async (request: Request) => {
    record.receivedHeaders = request.headers;
    const buf = await request.arrayBuffer();
    record.receivedBody = new Uint8Array(buf);
    return new Response(
      JSON.stringify({
        files: [{ path: "hello.txt", size: 5, sha256: "abc", flags: [] }],
        packageJson: null,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  return {
    load: vi.fn((options: { limits?: { subRequests?: number } }) => {
      record.subRequestsLimit = options.limits?.subRequests;
      return {
        getEntrypoint: () => ({
          fetch: (request: Request) => handler(request),
        }),
      };
    }),
  };
}

function buildCtxWithGateway(record: LoaderRecord) {
  const ctx = createExecutionContext() as ExecutionContext & {
    exports: {
      NpmStageGateway(options: { props: unknown }): Fetcher;
    };
  };
  ctx.exports = {
    NpmStageGateway: vi.fn((options: { props: unknown }) => {
      record.globalOutboundProps = options.props;
      return { fetch: vi.fn() } as unknown as Fetcher;
    }),
  };
  return ctx;
}

describe("downloadInSandboxInline", () => {
  test("constructs the gateway with empty props so no npm credentials enter the sandbox", async () => {
    const record: LoaderRecord = {
      globalOutboundProps: undefined,
      subRequestsLimit: undefined,
      receivedHeaders: null,
      receivedBody: null,
    };
    const loader = buildLoader(record);
    const ctx = buildCtxWithGateway(record);
    const sandboxEnv = { ...env, LOADER: loader as unknown as WorkerLoader } as Cloudflare.Env;

    const archive = new TextEncoder().encode("not-really-a-zip-but-fine-for-the-stub");
    const result = await downloadInSandboxInline(sandboxEnv, ctx, {
      bytes: archive,
      format: "zip",
    });

    expect(result.files).toHaveLength(1);
    expect(record.globalOutboundProps).toEqual({});
    expect(record.subRequestsLimit).toBe(0);
    expect(record.receivedHeaders?.get("x-archive-format")).toBe("zip");
    expect(record.receivedBody).toEqual(archive);
  });

  test("rejects an empty inline body", async () => {
    const record: LoaderRecord = {
      globalOutboundProps: undefined,
      subRequestsLimit: undefined,
      receivedHeaders: null,
      receivedBody: null,
    };
    const ctx = buildCtxWithGateway(record);
    const sandboxEnv = {
      ...env,
      LOADER: buildLoader(record) as unknown as WorkerLoader,
    } as Cloudflare.Env;

    await expect(
      downloadInSandboxInline(sandboxEnv, ctx, { bytes: new Uint8Array(), format: "zip" }),
    ).rejects.toBeInstanceOf(SandboxError);
  });

  test("accepts an inline body beyond the old 25 MB retention budget", async () => {
    // The sandbox streams both formats now: the inline pre-check bounds
    // total streaming work (SANDBOX_MAX_STREAM_TAR_BYTES), not what fits in
    // the retention budget, so a 25 MB+ archive reaches the loader.
    const record: LoaderRecord = {
      globalOutboundProps: undefined,
      subRequestsLimit: undefined,
      receivedHeaders: null,
      receivedBody: null,
    };
    const loader = buildLoader(record);
    const ctx = buildCtxWithGateway(record);
    const sandboxEnv = { ...env, LOADER: loader as unknown as WorkerLoader } as Cloudflare.Env;
    const big = new Uint8Array(25 * 1024 * 1024 + 1);

    const result = await downloadInSandboxInline(sandboxEnv, ctx, { bytes: big, format: "tgz" });

    expect(result.files).toHaveLength(1);
    expect(loader.load).toHaveBeenCalled();
  });
});

describe("downloadInSandboxStream", () => {
  test("pipes the body through without buffering and keeps credentials out of scope", async () => {
    const record: LoaderRecord = {
      globalOutboundProps: undefined,
      subRequestsLimit: undefined,
      receivedHeaders: null,
      receivedBody: null,
    };
    const loader = buildLoader(record);
    const ctx = buildCtxWithGateway(record);
    const sandboxEnv = { ...env, LOADER: loader as unknown as WorkerLoader } as Cloudflare.Env;

    const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });

    const result = await downloadInSandboxStream(sandboxEnv, ctx, { body, format: "tgz" });

    expect(result.files).toHaveLength(1);
    expect(record.globalOutboundProps).toEqual({});
    expect(record.subRequestsLimit).toBe(0);
    expect(record.receivedHeaders?.get("x-archive-format")).toBe("tgz");
    expect(record.receivedBody).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
  });
});
