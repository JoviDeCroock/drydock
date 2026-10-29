import { describe, expect, test, vi } from "vitest";
import {
  createSetupPullRequest,
  PublisherSetupError,
  type SetupGithubClient,
} from "../server/lib/github-app/setup-api";
import {
  setupProposal,
  SETUP_BASE_SHA,
  SETUP_BLOB_SHA,
  SETUP_ORIGINAL_WORKFLOW,
  SETUP_PROPOSED_WORKFLOW,
} from "./helpers/publisher-setup-fixtures";

const SCRIPT_PATH = ".github/scripts/release.cjs";
const SCRIPT_CONTENT =
  "// Proposed repository source; never executed by Drydock.\nconsole.log('release archives');\n";
const ORIGINAL_SCRIPT = "// Existing repository source.\n";
const NEW_COMMIT = "c".repeat(40);
const BASE_TREE = "d".repeat(40);
const NEW_TREE = "e".repeat(40);
const HELPER_BLOB = "7".repeat(40);
function fixture(
  options: {
    helper?: "identical" | "different" | "symlink";
    uncertain?: string;
    stale?: boolean;
    initialBranch?: "base" | "proposal";
    extraEdit?: boolean;
    helperEdit?: boolean;
    workflowEdit?: boolean;
    openPr?: boolean;
  } = {},
) {
  const proposal = setupProposal({
    content: SETUP_PROPOSED_WORKFLOW,
    supportingFiles: [
      {
        path: SCRIPT_PATH,
        content: SCRIPT_CONTENT,
        originalSha: options.helper ? HELPER_BLOB : null,
        originalContent: options.helper ? ORIGINAL_SCRIPT : null,
      },
    ],
  });
  const state = {
    branch:
      options.initialBranch === "base"
        ? SETUP_BASE_SHA
        : options.initialBranch === "proposal"
          ? NEW_COMMIT
          : (null as string | null),
    branchName: "",
    pr: options.openPr ? 51 : (null as number | null),
    uncertain: false,
    writes: [] as { suffix: string; body: Record<string, unknown> }[],
  };
  function uncertain(stage: string) {
    if (options.uncertain === stage && !state.uncertain) {
      state.uncertain = true;
      throw new PublisherSetupError("github_unavailable", "GitHub unavailable", 502);
    }
  }
  const request = vi.fn(async (suffix: string, init: RequestInit = {}) => {
    const url = new URL(`https://api.github.com/repos/octo/release${suffix}`);
    if (init.method) {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      state.writes.push({ suffix, body });
      if (suffix === "/git/trees") {
        uncertain("tree");
        return { sha: NEW_TREE };
      }
      if (suffix === "/git/commits") {
        uncertain("commit");
        return { sha: NEW_COMMIT };
      }
      if (suffix === "/git/refs" || suffix.startsWith("/git/refs/heads/")) {
        state.branch = String(body.sha);
        state.branchName = String(body.ref ?? `refs/heads/${state.branchName}`).replace(
          "refs/heads/",
          "",
        );
        uncertain("ref");
        return {};
      }
      if (suffix === "/pulls") {
        state.pr = 51;
        uncertain("pull");
        return { number: 51 };
      }
      throw new Error("Unexpected mutation");
    }
    if (url.pathname.endsWith("/pulls")) {
      state.branchName = (url.searchParams.get("head") ?? "").slice("octo:".length);
      return state.pr
        ? [
            {
              number: state.pr,
              head: { ref: state.branchName, repo: { id: 42 } },
              base: { ref: "main", repo: { id: 42 } },
            },
          ]
        : [];
    }
    if (suffix === "/git/ref/heads/main")
      return { object: { sha: options.stale ? "9".repeat(40) : SETUP_BASE_SHA } };
    if (suffix.startsWith("/git/ref/heads/"))
      return state.branch ? { object: { sha: state.branch } } : null;
    if (suffix.startsWith("/git/commits/")) {
      const sha = suffix.split("/").at(-1);
      return { sha, tree: { sha: sha === NEW_COMMIT ? NEW_TREE : BASE_TREE } };
    }
    if (suffix.startsWith("/git/trees/")) {
      const sha = suffix.split("/").at(-1);
      let tree: Record<string, unknown>[] = [];
      if (sha === BASE_TREE || sha === NEW_TREE)
        tree = [
          {
            path: ".github",
            type: "tree",
            mode: "040000",
            sha: sha === NEW_TREE ? "4".repeat(40) : "1".repeat(40),
          },
        ];
      if (sha === "1".repeat(40) || sha === "4".repeat(40))
        tree = [
          {
            path: "workflows",
            type: "tree",
            mode: "040000",
            sha: sha === "4".repeat(40) ? "5".repeat(40) : "2".repeat(40),
          },
          ...(options.helper || sha === "4".repeat(40)
            ? [
                {
                  path: "scripts",
                  type: "tree",
                  mode: "040000",
                  sha: sha === "4".repeat(40) ? "6".repeat(40) : "3".repeat(40),
                },
              ]
            : []),
        ];
      if (sha === "2".repeat(40) || sha === "5".repeat(40))
        tree = [
          {
            path: "release.yml",
            type: "blob",
            mode: "100644",
            sha: sha === "5".repeat(40) ? "f".repeat(40) : SETUP_BLOB_SHA,
          },
        ];
      if (sha === "3".repeat(40) || sha === "6".repeat(40))
        tree = (
          sha === "6".repeat(40) ? (proposal.supportingFiles ?? []) : [{ path: SCRIPT_PATH }]
        ).map((file) => ({
          path: file.path.split("/").at(-1),
          type: "blob",
          mode: options.helper === "symlink" ? "120000" : "100644",
          sha: HELPER_BLOB,
        }));
      return { tree, truncated: false };
    }
    if (suffix.startsWith("/contents/")) {
      const path = decodeURIComponent(url.pathname.split("/contents/")[1] ?? "");
      const file = proposal.supportingFiles?.find((entry) => entry.path === path);
      const newRevision = url.searchParams.get("ref") === NEW_COMMIT;
      const content = file
        ? options.helper === "different" || (newRevision && options.helperEdit)
          ? "unrelated existing helper"
          : newRevision
            ? file.content
            : (file.originalContent ?? "")
        : newRevision
          ? options.workflowEdit
            ? `${proposal.content}\n# contributor edit`
            : proposal.content
          : SETUP_ORIGINAL_WORKFLOW;
      return {
        path,
        type: "file",
        sha: file ? HELPER_BLOB : newRevision ? "f".repeat(40) : SETUP_BLOB_SHA,
        encoding: "base64",
        size: Buffer.byteLength(content),
        content: Buffer.from(content).toString("base64"),
      };
    }
    if (suffix.startsWith("/compare/"))
      return {
        files: [
          ...(proposal.content === SETUP_ORIGINAL_WORKFLOW
            ? []
            : [{ filename: proposal.workflowPath }]),
          ...(proposal.supportingFiles ?? []).map((file) => ({ filename: file.path })),
          ...(options.extraEdit ? [{ filename: "README.md" }] : []),
        ],
      };
    throw new Error("Unexpected read");
  });
  const client = {
    repository: { id: 42, fullName: "octo/release", defaultBranch: "main" },
    request,
  } as unknown as SetupGithubClient;
  return { client, request, proposal, state };
}

