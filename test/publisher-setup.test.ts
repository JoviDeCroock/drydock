import { afterEach, describe, expect, test, vi } from "vitest";
import {
  setupDraftRequestSchema,
  signSetupProposal,
  verifySetupProposal,
} from "../server/lib/github-app/setup-draft";
import {
  createSetupClient,
  createSetupPullRequest,
  inspectPublisherSetup,
  type SetupGithubClient,
} from "../server/lib/github-app/setup-api";
import type { GithubAppConfig } from "../server/lib/github-app/config";
import {
  SETUP_BASE_SHA,
  SETUP_BLOB_SHA,
  SETUP_DRAFT_REQUEST,
  SETUP_ORIGINAL_WORKFLOW,
  setupProposal,
} from "./helpers/publisher-setup-fixtures";

vi.mock("../server/lib/github-app/jwt", () => ({
  generateGithubAppJwt: vi.fn(async () => "test-jwt"),
}));
afterEach(() => vi.unstubAllGlobals());
const config: GithubAppConfig = {
  appId: "123",
  appSlug: "drydock",
  clientId: "client",
  clientSecret: "secret",
  privateKeyPem: "unused",
  webhookSecret: "unused",
  stateSecret: "test-state-secret",
};

function client(request: SetupGithubClient["request"]): SetupGithubClient {
  return {
    repository: { id: 42, fullName: "octo/release", defaultBranch: "main" },
    path: "/repos/octo/release",
    request,
  };
}

const CURRENT_HEAD = "c".repeat(40);
function recoveryEvidence(suffix: string, proposal = setupProposal()): unknown {
  const ids = {
    base: "d".repeat(40),
    current: "e".repeat(40),
    ghBase: "f".repeat(40),
    ghCurrent: "1".repeat(40),
    workflowsBase: "2".repeat(40),
    workflowsCurrent: "3".repeat(40),
    currentBlob: "4".repeat(40),
  };
  if (suffix === `/git/commits/${SETUP_BASE_SHA}`)
    return { sha: SETUP_BASE_SHA, tree: { sha: ids.base } };
  if (suffix === `/git/commits/${CURRENT_HEAD}`)
    return { sha: CURRENT_HEAD, tree: { sha: ids.current } };
  if (suffix === `/git/trees/${ids.base}` || suffix === `/git/trees/${ids.current}`)
    return {
      truncated: false,
      tree: [
        {
          path: ".github",
          type: "tree",
          mode: "040000",
          sha: suffix.endsWith(ids.base) ? ids.ghBase : ids.ghCurrent,
        },
      ],
    };
  if (suffix === `/git/trees/${ids.ghBase}` || suffix === `/git/trees/${ids.ghCurrent}`)
    return {
      truncated: false,
      tree: [
        {
          path: "workflows",
          type: "tree",
          mode: "040000",
          sha: suffix.endsWith(ids.ghBase) ? ids.workflowsBase : ids.workflowsCurrent,
        },
      ],
    };
  if (
    suffix === `/git/trees/${ids.workflowsBase}` ||
    suffix === `/git/trees/${ids.workflowsCurrent}`
  )
    return {
      truncated: false,
      tree: [
        {
          path: "release.yml",
          type: "blob",
          mode: "100644",
          sha: suffix.endsWith(ids.workflowsBase) ? SETUP_BLOB_SHA : ids.currentBlob,
        },
      ],
    };
  if (
    suffix === `/contents/${proposal.workflowPath}?ref=${SETUP_BASE_SHA}` ||
    suffix === `/contents/${proposal.workflowPath}?ref=${CURRENT_HEAD}`
  ) {
    const original = suffix.endsWith(SETUP_BASE_SHA);
    const content = original ? SETUP_ORIGINAL_WORKFLOW : proposal.content;
    return {
      type: "file",
      path: proposal.workflowPath,
      sha: original ? SETUP_BLOB_SHA : ids.currentBlob,
      size: content.length,
      content: btoa(content),
      encoding: "base64",
    };
  }
  return undefined;
}

