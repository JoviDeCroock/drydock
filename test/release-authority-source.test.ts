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
  referenced: Array<{ path: string; sha?: string; ref: string }> = [],
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

  it("does not treat a repository-qualified entry's moving ref as historical evidence", async () => {
    const seen = mockGithub((url) => {
      if (url.pathname.endsWith("/actions/runs/4242")) {
        return runResponse([], "octo/shared/.github/workflows/release.yml@refs/heads/main");
      }
      throw new Error(`unexpected ${url}`);
    });

    const sources = await fetchReleaseAuthoritySourcesWithToken("ghs_token", INPUT);

    expect(sources.workflows).toEqual([]);
    expect(sources.unresolved).toEqual([
      { path: "octo/shared/.github/workflows/release.yml", reason: "not_accessible" },
    ]);
    expect(seen.some((entry) => entry.url.includes("/contents/"))).toBe(false);
  });

  it("does not fetch a referenced workflow without an immutable revision", async () => {
    const seen = mockGithub((url) => {
      if (url.pathname.endsWith("/actions/runs/4242")) {
        return runResponse([
          {
            path: "octo/shared/.github/workflows/publish.yml",
            ref: "refs/heads/main",
          },
        ]);
      }
      if (url.pathname.startsWith("/repos/octo/example/contents/")) return new Response(WORKFLOW);
      throw new Error(`unexpected ${url}`);
    });

    const sources = await fetchReleaseAuthoritySourcesWithToken("ghs_token", INPUT);

    expect(sources.workflows).toHaveLength(1);
    expect(sources.unresolved).toEqual([
      { path: "octo/shared/.github/workflows/publish.yml", reason: "not_accessible" },
    ]);
    expect(seen.some((entry) => entry.url.includes("/repos/octo/shared/contents/"))).toBe(false);
  });

  it.each([
    ["./actions/publish", "actions/publish"],
    ["$/.github/actions/publish", ".github/actions/publish"],
  ])(
    "binds local action %s to its complete directory tree at the run commit",
    async (uses, actionPath) => {
      const actionSegments = actionPath.split("/");
      const treeShas = ["b", "c", "d", "e"].map((character) => character.repeat(40));
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
        if (url.pathname.endsWith(`/git/commits/${"a".repeat(40)}`)) {
          return Response.json({ tree: { sha: treeShas[0] } });
        }
        const treeIndex = treeShas.findIndex((sha) => url.pathname.endsWith(`/git/trees/${sha}`));
        if (treeIndex >= 0 && treeIndex < actionSegments.length) {
          return Response.json({
            truncated: false,
            tree: [
              {
                path: actionSegments[treeIndex],
                mode: "040000",
                type: "tree",
                sha: treeShas[treeIndex + 1],
              },
            ],
          });
        }
        if (treeIndex === actionSegments.length) {
          return Response.json({
            truncated: false,
            tree: [{ path: "action.yml", mode: "100644", type: "blob", sha: "f".repeat(40) }],
          });
        }
        throw new Error(`unexpected ${url}`);
      });

      const sources = await fetchReleaseAuthoritySourcesWithToken("ghs_token", INPUT);

      expect(sources.unresolved).toEqual([]);
      expect(sources.workflows[0].localActionDigests?.[uses]).toMatch(/^[0-9a-f]{64}$/);
      expect(seen.some((entry) => entry.url.endsWith(`/git/commits/${"a".repeat(40)}`))).toBe(true);
    },
  );

  it("changes a local-action digest when Git's directory identity changes", async () => {
    const workflow = `on: push
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: ./action
`;
    const digestForTree = async (actionTreeSha: string) => {
      mockGithub((url) => {
        if (url.pathname.endsWith("/actions/runs/4242")) return runResponse();
        if (url.pathname.endsWith("/contents/.github/workflows/release.yml")) {
          return new Response(workflow);
        }
        if (url.pathname.endsWith(`/git/commits/${"a".repeat(40)}`)) {
          return Response.json({ tree: { sha: "b".repeat(40) } });
        }
        if (url.pathname.endsWith(`/git/trees/${"b".repeat(40)}`)) {
          return Response.json({
            truncated: false,
            tree: [{ path: "action", mode: "040000", type: "tree", sha: actionTreeSha }],
          });
        }
        if (url.pathname.endsWith(`/git/trees/${actionTreeSha}`)) {
          return Response.json({
            truncated: false,
            tree: [
              {
                path: "action.yml",
                mode: actionTreeSha === "c".repeat(40) ? "100644" : "100755",
                type: "blob",
                sha: "e".repeat(40),
              },
            ],
          });
        }
        throw new Error(`unexpected ${url}`);
      });
      const sources = await fetchReleaseAuthoritySourcesWithToken("ghs_token", INPUT);
      return sources.workflows[0].localActionDigests?.["./action"];
    };

    // Git computes a different directory tree SHA when an immediate child's
    // mode changes from 100644 to 100755 even if its blob SHA is unchanged.
    const nonExecutable = await digestForTree("c".repeat(40));
    const executable = await digestForTree("d".repeat(40));

    expect(nonExecutable).toMatch(/^[0-9a-f]{64}$/);
    expect(executable).toMatch(/^[0-9a-f]{64}$/);
    expect(executable).not.toBe(nonExecutable);
  });

  it("reuses Git objects shared by multiple local actions", async () => {
    const workflow = `on: push
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: ./actions/one
      - uses: ./actions/two
`;
    const rootTree = "b".repeat(40);
    const actionsTree = "c".repeat(40);
    const firstTree = "d".repeat(40);
    const secondTree = "e".repeat(40);
    const seen = mockGithub((url) => {
      if (url.pathname.endsWith("/actions/runs/4242")) return runResponse();
      if (url.pathname.endsWith("/contents/.github/workflows/release.yml")) {
        return new Response(workflow);
      }
      if (url.pathname.endsWith(`/git/commits/${"a".repeat(40)}`)) {
        return Response.json({ tree: { sha: rootTree } });
      }
      if (url.pathname.endsWith(`/git/trees/${rootTree}`)) {
        return Response.json({
          tree: [{ path: "actions", mode: "040000", type: "tree", sha: actionsTree }],
        });
      }
      if (url.pathname.endsWith(`/git/trees/${actionsTree}`)) {
        return Response.json({
          tree: [
            { path: "one", mode: "040000", type: "tree", sha: firstTree },
            { path: "two", mode: "040000", type: "tree", sha: secondTree },
          ],
        });
      }
      if (
        url.pathname.endsWith(`/git/trees/${firstTree}`) ||
        url.pathname.endsWith(`/git/trees/${secondTree}`)
      ) {
        return Response.json({
          tree: [{ path: "action.yml", mode: "100644", type: "blob", sha: "f".repeat(40) }],
        });
      }
      throw new Error(`unexpected ${url}`);
    });

    const sources = await fetchReleaseAuthoritySourcesWithToken("ghs_token", INPUT);

    expect(sources.unresolved).toEqual([]);
    expect(Object.keys(sources.workflows[0].localActionDigests ?? {})).toEqual([
      "./actions/one",
      "./actions/two",
    ]);
    expect(seen.filter((entry) => entry.url.endsWith(`/git/trees/${rootTree}`))).toHaveLength(1);
    expect(seen.filter((entry) => entry.url.endsWith(`/git/trees/${actionsTree}`))).toHaveLength(1);
  });

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
