import { vi } from "vitest";

interface GithubArtifactStub {
  id: number;
  name: string;
  bundleZip?: Uint8Array<ArrayBuffer>;
  expired?: boolean;
}

export interface GithubFetchStubOptions {
  artifacts: GithubArtifactStub[];
  // Match only this run's artifact listing; any other run URL is unexpected.
  runId?: number;
  // Answer the installation-token exchange, for suites that go through the
  // GitHub App client rather than a pre-minted token.
  installationToken?: boolean;
  artifactsResponse?: () => Response;
  // `null` omits content-length on the zip download; a number overrides it.
  contentLength?: number | null;
}

// Replaces global fetch with a GitHub Actions artifacts API double and returns
// the calls it saw. Callers restore with `vi.unstubAllGlobals()`.
export function stubGithubFetch(options: GithubFetchStubOptions) {
  const calls: { url: string; authorization: string | null }[] = [];
  const { artifacts } = options;
  const runsPath =
    options.runId === undefined ? "/actions/runs/" : `/actions/runs/${options.runId}/artifacts`;
  const artifactsBody = JSON.stringify({
    total_count: artifacts.length,
    artifacts: artifacts.map((artifact) => ({
      id: artifact.id,
      name: artifact.name,
      size_in_bytes: artifact.bundleZip?.length ?? 0,
      expired: artifact.expired === true,
    })),
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      calls.push({ url: request.url, authorization: request.headers.get("authorization") });
      if (options.installationToken && request.url.includes("/access_tokens")) {
        return Response.json({ token: "ghs_install_token", expires_at: "2099-01-01T00:00:00Z" });
      }
      if (request.url.includes(runsPath)) {
        if (options.artifactsResponse) return options.artifactsResponse();
        return new Response(artifactsBody, {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (request.url.includes("/actions/artifacts/")) {
        const match = request.url.match(/\/actions\/artifacts\/(\d+)\/zip$/);
        const artifactId = match ? Number.parseInt(match[1], 10) : Number.NaN;
        const artifact = artifacts.find((candidate) => candidate.id === artifactId);
        if (!artifact?.bundleZip) return new Response("not found", { status: 404 });
        const headers: Record<string, string> = { "content-type": "application/zip" };
        if (options.contentLength !== null) {
          headers["content-length"] = String(options.contentLength ?? artifact.bundleZip.length);
        }
        return new Response(artifact.bundleZip, { status: 200, headers });
      }
      throw new Error(`unexpected fetch in test: ${request.url}`);
    }),
  );
  return calls;
}