function uncertainSetupClient(failAfter: "branch" | "file" | "pr" | null = null) {
  const proposal = setupProposal();
  const state = { branch: "", head: SETUP_BASE_SHA, opened: false, extraEdits: false };
  const writes: string[] = [];
  let failed = false;
  const request = vi.fn(async (suffix: string, init?: RequestInit) => {
    if (suffix.startsWith("/pulls?"))
      return state.opened
        ? [
            {
              number: 12,
              head: { ref: state.branch, repo: { id: 42 } },
              base: { ref: "main", repo: { id: 42 } },
            },
          ]
        : [];
    if (suffix === "/git/ref/heads/main") return { object: { sha: SETUP_BASE_SHA } };
    if (suffix.startsWith("/git/ref/heads/"))
      return state.branch ? { object: { sha: state.head } } : null;
    if (suffix.startsWith("/compare/"))
      return {
        files: [
          { filename: proposal.workflowPath },
          ...(state.extraEdits ? [{ filename: "other.yml" }] : []),
        ],
      };
    const evidence = recoveryEvidence(suffix, proposal);
    if (evidence !== undefined) return evidence;
    if (suffix.includes("?ref=")) {
      const original = suffix.endsWith(`?ref=${SETUP_BASE_SHA}`);
      const content = original ? SETUP_ORIGINAL_WORKFLOW : proposal.content;
      return {
        type: "file",
        path: proposal.workflowPath,
        sha: SETUP_BLOB_SHA,
        size: content.length,
        content: btoa(content),
        encoding: "base64",
      };
    }
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    writes.push(suffix);
    const mutation = suffix === "/git/refs" ? "branch" : suffix === "/pulls" ? "pr" : "file";
    if (mutation === "branch") state.branch = String(body.ref).slice("refs/heads/".length);
    if (mutation === "file") state.head = "c".repeat(40);
    if (mutation === "pr") state.opened = true;
    if (mutation === failAfter && !failed) {
      failed = true;
      throw new Error("The write completed but its response was lost.");
    }
    return mutation === "pr" ? { number: 12 } : {};
  });
  return { client: client(request), proposal, state, writes };
}

describe("publisher setup proposal", () => {
  test("bounds environment and workflow input", () => {
    expect(
      setupDraftRequestSchema.safeParse({
        ...SETUP_DRAFT_REQUEST,
        workflowPath: "../../secrets.yml",
      }).success,
    ).toBe(false);
    expect(
      setupDraftRequestSchema.safeParse({ ...SETUP_DRAFT_REQUEST, environment: "prod\nuction" })
        .success,
    ).toBe(false);
    expect(
      setupDraftRequestSchema.parse({ ...SETUP_DRAFT_REQUEST, environment: " Production " })
        .environment,
    ).toBe("production");
  });
  test("binds proposals to purpose, content, organization, user, and expiry", async () => {
    const proposal = setupProposal();
    const token = await signSetupProposal("secret", proposal, "org-a", "user-a");
    expect(await verifySetupProposal("secret", proposal, token, "org-a", "user-a")).toBe(true);
    expect(await verifySetupProposal("secret", proposal, token, "org-b", "user-a")).toBe(false);
    expect(await verifySetupProposal("secret", proposal, token, "org-a", "user-b")).toBe(false);
    expect(
      await verifySetupProposal(
        "secret",
        { ...proposal, content: "changed" },
        token,
        "org-a",
        "user-a",
      ),
    ).toBe(false);
    expect(
      await verifySetupProposal(
        "secret",
        { ...proposal, expiresAt: Date.now() - 1 },
        token,
        "org-a",
        "user-a",
      ),
    ).toBe(false);
  });
});

