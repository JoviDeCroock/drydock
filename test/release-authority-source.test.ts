import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchReleaseAuthoritySourcesWithToken } from "../server/lib/github-app/workflow-source";

// Ingestion of the workflow graph behind a gated run. Two properties are the
// point of these specs: the installation token never leaves api.github.com, and
// anything unreadable becomes recorded coverage rather than a silent omission.

const originalFetch = globalThis.fetch;

const INPUT = {
  installationExternalId: "12345",
  repositoryFullName: "octo/example",
  environment: "pypi",
  runId: 4242,
};

const WORKFLOW = "on: push\njobs:\n  publish:\n    runs-on: ubuntu-latest\n";

interface Recorded {
  url: string;
  authorization: string | null;
}

function mockGithub(
  handler: (url: URL, request: Request) => Response | Promise<Response>,
): Recorded[] {
  const seen: Recorded[] = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    seen.push({
      url: request.url,
      authorization: request.headers.get("authorization"),
    });
    return handler(new URL(request.url), request);
  }) as typeof fetch;
  return seen;
}

function runResponse(
  referenced: Array<{ path: string; sha: string; ref: string }> = [],
  path = ".github/workflows/release.yml",
) {
  return Response.json({
    head_sha: "a".repeat(40),
    path,
    run_attempt: 2,
    event: "push",
    head_branch: "refs/tags/v1.0.0",
    actor: { login: "octo-actor" },
    triggering_actor: { login: "octo-triggerer" },
    referenced_workflows: referenced.map((item) => ({
      path: `${item.path}@${item.ref}`,
      sha: item.sha,
      ref: item.ref,
    })),
  });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("fetchReleaseAuthoritySources", () => {
  it("reads the entry workflow at the run's own commit", async () => {
    const seen = mockGithub((url) => {
      if (url.pathname.endsWith("/actions/runs/4242")) return runResponse();
      if (url.pathname.includes("/contents/")) return new Response(WORKFLOW);
      throw new Error(`unexpected ${url}`);
    });

    const sources = await fetchReleaseAuthoritySourcesWithToken("ghs_token", INPUT);

    expect(sources.run).toMatchObject({
      repositoryFullName: "octo/example",
      environment: "pypi",
      runId: 4242,
      runAttempt: 2,
      workflowPath: ".github/workflows/release.yml",
      headSha: "a".repeat(40),
      event: "push",
      actor: "octo-actor",
      triggeringActor: "octo-triggerer",
    });
    expect(sources.unresolved).toEqual([]);
    expect(sources.workflows).toHaveLength(1);
    expect(sources.workflows[0]).toMatchObject({
      path: ".github/workflows/release.yml",
      role: "entry",
      sha: "a".repeat(40),
      documentComplete: true,
    });

    // Pinned to the run's commit, not to the tip of the default branch: a later
    // edit must not rewrite what this release was authorized by.
    const contents = seen.find((entry) => entry.url.includes("/contents/"));
    expect(contents?.url).toContain(`ref=${"a".repeat(40)}`);
  });

  it("reads a repository-qualified entry workflow from its owning repository", async () => {
    const resolvedSha = "b".repeat(40);
    const seen = mockGithub((url) => {
      if (url.pathname.endsWith("/actions/runs/4242")) {
        return runResponse(
          [
            {
              path: "octo/shared/.github/workflows/release.yml",
              sha: resolvedSha,
              ref: "refs/heads/main",
            },
          ],
          "octo/shared/.github/workflows/release.yml@refs/heads/main",
        );
      }
      if (url.pathname === "/repos/octo/shared/contents/.github/workflows/release.yml") {
        return new Response(WORKFLOW);
      }
      throw new Error(`unexpected ${url}`);
    });

    const sources = await fetchReleaseAuthoritySourcesWithToken("ghs_token", INPUT);

    expect(sources.run.workflowPath).toBe("octo/shared/.github/workflows/release.yml");
    expect(sources.unresolved).toEqual([]);
    expect(sources.workflows).toEqual([
      expect.objectContaining({
        path: "octo/shared/.github/workflows/release.yml",
        repositoryFullName: "octo/shared",
        role: "entry",
        ref: resolvedSha,
        sha: resolvedSha,
      }),
    ]);
    const contents = seen.find((entry) => entry.url.includes("/contents/"));
    expect(contents?.url).toContain("/repos/octo/shared/contents/.github/workflows/release.yml");
    expect(contents?.url).toContain(`ref=${resolvedSha}`);
    expect(contents?.url).not.toContain(`ref=${"a".repeat(40)}`);
  });

  it("falls back to a repository-qualified entry workflow's own ref", async () => {
    const seen = mockGithub((url) => {
      if (url.pathname.endsWith("/actions/runs/4242")) {
        return runResponse([], "octo/shared/.github/workflows/release.yml@refs/heads/main");
      }
      if (url.pathname === "/repos/octo/shared/contents/.github/workflows/release.yml") {
        return new Response(WORKFLOW);
      }
      throw new Error(`unexpected ${url}`);
    });

    const sources = await fetchReleaseAuthoritySourcesWithToken("ghs_token", INPUT);

    expect(sources.workflows[0]).toMatchObject({
      ref: "refs/heads/main",
      sha: null,
    });
    const contents = seen.find((entry) => entry.url.includes("/contents/"));
    expect(contents?.url).toContain("ref=refs%2Fheads%2Fmain");
    expect(contents?.url).not.toContain(`ref=${"a".repeat(40)}`);
  });

  it.each([
    ["./actions/publish", "actions/publish"],
    ["$/.github/actions/publish", ".github/actions/publish"],
  ])(
    "binds local action %s to its complete directory tree at the run commit",
    async (uses, actionPath) => {
      const workflow = `on: push
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: ${uses}
`;
      const seen = mockGithub((url) => {
        if (url.pathname.endsWith("/actions/runs/4242")) return runResponse();
        if (url.pathname.endsWith("/contents/.github/workflows/release.yml")) {
          return new Response(workflow);
        }
        if (url.pathname.endsWith(`/contents/${actionPath}`)) {
          return Response.json([
            { path: `${actionPath}/action.yml`, sha: "b".repeat(40), type: "file" },
            { path: `${actionPath}/dist`, sha: "c".repeat(40), type: "dir" },
          ]);
        }
        throw new Error(`unexpected ${url}`);
      });

      const sources = await fetchReleaseAuthoritySourcesWithToken("ghs_token", INPUT);

      expect(sources.unresolved).toEqual([]);
      expect(sources.workflows[0].localActionDigests?.[uses]).toMatch(/^[0-9a-f]{64}$/);
      const actionRequest = seen.find((entry) => entry.url.includes(`/contents/${actionPath}`));
      expect(actionRequest?.url).toContain(`ref=${"a".repeat(40)}`);
    },
  );

  it("marks local-action coverage incomplete when its directory cannot be read", async () => {
    const workflow = `on: push
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: ./actions/publish
`;
    mockGithub((url) => {
      if (url.pathname.endsWith("/actions/runs/4242")) return runResponse();
      if (url.pathname.endsWith("/contents/.github/workflows/release.yml")) {
        return new Response(workflow);
      }
      return new Response("Not Found", { status: 404 });
    });

    const sources = await fetchReleaseAuthoritySourcesWithToken("ghs_token", INPUT);

    expect(sources.unresolved).toEqual([
      {
        path: ".github/workflows/release.yml -> ./actions/publish",
        reason: "not_accessible",
      },
    ]);
  });

  it("resolves the reusable-workflow graph GitHub already pinned", async () => {
    mockGithub((url) => {
      if (url.pathname.endsWith("/actions/runs/4242")) {
        return runResponse([
          {
            path: "octo/shared/.github/workflows/publish.yml",
            sha: "b".repeat(40),
            ref: "refs/heads/main",
          },
        ]);
      }
      if (url.pathname.includes("/contents/")) return new Response(WORKFLOW);
      throw new Error(`unexpected ${url}`);
    });

    const sources = await fetchReleaseAuthoritySourcesWithToken("ghs_token", INPUT);
    expect(sources.workflows).toHaveLength(2);
    const reused = sources.workflows.find((workflow) => workflow.role === "referenced");
    // Repo-qualified so two repositories shipping the same file name stay
    // distinct in the snapshot.
    expect(reused).toMatchObject({
      path: "octo/shared/.github/workflows/publish.yml",
      repositoryFullName: "octo/shared",
      sha: "b".repeat(40),
    });
  });

  it("records an inaccessible reusable workflow as coverage, not as absence", async () => {
    mockGithub((url) => {
      if (url.pathname.endsWith("/actions/runs/4242")) {
        return runResponse([
          {
            path: "other/private/.github/workflows/publish.yml",
            sha: "c".repeat(40),
            ref: "main",
          },
        ]);
      }
      if (url.pathname.startsWith("/repos/octo/example/contents/")) return new Response(WORKFLOW);
      return new Response("Not Found", { status: 404 });
    });

    const sources = await fetchReleaseAuthoritySourcesWithToken("ghs_token", INPUT);
    expect(sources.workflows).toHaveLength(1);
    expect(sources.unresolved).toEqual([
      { path: "other/private/.github/workflows/publish.yml", reason: "not_accessible" },
    ]);
  });

  it("records unsupported YAML authority as unparseable coverage", async () => {
    mockGithub((url) => {
      if (url.pathname.endsWith("/actions/runs/4242")) return runResponse();
      if (url.pathname.includes("/contents/")) {
        return new Response("permissions: *defaults\n");
      }
      throw new Error(`unexpected ${url}`);
    });

    const sources = await fetchReleaseAuthoritySourcesWithToken("ghs_token", INPUT);
    expect(sources.workflows).toEqual([]);
    expect(sources.unresolved).toEqual([
      { path: ".github/workflows/release.yml", reason: "unparseable" },
    ]);
  });

  it("refuses a referenced path outside .github/workflows without fetching it", async () => {
    const seen = mockGithub((url) => {
      if (url.pathname.endsWith("/actions/runs/4242")) {
        return runResponse([
          { path: "octo/shared/secrets/id_rsa", sha: "c".repeat(40), ref: "main" },
        ]);
      }
      if (url.pathname.startsWith("/repos/octo/example/contents/")) return new Response(WORKFLOW);
      throw new Error(`unexpected ${url}`);
    });

    const sources = await fetchReleaseAuthoritySourcesWithToken("ghs_token", INPUT);
    expect(sources.unresolved).toEqual([
      { path: "octo/shared/secrets/id_rsa", reason: "not_accessible" },
    ]);
    // A hostile `referenced_workflows` entry must not turn this into a
    // general-purpose repository file reader.
    expect(seen.some((entry) => entry.url.includes("secrets/id_rsa"))).toBe(false);
  });

  it("keeps the installation token on api.github.com and never follows a redirect", async () => {
    const seen = mockGithub((url) => {
      if (url.pathname.endsWith("/actions/runs/4242")) return runResponse();
      if (url.pathname.includes("/contents/")) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://evil.test/workflow.yml" },
        });
      }
      throw new Error(`unexpected ${url}`);
    });

    const sources = await fetchReleaseAuthoritySourcesWithToken("ghs_token", INPUT);
    expect(sources.workflows).toEqual([]);
    expect(sources.unresolved).toEqual([
      { path: ".github/workflows/release.yml", reason: "fetch_failed" },
    ]);
    expect(seen.every((entry) => new URL(entry.url).host === "api.github.com")).toBe(true);
    expect(seen.every((entry) => entry.authorization === "Bearer ghs_token")).toBe(true);
  });

  it("degrades to an empty graph when the run cannot be read", async () => {
    mockGithub(() => new Response("Not Found", { status: 404 }));
    const sources = await fetchReleaseAuthoritySourcesWithToken("ghs_token", INPUT);
    expect(sources.workflows).toEqual([]);
    expect(sources.unresolved).toEqual([{ path: "run/4242", reason: "fetch_failed" }]);
    expect(sources.run.workflowPath).toBeNull();
  });

  it("rejects a repository name that is not owner/repo", async () => {
    const seen = mockGithub(() => new Response("unreachable"));
    const sources = await fetchReleaseAuthoritySourcesWithToken("ghs_token", {
      ...INPUT,
      repositoryFullName: "not-a-repo",
    });
    expect(sources.unresolved).toEqual([{ path: "not-a-repo", reason: "not_accessible" }]);
    expect(seen).toEqual([]);
  });
});
