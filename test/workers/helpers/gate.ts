import { createExecutionContext } from "cloudflare:test";
import { vi } from "vitest";

export { stubGithubFetch } from "../../helpers/github-fetch-stub";

export interface GatewayCtxOptions {
  // Observes the props each NpmStageGateway instance is constructed with, the
  // only place a test can see what credentials the sandbox was handed.
  onGateway?: (props: unknown) => void;
}

export function buildCtxWithGateway(options: GatewayCtxOptions = {}): ExecutionContext {
  const ctx = createExecutionContext() as ExecutionContext & {
    exports: { NpmStageGateway(options: { props: unknown }): Fetcher };
  };
  ctx.exports = {
    NpmStageGateway: vi.fn((gateway: { props: unknown }) => {
      options.onGateway?.(gateway.props);
      return { fetch: vi.fn() } as unknown as Fetcher;
    }),
  };
  return ctx;
}

interface LoaderCall {
  format: string | null;
  bodySize: number;
}

export interface LoaderMockOptions {
  // Sandbox results returned in order; the last one repeats once exhausted.
  results?: unknown[];
  // Full control over the response, for failure shapes `results` cannot express.
  respond?: (request: Request, index: number) => Response | Promise<Response>;
}

export function buildLoaderMock<Config = unknown>(options: LoaderMockOptions = {}) {
  const calls: LoaderCall[] = [];
  const loads: Config[] = [];
  const results = options.results ?? [{ files: [], packageJson: null }];
  return {
    calls,
    loads,
    binding: {
      load: vi.fn((config: Config) => {
        loads.push(config);
        return {
          getEntrypoint: () => ({
            fetch: vi.fn(async (request: Request) => {
              const index = calls.length;
              calls.push({
                format: request.headers.get("x-archive-format"),
                bodySize: (await request.arrayBuffer()).byteLength,
              });
              if (options.respond) return options.respond(request, index);
              return Response.json(results[Math.min(index, results.length - 1)]);
            }),
          }),
        };
      }),
    },
  };
}