describe("publisher setup GitHub boundary", () => {
  test.each(["branch", "file", "pr"] as const)(
    "recovers an uncertain %s write without repeating completed mutations",
    async (failAfter) => {
      const transport = uncertainSetupClient(failAfter);
      await expect(createSetupPullRequest(transport.client, transport.proposal)).rejects.toThrow(
        /response was lost/,
      );
      const result = await createSetupPullRequest(transport.client, transport.proposal);
      expect(result.number).toBe(12);
      expect(result.created).toBe(failAfter !== "pr");
      expect(transport.writes).toEqual([
        "/git/refs",
        `/contents/${transport.proposal.workflowPath}`,
        "/pulls",
      ]);
    },
  );
  test("refuses to resume a partially written branch containing other edits", async () => {
    const transport = uncertainSetupClient("file");
    await expect(createSetupPullRequest(transport.client, transport.proposal)).rejects.toThrow();
    transport.state.extraEdits = true;
    await expect(createSetupPullRequest(transport.client, transport.proposal)).rejects.toThrow(
      /other edits/,
    );
    expect(transport.writes).toEqual(["/git/refs", `/contents/${transport.proposal.workflowPath}`]);
  });
  test.each([1, 2, 3])(
    "authority revoked before mutation %i prevents it and later mutations",
    async (denyAt) => {
      const transport = uncertainSetupClient();
      let attempts = 0;
      const beforeWrite = vi.fn(async () => {
        if (++attempts === denyAt) throw new Error("Setup authority revoked.");
      });
      await expect(
        createSetupPullRequest(transport.client, transport.proposal, beforeWrite),
      ).rejects.toThrow(/authority revoked/);
      expect(beforeWrite).toHaveBeenCalledTimes(denyAt);
      expect(transport.writes).toHaveLength(denyAt - 1);
      expect(transport.state.opened).toBe(false);
    },
  );
  test("requests a single repository and read permissions without following redirects", async () => {
    const calls: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        calls.push(request);
        return request.url.includes("access_tokens")
          ? Response.json({ token: "installation-token" })
          : Response.json({ id: 42, full_name: "octo/release", default_branch: "main" });
      }),
    );
    await createSetupClient(config, "100", "octo/release");
    expect(await calls[0].json()).toEqual({
      repositories: ["release"],
      permissions: { contents: "read", actions: "read" },
    });
    expect(
      calls.every(
        (request) =>
          request.redirect === "manual" && new URL(request.url).hostname === "api.github.com",
      ),
    ).toBe(true);
  });
  test("rejects renamed or foreign repository identity", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes("access_tokens")
          ? Response.json({ token: "installation-token" })
          : Response.json({ id: 42, full_name: "other/release", default_branch: "main" }),
      ),
    );
    await expect(createSetupClient(config, "100", "octo/release")).rejects.toThrow(
      /no accessible default branch/,
    );
  });
  test("sanitizes missing permission errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("secret-upstream-response", { status: 422 })),
    );
    await expect(createSetupClient(config, "100", "octo/release", true)).rejects.toThrow(
      /Contents, Pull requests, and Workflows/,
    );
  });
  test("never fetches a workflow symlink or arbitrary download URL", async () => {
    const request = vi.fn(async (suffix: string) =>
      suffix.includes("git/ref")
        ? { object: { sha: SETUP_BASE_SHA } }
        : suffix.includes("?ref") && suffix.startsWith("/contents/.github/workflows?")
          ? [
              {
                type: "symlink",
                path: ".github/workflows/release.yml",
                download_url: "https://example.invalid",
              },
            ]
          : null,
    );
    expect((await inspectPublisherSetup(client(request), "row")).workflows).toEqual([]);
    expect(request).toHaveBeenCalledTimes(2);
  });
  test("refuses a stale default branch before writing", async () => {
    const request = vi.fn(async (suffix: string, _init?: RequestInit) =>
      suffix.startsWith("/pulls?") ? [] : { object: { sha: "c".repeat(40) } },
    );
    await expect(createSetupPullRequest(client(request), setupProposal())).rejects.toThrow(
      /default branch changed/,
    );
    expect(request.mock.calls.every(([, init]) => (init?.method ?? "GET") === "GET")).toBe(true);
  });
  test("recovers an existing proposal PR only after checking its complete current bytes", async () => {
    const request = vi.fn(async (suffix: string, _init?: RequestInit) => {
      const evidence = recoveryEvidence(suffix);
      if (evidence !== undefined) return evidence;
      if (suffix.startsWith("/git/ref/heads/")) return { object: { sha: CURRENT_HEAD } };
      if (suffix.startsWith("/compare/"))
        return { files: [{ filename: SETUP_DRAFT_REQUEST.workflowPath }] };
      const head = new URL(`https://api.github.com${suffix}`).searchParams
        .get("head")
        ?.split(":")[1];
      return [
        {
          number: 12,
          head: { ref: head, repo: { id: 42 } },
          base: { ref: "main", repo: { id: 42 } },
        },
      ];
    });
    const result = await createSetupPullRequest(client(request), setupProposal());
    expect(result.number).toBe(12);
    expect(result.created).toBe(false);
    expect(request.mock.calls.every(([, init]) => (init?.method ?? "GET") === "GET")).toBe(true);
  });
  test("re-drafted identical content looks up the same branch and only open PRs", async () => {
    const lookups: URLSearchParams[] = [];
    const request = vi.fn(async (suffix: string) => {
      const evidence = recoveryEvidence(suffix);
      if (evidence !== undefined) return evidence;
      if (suffix.startsWith("/git/ref/heads/")) return { object: { sha: CURRENT_HEAD } };
      if (suffix.startsWith("/compare/"))
        return { files: [{ filename: SETUP_DRAFT_REQUEST.workflowPath }] };
      lookups.push(new URL(`https://api.github.com${suffix}`).searchParams);
      return [
        {
          number: 12,
          head: { ref: lookups.at(-1)?.get("head")?.split(":")[1], repo: { id: 42 } },
          base: { ref: "main", repo: { id: 42 } },
        },
      ];
    });
    await createSetupPullRequest(client(request), setupProposal());
    await createSetupPullRequest(
      client(request),
      setupProposal({ expiresAt: Date.now() + 60_000, summary: "Reworded." }),
    );
    expect(lookups[0].get("head")).toBe(lookups[1].get("head"));
    expect(lookups.every((params) => params.get("state") === "open")).toBe(true);
  });
  test("opens a draft PR and the same signed proposal reuses its stable branch", async () => {
    let branch: string | null = null;
    let opened = false;
    const writes: { suffix: string; body: Record<string, unknown> }[] = [];
    const request = vi.fn(async (suffix: string, init?: RequestInit) => {
      if (suffix.startsWith("/pulls?"))
        return opened
          ? [
              {
                number: 12,
                head: { ref: branch, repo: { id: 42 } },
                base: { ref: "main", repo: { id: 42 } },
              },
            ]
          : [];
      if (suffix === "/git/ref/heads/main") return { object: { sha: SETUP_BASE_SHA } };
      if (suffix.startsWith("/git/ref/heads/"))
        return opened ? { object: { sha: CURRENT_HEAD } } : null;
      const evidence = recoveryEvidence(suffix);
      if (evidence !== undefined) return evidence;
      if (suffix.startsWith("/compare/"))
        return { files: [{ filename: SETUP_DRAFT_REQUEST.workflowPath }] };
      if (suffix.includes("?ref="))
        return {
          type: "file",
          path: SETUP_DRAFT_REQUEST.workflowPath,
          sha: SETUP_BLOB_SHA,
          size: SETUP_ORIGINAL_WORKFLOW.length,
          content: btoa(SETUP_ORIGINAL_WORKFLOW),
          encoding: "base64",
        };
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      writes.push({ suffix, body });
      if (suffix === "/git/refs") branch = String(body.ref).slice("refs/heads/".length);
      if (suffix === "/pulls") {
        opened = true;
        return { number: 12 };
      }
      return {};
    });
    const proposal = setupProposal();
    await createSetupPullRequest(client(request), proposal);
    await createSetupPullRequest(client(request), proposal);
    expect(writes).toHaveLength(3);
    expect(writes[1].body.message).toContain("[skip ci]");
    expect(writes[2].body.draft).toBe(true);
  });
});