describe("publisher setup atomic supporting file PRs", () => {
  test("creates the branch at the reviewed base, then moves it to the one proposal commit", async () => {
    const { client, proposal, state } = fixture();
    const hook = vi.fn(async () => {});
    const result = await createSetupPullRequest(client, proposal, hook);
    expect(result).toMatchObject({ number: 51, created: true });
    expect(state.writes.map((write) => write.suffix)).toEqual([
      "/git/trees",
      "/git/commits",
      "/git/refs",
      expect.stringMatching(/^\/git\/refs\/heads\//),
      "/pulls",
    ]);
    expect(state.writes[0]?.body).toEqual({
      base_tree: BASE_TREE,
      tree: [
        { path: proposal.workflowPath, mode: "100644", type: "blob", content: proposal.content },
        { path: SCRIPT_PATH, mode: "100644", type: "blob", content: SCRIPT_CONTENT },
      ],
    });
    expect(state.writes[1]?.body).toMatchObject({ tree: NEW_TREE, parents: [SETUP_BASE_SHA] });
    expect(state.writes[2]?.body.sha).toBe(SETUP_BASE_SHA);
    expect(state.writes[3]?.body).toEqual({ sha: NEW_COMMIT, force: false });
    expect(state.writes[4]?.body.draft).toBe(true);
    expect(state.writes[4]?.body.body).toContain("```text\n");
    expect(hook).toHaveBeenCalledTimes(5);
  });
  test("edits an existing file only after its exact pinned before-content and blob identity match", async () => {
    const { client, proposal, state } = fixture({ helper: "identical" });
    await createSetupPullRequest(client, proposal);
    expect(state.writes[0]?.body.tree as unknown[]).toHaveLength(2);
    expect((await createSetupPullRequest(client, proposal)).created).toBe(false);
    expect(state.writes.filter((write) => write.suffix === "/pulls")).toHaveLength(1);
  });
  test("allows a supporting-file-only fix while verifying and retaining the selected workflow", async () => {
    const { client, proposal, state } = fixture();
    proposal.content = SETUP_ORIGINAL_WORKFLOW;
    await createSetupPullRequest(client, proposal);
    expect(state.writes[0]?.body.tree).toEqual([
      { path: SCRIPT_PATH, mode: "100644", type: "blob", content: SCRIPT_CONTENT },
    ]);
    expect((await createSetupPullRequest(client, proposal)).created).toBe(false);
  });
  test("writes and recovers several arbitrary safe file paths with before/after content", async () => {
    const { client, proposal, state } = fixture({ helper: "identical" });
    proposal.supportingFiles!.push({
      path: ".github/scripts/second script.mjs",
      content: "// proposed second script",
      originalSha: null,
      originalContent: null,
    });
    await createSetupPullRequest(client, proposal);
    expect(state.writes[0]?.body.tree as unknown[]).toHaveLength(3);
    expect((await createSetupPullRequest(client, proposal)).created).toBe(false);
    expect(state.writes.filter((write) => write.suffix === "/pulls")).toHaveLength(1);
  });
  test.each([
    { helper: "different" as const, code: "proposal_stale" },
    { helper: "symlink" as const, code: "proposal_file_conflict" },
  ])(
    "refuses mismatched or symlink source files before writing: $code",
    async ({ helper, code }) => {
      const { client, proposal, state } = fixture({ helper });
      await expect(createSetupPullRequest(client, proposal)).rejects.toMatchObject({ code });
      expect(state.writes).toEqual([]);
    },
  );
  test.each(["tree", "commit", "ref", "pull"])(
    "recovers uncertainty after %s without duplicate PRs or a partial workflow branch",
    async (uncertain) => {
      const { client, proposal, state } = fixture({ uncertain });
      await expect(createSetupPullRequest(client, proposal)).rejects.toMatchObject({
        code: "github_unavailable",
      });
      if (uncertain === "tree" || uncertain === "commit") expect(state.branch).toBeNull();
      expect((await createSetupPullRequest(client, proposal)).number).toBe(51);
      expect(state.writes.filter((write) => write.suffix === "/pulls")).toHaveLength(1);
      expect(state.writes.filter((write) => write.suffix === "/git/refs")).toHaveLength(1);
    },
  );
  test("only advances an existing base ref without force after building the complete commit", async () => {
    const { client, proposal, state } = fixture({ initialBranch: "base" });
    await createSetupPullRequest(client, proposal);
    expect(state.writes[2]?.suffix).toContain("/git/refs/heads/");
    expect(state.writes[2]?.body).toEqual({ sha: NEW_COMMIT, force: false });
  });
  test.each([false, true])(
    "does not recover contributor edits even when openPr=%s",
    async (openPr) => {
      const { client, proposal, state } = fixture({
        initialBranch: "proposal",
        extraEdit: true,
        openPr,
      });
      await expect(createSetupPullRequest(client, proposal)).rejects.toMatchObject({
        code: "proposal_branch_changed",
      });
      expect(state.writes).toEqual([]);
    },
  );
  test.each([false, true])(
    "one-file recovery verifies contributor workflow edits even when openPr=%s",
    async (openPr) => {
      const { client, proposal, state } = fixture({
        initialBranch: "proposal",
        workflowEdit: true,
        openPr,
      });
      proposal.supportingFiles = undefined;
      await expect(createSetupPullRequest(client, proposal)).rejects.toMatchObject({
        code: "proposal_branch_changed",
      });
      expect(state.writes).toEqual([]);
    },
  );
  test("one-file existing PR recovery verifies bytes without making another mutation", async () => {
    const { client, proposal, state } = fixture({ initialBranch: "proposal", openPr: true });
    proposal.supportingFiles = undefined;
    expect((await createSetupPullRequest(client, proposal)).created).toBe(false);
    expect(state.writes).toEqual([]);
  });
  test("changed helper contents are never overwritten during recovery", async () => {
    const { client, proposal, state } = fixture({ initialBranch: "proposal", helperEdit: true });
    await expect(createSetupPullRequest(client, proposal)).rejects.toBeInstanceOf(
      PublisherSetupError,
    );
    expect(state.writes).toEqual([]);
  });
  test.each([1, 2, 3, 4])("rechecks authority before GitHub mutation %s", async (deniedAt) => {
    const { client, proposal, state } = fixture();
    let checks = 0;
    await expect(
      createSetupPullRequest(client, proposal, async () => {
        if (++checks === deniedAt)
          throw new PublisherSetupError("setup_access_changed", "Access revoked", 403);
      }),
    ).rejects.toMatchObject({ code: "setup_access_changed" });
    expect(state.writes).toHaveLength(deniedAt - 1);
    expect(state.writes.some((write) => write.suffix === "/pulls")).toBe(false);
  });
  test("rejects stale source commit or helper blob identity before writes", async () => {
    const stale = fixture({ stale: true });
    await expect(createSetupPullRequest(stale.client, stale.proposal)).rejects.toMatchObject({
      code: "proposal_stale",
    });
    expect(stale.state.writes).toEqual([]);
    const changed = fixture({ helper: "identical" });
    changed.proposal.supportingFiles![0]!.originalSha = "8".repeat(40);
    await expect(createSetupPullRequest(changed.client, changed.proposal)).rejects.toMatchObject({
      code: "proposal_stale",
    });
    expect(changed.state.writes).toEqual([]);
  });
  test("rejects unsafe, duplicate, oversized, inconsistent or unchanged proposed edits before GitHub reads", async () => {
    for (const mutation of [
      "path",
      "bytes",
      "extra",
      "duplicate-workflow",
      "null-before",
      "unchanged",
      "ancestor",
      "too-many",
    ]) {
      const { client, proposal, request } = fixture();
      if (mutation === "path") proposal.supportingFiles![0]!.path = "../outside.cjs";
      if (mutation === "bytes") proposal.supportingFiles![0]!.content = "x".repeat(65_537);
      if (mutation === "extra") proposal.supportingFiles!.push(proposal.supportingFiles![0]!);
      if (mutation === "duplicate-workflow")
        proposal.supportingFiles![0]!.path = proposal.workflowPath;
      if (mutation === "null-before")
        proposal.supportingFiles![0]!.originalContent = "unexpected existing file";
      if (mutation === "unchanged") {
        proposal.supportingFiles![0]!.originalContent = SCRIPT_CONTENT;
        proposal.supportingFiles![0]!.originalSha = HELPER_BLOB;
      }
      if (mutation === "ancestor") proposal.supportingFiles![0]!.path = ".github";
      if (mutation === "too-many")
        proposal.supportingFiles = Array.from({ length: 13 }, (_, index) => ({
          path: `scripts/file${index}.js`,
          content: "text",
          originalContent: null,
          originalSha: null,
        }));
      await expect(createSetupPullRequest(client, proposal)).rejects.toMatchObject({
        code: "proposal_invalid",
      });
      expect(request).not.toHaveBeenCalled();
    }
  });
});
