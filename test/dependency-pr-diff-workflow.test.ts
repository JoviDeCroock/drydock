import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";
import {
  DEPENDENCY_PR_WORKFLOW,
  publishedDependencyPrWorkflow,
} from "../src/pages/Docs/dependency-pr-workflow";

const REPO_WORKFLOW = readFileSync(
  new URL("../.github/workflows/drydock-diff-link.yml", import.meta.url),
  "utf8",
);
const REPO_CALLER = readFileSync(
  new URL("../.github/workflows/dependency-pr-diff.yml", import.meta.url),
  "utf8",
);
const MARKER = "<!-- drydock:diff-link -->";

function inlineScript(workflow: string): string {
  const lines = workflow.split("\n");
  const start = lines.findIndex((line) => line.trim() === "script: |");
  expect(start).toBeGreaterThan(0);
  const indent = lines[start].indexOf("script:") + 2;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() && line.length - line.trimStart().length < indent) break;
    body.push(line.slice(indent));
  }
  return body.join("\n");
}

const SCRIPT = inlineScript(REPO_WORKFLOW);

interface Run {
  author?: string;
  env?: Record<string, string>;
  commitMessage?: string;
  files?: Array<{ filename: string; status?: string; previous_filename?: string }>;
  contents?: Record<string, string>;
  contentError?: Error;
  comments?: Array<{ id: number; body: string; user: { login: string } }>;
  headRepo?: string;
  listFilesError?: Error;
  fetch?: (url: URL) => Promise<Response> | Response;
}

// Runs the workflow's inline script the way actions/github-script does: an
// async function body handed `github`, `context`, and `core`.
async function runWorkflow(run: Run) {
  const posted: Array<{ method: "create" | "update"; body: string; id?: number }> = [];
  const contentReads: string[] = [];
  const fetchUrls: URL[] = [];
  const github = {
    paginate: async (method: (params: unknown) => Promise<{ data: unknown }>, params: unknown) =>
      (await method(params)).data,
    rest: {
      pulls: {
        listCommits: async () => ({ data: [{ commit: { message: run.commitMessage ?? "" } }] }),
        listFiles: async () => {
          if (run.listFilesError) throw run.listFilesError;
          return { data: (run.files ?? []).map((file) => ({ status: "modified", ...file })) };
        },
      },
      repos: {
        compareCommitsWithBasehead: async () => ({ data: { merge_base_commit: { sha: "base" } } }),
        getContent: async ({ path, ref }: { path: string; ref: string }) => {
          contentReads.push(`${ref}:${path}`);
          if (run.contentError) throw run.contentError;
          const text = run.contents?.[`${ref}:${path}`];
          if (text === undefined) throw Object.assign(new Error("Not Found"), { status: 404 });
          return { data: text };
        },
      },
      issues: {
        listComments: async () => ({ data: run.comments ?? [] }),
        createComment: async ({ body }: { body: string }) => {
          posted.push({ method: "create", body });
        },
        updateComment: async ({ body, comment_id }: { body: string; comment_id: number }) => {
          posted.push({ method: "update", body, id: comment_id });
        },
      },
    },
  };
  const author = run.author ?? "dependabot[bot]";
  const context = {
    repo: { owner: "acme", repo: "app" },
    payload: {
      pull_request: {
        number: 7,
        // The Renovate path must not read any of these.
        title: "Update `lodash` [x](https://evil.example) @everyone",
        body: "| lodash | `1.0.0` -> `9.9.9` | https://drydock.org/diff/lodash/1.0.0/9.9.9",
        user: { login: author },
        base: { sha: "base-tip" },
        head: {
          sha: "head",
          ref: "renovate/lodash-9.x",
          repo: { full_name: run.headRepo ?? "acme/app" },
        },
      },
    },
  };
  const core = { info: vi.fn(), warning: vi.fn() };
  const fetchMock = vi.fn(async (input: string) => {
    const url = new URL(input);
    fetchUrls.push(url);
    if (!run.fetch) throw new Error("unexpected fetch");
    return run.fetch(url);
  });
  const env = {
    DRYDOCK_SUMMARIES: "true",
    ECOSYSTEM: "",
    NAMES: "",
    FROM: "",
    TO: "",
    ...run.env,
  };
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const script = new AsyncFunction("github", "context", "core", "fetch", "process", SCRIPT);
  await script(github, context, core, fetchMock, { env });
  return { posted, contentReads, fetchUrls, core };
}

function payload(overrides: Record<string, unknown> = {}) {
  return {
    ecosystem: "npm",
    packageName: "left-pad",
    fromVersion: "1.0.0",
    toVersion: "1.1.0",
    diff: [
      { path: "index.js", status: "modified", flags: [] },
      { path: "lib/new.js", status: "added", flags: [] },
      { path: "prebuilds/linux.node", status: "added", flags: ["binary"] },
      { path: "bin/tool", status: "added", flags: ["native-elf"] },
      { path: "old.js", status: "removed", flags: [] },
    ],
    packageJsonDiff: {
      scripts: [{ key: "postinstall", status: "added", staged: "node x" }],
      dependencies: [
        { key: "a", status: "added", section: "dependencies" },
        { key: "b", status: "added", section: "dependencies", previouslyDeclared: true },
      ],
      bin: [{ key: "tool", status: "added" }],
    },
    findings: [
      {
        severity: "medium",
        ruleId: "code.network",
        file: "a.js",
        reason: "network",
        releaseDelta: true,
      },
      { severity: "info", ruleId: "meta.info", file: "a.js", reason: "info", releaseDelta: true },
      {
        severity: "critical",
        ruleId: "install-script.postinstall",
        file: "package.json",
        reason: "runs on install",
        releaseDelta: true,
      },
      {
        severity: "high",
        ruleId: "context.old",
        file: "b.js",
        reason: "pre-existing",
        releaseDelta: false,
      },
    ],
    risk: { releaseRisk: "critical", artifactRisk: "critical" },
    ...overrides,
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const single = { ECOSYSTEM: "npm_and_yarn", NAMES: "left-pad", FROM: "1.0.0", TO: "1.1.0" };

// Splits rendered markdown into code spans and the prose between them, using
// CommonMark's rule that a span closes on a backtick run of the same length.
function proseOutsideCode(markdown: string): string {
  let prose = "";
  let i = 0;
  while (i < markdown.length) {
    if (markdown[i] !== "`") {
      prose += markdown[i];
      i += 1;
      continue;
    }
    const run = /^`+/.exec(markdown.slice(i))![0];
    const close = new RegExp(`(?<!\`)${run}(?!\`)`, "g");
    close.lastIndex = i + run.length;
    const match = close.exec(markdown);
    if (!match) {
      prose += run;
      i += run.length;
      continue;
    }
    i = match.index + run.length;
  }
  return prose;
}

describe("published workflow snippet", () => {
  test("is the repository caller pinned to the reusable workflow's last commit", () => {
    const sha = execFileSync(
      "git",
      ["log", "-1", "--format=%H", "--", ".github/workflows/drydock-diff-link.yml"],
      { encoding: "utf8" },
    ).trim();
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(DEPENDENCY_PR_WORKFLOW).toBe(publishedDependencyPrWorkflow(REPO_CALLER, sha));
    expect(DEPENDENCY_PR_WORKFLOW).toBe(
      REPO_CALLER.trimEnd().replace(
        "uses: ./.github/workflows/drydock-diff-link.yml",
        `uses: JoviDeCroock/drydock/.github/workflows/drydock-diff-link.yml@${sha}`,
      ),
    );
    expect(DEPENDENCY_PR_WORKFLOW).not.toMatch(/this\s+repo/i);
    expect(() => publishedDependencyPrWorkflow("jobs: {}\n", sha)).toThrow();
  });

  test("pins every action in the reusable workflow", () => {
    const uses = [...REPO_WORKFLOW.matchAll(/uses: (\S+)/g)].map((m) => m[1]);
    expect(uses).toHaveLength(2);
    for (const ref of uses) expect(ref).toMatch(/@[0-9a-f]{40}$/);
  });

  test("authenticates the Dependabot commit before anything reads it", () => {
    const steps = REPO_WORKFLOW.slice(REPO_WORKFLOW.indexOf("steps:"));
    expect(steps.indexOf("dependabot/fetch-metadata")).toBeLessThan(steps.indexOf("github-script"));
    // Base-branch caller, and through it the base-branch reusable workflow and
    // pins: a PR bumping the actions cannot change what runs with write
    // access. Nothing from the head is checked out.
    expect(REPO_CALLER).toMatch(
      /^on:\n {2}pull_request_target:\n {4}types: \[opened, synchronize\]\n/m,
    );
    expect(REPO_WORKFLOW).toMatch(/^on:\n {2}workflow_call:\n/m);
    for (const workflow of [REPO_CALLER, REPO_WORKFLOW]) {
      expect(workflow).not.toMatch(/actions\/checkout|^\s*pull_request:|\bref:/m);
      expect(workflow).toMatch(/^permissions:\n {2}contents: read\n {2}pull-requests: write\n\n/m);
    }
    // No expression is interpolated into the script body.
    expect(SCRIPT).not.toContain("${{");
  });

  test("turns summaries off only when the caller passes false", () => {
    expect(REPO_WORKFLOW).toContain("DRYDOCK_SUMMARIES: ${{ inputs.summaries }}\n");
    expect(SCRIPT).toContain('process.env.DRYDOCK_SUMMARIES !== "false"');
  });

  test("holds the published snippet to the docs snippet width", () => {
    // The reusable workflow's path and pinned commit are fixed.
    const long = DEPENDENCY_PR_WORKFLOW.split("\n").filter(
      (line) => line.length > 71 && !line.trimStart().startsWith("uses: "),
    );
    expect(long).toEqual([]);
  });
});

describe("Dependabot comment", () => {
  test("summarizes a single bump with risk, counts, flags, and top release findings", async () => {
    const { posted, fetchUrls } = await runWorkflow({ env: single, fetch: () => json(payload()) });

    expect(fetchUrls).toHaveLength(1);
    expect(fetchUrls[0].origin + fetchUrls[0].pathname).toBe(
      "https://drydock.org/api/public/v1/package-diff",
    );
    expect(Object.fromEntries(fetchUrls[0].searchParams)).toEqual({
      ecosystem: "npm",
      package: "left-pad",
      from: "1.0.0",
      to: "1.1.0",
    });
    expect(posted).toHaveLength(1);
    const body = posted[0].body;
    expect(body.startsWith(`${MARKER}\nRead the diff this PR merges:\n`)).toBe(true);
    expect(body).toContain(
      "- [`left-pad` 1.0.0 → 1.1.0](https://drydock.org/diff/left-pad/1.0.0/1.1.0): release risk **critical**, 3 files added, 1 removed, 1 changed",
    );
    expect(body).toContain(
      "  - 1 new install script, 1 new dependency, 2 new native binaries, 1 new `bin` command",
    );
    const findingLines = body
      .split("\n")
      .filter((line) => /^ {2}- (critical|high|medium|low):/.test(line));
    expect(findingLines).toEqual([
      "  - critical: `install-script.postinstall` in `package.json`: `runs on install`",
      "  - medium: `code.network` in `a.js`: `network`",
    ]);
  });

  test("reads every Updates line of a grouped PR and drops non-pairs", async () => {
    const commitMessage = [
      "Bump the deps group with 4 updates",
      "",
      "Updates `left-pad` from 1.0.0 to 1.1.0",
      "Updates `@scope/pkg` from 2.0.0 to 2.1.0",
      "Updates `same` from 3.0.0 to 3.0.0",
      "Updates `bad name](https://evil.example)` from 1.0.0 to 2.0.0",
      "",
      "---",
      "updated-dependencies:",
      "- dependency-name: left-pad",
      "  dependency-version: 1.0.9",
    ].join("\n");
    const { posted } = await runWorkflow({
      env: { ...single, NAMES: "left-pad, @scope/pkg, same, bad", FROM: "", TO: "" },
      commitMessage,
      fetch: () => json(payload({ findings: [] })),
    });

    const body = posted[0].body;
    expect(body).toContain("Read the diff of each update in this group:");
    expect(body).toContain(
      "[`left-pad` 1.0.0 → 1.1.0](https://drydock.org/diff/left-pad/1.0.0/1.1.0)",
    );
    expect(body).toContain(
      "[`@scope/pkg` 2.0.0 → 2.1.0](https://drydock.org/diff/@scope/pkg/2.0.0/2.1.0)",
    );
    expect(body).not.toContain("same");
    expect(body).not.toContain("evil");
    expect(body).toContain(
      "(https://drydock.org/diff/left-pad/1.0.0/1.1.0): release risk **critical**, no release findings, 3 files added",
    );
  });

  test("links PyPI bumps under /diff/pypi", async () => {
    const { posted, fetchUrls } = await runWorkflow({
      env: { ECOSYSTEM: "pip", NAMES: "requests", FROM: "2.31.0", TO: "2.32.0" },
      fetch: () => json(payload({ ecosystem: "pypi" })),
    });
    expect(fetchUrls[0].searchParams.get("ecosystem")).toBe("pypi");
    expect(posted[0].body).toContain("(https://drydock.org/diff/pypi/requests/2.31.0/2.32.0)");
  });

  test("posts nothing for an ecosystem /diff does not serve", async () => {
    const { posted, fetchUrls } = await runWorkflow({
      env: { ECOSYSTEM: "github_actions", NAMES: "actions/checkout", FROM: "v4", TO: "v5" },
    });
    expect(posted).toEqual([]);
    expect(fetchUrls).toEqual([]);
  });

  test("keeps hostile response text inert in the comment", async () => {
    const hostile = payload({
      findings: [
        {
          severity: "critical",
          ruleId: "x](https://evil.example)",
          file: "a``b`.js <img src=x onerror=alert(1)>",
          reason:
            "see [docs](https://evil.example) @maintainer #1 <script>x</script> :tada:\n\n# heading",
          releaseDelta: true,
        },
        {
          severity: "high",
          ruleId: "code.eval",
          file: "`",
          reason: "\u202eevil\u2066 ```` fence ``",
          releaseDelta: true,
        },
        { severity: "<b>bold</b>", ruleId: "a", file: "a", reason: "a", releaseDelta: true },
      ],
      risk: { releaseRisk: "<img src=x>" },
    });
    const { posted } = await runWorkflow({ env: single, fetch: () => json(hostile) });
    const body = posted[0].body;
    const prose = proseOutsideCode(body);

    expect(prose).not.toMatch(/evil|<img|<script|<b>|onerror|@maintainer|#1|:tada:/);
    // The only HTML is the marker and the footer; the only links point at Drydock.
    expect(prose.match(/<[^>]*>/g)).toEqual([MARKER, "<sub>", "</sub>"]);
    for (const [, url] of prose.matchAll(/\]\(([^)]*)\)/g)) {
      expect(url.startsWith("https://drydock.org/diff/")).toBe(true);
    }
    expect(body).toContain("release risk **unknown**");
    expect(body).toContain(
      "  - critical: unnamed rule in ```a``b`.js <img src=x onerror=alert(1)>```:",
    );
    expect(body.split("\n").every((line) => !line.startsWith("#"))).toBe(true);
    expect(body).not.toMatch(/[\u202e\u2066]/);
  });

  test("renders non-string finding fields as empty instead of failing the job", async () => {
    const odd = payload({
      findings: [
        {
          severity: "high",
          ruleId: ["x"],
          file: { toString: 1 },
          reason: [{ toString: 1 }],
          releaseDelta: true,
        },
      ],
    });
    const { posted } = await runWorkflow({ env: single, fetch: () => json(odd) });
    expect(posted[0].body).toContain("  - high: unnamed rule in `-`: `-`");
  });

  test("leaves out npm bumps the repository resolves from its own registry", async () => {
    const { posted, fetchUrls } = await runWorkflow({
      env: { ...single, NAMES: "@corp/tool, left-pad" },
      commitMessage:
        "Updates `@corp/tool` from 1.0.0 to 1.1.0\nUpdates `left-pad` from 1.0.0 to 1.1.0",
      contents: { "head:.npmrc": "@corp:registry=https://npm.corp.example/\n" },
      fetch: () => json(payload({ findings: [] })),
    });
    expect(fetchUrls.map((url) => url.searchParams.get("package"))).toEqual(["left-pad"]);
    expect(posted[0].body).not.toContain("@corp");
  });

  test("reads registry config in the updated directory, and fails closed without it", async () => {
    const run = {
      env: {
        ...single,
        NAMES: "@corp/tool, left-pad",
        DIRECTORY: "/frontend",
        DRYDOCK_SUMMARIES: "false",
      },
      commitMessage:
        "Updates `@corp/tool` from 1.0.0 to 1.1.0\nUpdates `left-pad` from 1.0.0 to 1.1.0",
    };
    const scoped = await runWorkflow({
      ...run,
      contents: {
        "head:frontend/.yarnrc.yml":
          "npmScopes:\n    corp:\n      npmRegistryServer: 'https://npm.corp.example' # private\n",
      },
    });
    expect(scoped.contentReads).toContain("head:frontend/.yarnrc.yml");
    expect(scoped.posted[0].body).not.toContain("@corp");
    expect(scoped.posted[0].body).toContain("`left-pad`");

    const publicConfig = await runWorkflow({
      ...run,
      contents: { "head:.npmrc": 'registry="http://registry.npmjs.org/"\n' },
    });
    expect(publicConfig.posted[0].body).toContain("`@corp/tool`");

    const unreadable = await runWorkflow({
      ...run,
      contentError: Object.assign(new Error("Service Unavailable"), {
        name: "HttpError",
        status: 503,
      }),
    });
    expect(unreadable.posted).toEqual([]);
    expect(unreadable.core.warning).toHaveBeenCalledOnce();
  });

  test("treats Dependabot's uv and bun ecosystems as PyPI and npm", async () => {
    const uv = await runWorkflow({
      env: {
        ECOSYSTEM: "uv",
        NAMES: "httpx",
        FROM: "0.27.0",
        TO: "0.27.2",
        DRYDOCK_SUMMARIES: "false",
      },
    });
    expect(uv.posted[0].body).toContain("(https://drydock.org/diff/pypi/httpx/0.27.0/0.27.2)");
    const bun = await runWorkflow({
      env: { ...single, ECOSYSTEM: "bun", DRYDOCK_SUMMARIES: "false" },
    });
    expect(bun.posted[0].body).toContain("(https://drydock.org/diff/left-pad/1.0.0/1.1.0)");
  });

  test("degrades to the link with a note when the API fails", async () => {
    const responses = [
      () => json({ error: "unknown version" }, 404),
      () => {
        throw new TypeError("fetch failed");
      },
      () => new Response("<html>not json</html>", { status: 200 }),
      () => {
        throw Object.assign(new Error("aborted"), { name: "TimeoutError" });
      },
    ];
    let call = 0;
    const { posted } = await runWorkflow({
      env: { ...single, NAMES: "a, b, c, d" },
      commitMessage: ["a", "b", "c", "d"]
        .map((n) => `Updates \`${n}\` from 1.0.0 to 2.0.0`)
        .join("\n"),
      fetch: () => responses[call++](),
    });
    const lines = posted[0].body.split("\n").filter((line) => line.startsWith("- "));
    expect(lines).toEqual([
      "- Summary unavailable (HTTP 404): [`a` 1.0.0 → 2.0.0](https://drydock.org/diff/a/1.0.0/2.0.0)",
      "- Summary unavailable (request failed): [`b` 1.0.0 → 2.0.0](https://drydock.org/diff/b/1.0.0/2.0.0)",
      "- Summary unavailable (unreadable response): [`c` 1.0.0 → 2.0.0](https://drydock.org/diff/c/1.0.0/2.0.0)",
      "- Summary unavailable (timed out): [`d` 1.0.0 → 2.0.0](https://drydock.org/diff/d/1.0.0/2.0.0)",
    ]);

    const alone = await runWorkflow({ env: single, fetch: () => json({}, 404) });
    expect(alone.posted[0].body).toContain(
      "\n- [`left-pad` 1.0.0 → 1.1.0](https://drydock.org/diff/left-pad/1.0.0/1.1.0): summary unavailable (HTTP 404)\n",
    );
  });

  test("stops asking once rate limited, and never fetches more than ten pairs", async () => {
    const names = Array.from({ length: 14 }, (_, i) => `pkg-${i}`);
    const commitMessage = names.map((n) => `Updates \`${n}\` from 1.0.0 to 2.0.0`).join("\n");

    const capped = await runWorkflow({
      env: { ...single, NAMES: names.join(", ") },
      commitMessage,
      fetch: () => json(payload({ findings: [] })),
    });
    expect(capped.fetchUrls).toHaveLength(10);
    expect(capped.posted[0].body).toContain(
      "<details><summary>4 more updates without a summary (10 per run)</summary>",
    );

    let call = 0;
    const limited = await runWorkflow({
      env: { ...single, NAMES: names.join(", ") },
      commitMessage,
      fetch: () =>
        call++ < 2 ? json(payload({ findings: [] })) : json({ error: "rate limit exceeded" }, 429),
    });
    expect(limited.fetchUrls).toHaveLength(3);
    const rateLimited = limited.posted[0].body
      .split("\n")
      .filter((line) => line.includes("rate limited"));
    expect(rateLimited).toHaveLength(1);
    expect(rateLimited[0].startsWith("- Summary unavailable (rate limited): [`pkg-2`")).toBe(true);
    expect(rateLimited[0].match(/\]\(https:\/\/drydock\.org\/diff\//g)).toHaveLength(8);
  });

  test("leads a large group with its riskiest summaries and states shared outcomes once", async () => {
    const names = Array.from({ length: 30 }, (_, i) => `pkg-${i}`);
    const clean = payload({
      diff: [],
      packageJsonDiff: {},
      findings: [],
      risk: { releaseRisk: "low" },
    });
    const finding = (severity: string) => ({
      severity,
      ruleId: `code.${severity}`,
      file: "a.js",
      reason: severity,
      releaseDelta: true,
    });
    const responses: Record<string, () => Response> = {
      "pkg-2": () => json(payload({ findings: [finding("high")], risk: { releaseRisk: "high" } })),
      "pkg-5": () => json({}, 404),
      "pkg-7": () =>
        json(payload({ findings: [finding("critical")], risk: { releaseRisk: "critical" } })),
    };
    const { posted, fetchUrls } = await runWorkflow({
      env: { ...single, NAMES: names.join(", ") },
      commitMessage: names.map((n) => `Updates \`${n}\` from 1.0.0 to 2.0.0`).join("\n"),
      fetch: (url) => (responses[url.searchParams.get("package")!] ?? (() => json(clean)))(),
    });
    expect(fetchUrls).toHaveLength(10);
    const link = (n: string) =>
      `[\`${n}\` 1.0.0 → 2.0.0](https://drydock.org/diff/${n}/1.0.0/2.0.0)`;
    const body = posted[0].body;
    const top = body.split("\n").filter((line) => line.startsWith("- "));
    expect(top.slice(0, 4)).toEqual([
      `- ${link("pkg-7")}: release risk **critical**, 3 files added, 1 removed, 1 changed`,
      `- ${link("pkg-2")}: release risk **high**, 3 files added, 1 removed, 1 changed`,
      `- Summary unavailable (HTTP 404): ${link("pkg-5")}`,
      `- No release findings: ${["pkg-0", "pkg-1", "pkg-3", "pkg-4", "pkg-6", "pkg-8", "pkg-9"]
        .map(link)
        .join(", ")}`,
    ]);
    const folded = body.slice(body.indexOf("<details>"), body.indexOf("</details>"));
    expect(
      folded.startsWith(
        "<details><summary>20 more updates without a summary (10 per run)</summary>\n\n",
      ),
    ).toBe(true);
    expect(folded.split("\n").filter((line) => line.startsWith("- "))).toEqual(
      names.slice(10).map((n) => `- ${link(n)}`),
    );
    expect(body.match(/release findings/gi)).toHaveLength(1);
    expect(proseOutsideCode(body).match(/<[^>]*>/g)).toEqual([
      MARKER,
      "<details>",
      "<summary>",
      "</summary>",
      "</details>",
      "<sub>",
      "</sub>",
    ]);
  });

  test("renders a clean single bump in full on one line", async () => {
    const { posted } = await runWorkflow({
      env: single,
      fetch: () =>
        json(
          payload({ packageJsonDiff: {}, diff: [], findings: [], risk: { releaseRisk: "low" } }),
        ),
    });
    expect(posted[0].body.split("\n").filter((line) => line.startsWith("- "))).toEqual([
      "- [`left-pad` 1.0.0 → 1.1.0](https://drydock.org/diff/left-pad/1.0.0/1.1.0): release risk **low**, no release findings, 0 files added, 0 removed, 0 changed",
    ]);
    expect(posted[0].body).not.toContain("<details>");
  });

  test("bounds the comment however many updates and findings there are", async () => {
    const names = Array.from({ length: 80 }, (_, i) => `pkg-${i}`);
    const findings = Array.from({ length: 40 }, () => ({
      severity: "high",
      ruleId: "code.eval",
      file: "x".repeat(5000),
      reason: "y".repeat(5000),
      releaseDelta: true,
    }));
    const { posted } = await runWorkflow({
      env: { ...single, NAMES: names.join(", ") },
      commitMessage: names.map((n) => `Updates \`${n}\` from 1.0.0 to 2.0.0`).join("\n"),
      fetch: () => json(payload({ findings })),
    });
    const body = posted[0].body;
    expect(body.length).toBeLessThan(65536);
    expect(body).toContain("  - 37 more release findings in the diff");
    expect(body).toContain("- and 30 more updates\n\n</details>");
    expect(body.split("\n").filter((line) => line.startsWith("- [")).length).toBe(50);
  });

  test("posts links only, and contacts nobody, when summaries are off", async () => {
    const { posted, fetchUrls } = await runWorkflow({
      env: { ...single, DRYDOCK_SUMMARIES: "false" },
    });
    expect(fetchUrls).toEqual([]);
    expect(posted[0].body).toBe(
      `${MARKER}\nRead the diff this PR merges:\n\n- [\`left-pad\` 1.0.0 → 1.1.0](https://drydock.org/diff/left-pad/1.0.0/1.1.0)`,
    );
  });

  test("updates its own comment and ignores a pasted marker", async () => {
    const { posted } = await runWorkflow({
      env: { ...single, DRYDOCK_SUMMARIES: "false" },
      comments: [
        { id: 1, body: `${MARKER} pasted`, user: { login: "someone" } },
        { id: 2, body: `${MARKER}\nold`, user: { login: "github-actions[bot]" } },
      ],
    });
    expect(posted.map(({ method, id }) => ({ method, id }))).toEqual([{ method: "update", id: 2 }]);

    const fresh = await runWorkflow({
      env: { ...single, DRYDOCK_SUMMARIES: "false" },
      comments: [{ id: 1, body: `${MARKER} pasted`, user: { login: "someone" } }],
    });
    expect(fresh.posted.map(({ method }) => method)).toEqual(["create"]);
  });
});

describe("Renovate comment", () => {
  const renovate = { author: "renovate[bot]", env: { DRYDOCK_SUMMARIES: "false" } };
  const bullets = (body: string) => body.split("\n").filter((line) => line.startsWith("- "));

  test("derives pairs from package-lock.json direct dependencies, not the PR text", async () => {
    const lock = (lodash: string, alias: string, transitive: string) =>
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": {
            dependencies: { lodash: "^4", aliased: "npm:real-pkg@^1", local: "file:./x" },
            devDependencies: { priv: "^1" },
          },
          "node_modules/lodash": {
            version: lodash,
            resolved: `https://registry.npmjs.org/lodash/-/lodash-${lodash}.tgz`,
          },
          "node_modules/aliased": { name: "real-pkg", version: alias },
          "node_modules/local": { link: true },
          "node_modules/priv": {
            version: alias,
            resolved: "https://npm.internal.example/priv.tgz",
          },
          "node_modules/transitive": { version: transitive },
        },
      });
    const { posted, contentReads } = await runWorkflow({
      ...renovate,
      files: [
        { filename: "package-lock.json" },
        { filename: "package.json" },
        { filename: "src/index.ts" },
      ],
      contents: {
        "base:package-lock.json": lock("4.17.20", "1.0.0", "1.0.0"),
        "head:package-lock.json": lock("4.17.21", "1.2.0", "2.0.0"),
      },
    });
    expect(contentReads.filter((read) => !/\.(npmrc|yarnrc\.yml)$/.test(read))).toEqual([
      "base:package-lock.json",
      "head:package-lock.json",
    ]);
    expect(bullets(posted[0].body)).toEqual([
      "- [`lodash` 4.17.20 → 4.17.21](https://drydock.org/diff/lodash/4.17.20/4.17.21)",
      "- [`real-pkg` 1.0.0 → 1.2.0](https://drydock.org/diff/real-pkg/1.0.0/1.2.0)",
    ]);
  });

  test("derives pairs from pnpm-lock.yaml importers", async () => {
    const lock = (react: string, types: string) =>
      [
        "lockfileVersion: '9.0'",
        "",
        "settings:",
        "  autoInstallPeers: true",
        "",
        "importers:",
        "",
        "  .:",
        "    dependencies:",
        "      react:",
        "        specifier: ^18.2.0",
        `        version: ${react}`,
        "      ws-lib:",
        "        specifier: workspace:*",
        "        version: link:packages/ws-lib",
        "    devDependencies:",
        "      '@types/react':",
        "        specifier: ^18.0.0",
        `        version: ${types}(react@${react})`,
        "      string-width-cjs:",
        "        specifier: npm:string-width@^4.2.0",
        "        version: string-width@4.2.3",
        "",
        "  packages/app:",
        "    dependencies:",
        "      react:",
        "        specifier: ^18.2.0",
        `        version: ${react}`,
        "",
        "packages:",
        "",
        `  react@${react}:`,
        "    resolution: {integrity: sha512-x}",
        "",
        "snapshots:",
        "",
        "  left-pad@1.0.0: {}",
      ].join("\n");
    const { posted } = await runWorkflow({
      ...renovate,
      files: [{ filename: "pnpm-lock.yaml" }],
      contents: {
        "base:pnpm-lock.yaml": lock("18.2.0", "18.0.1"),
        "head:pnpm-lock.yaml": lock("18.3.1", "18.0.2"),
      },
    });
    expect(bullets(posted[0].body)).toEqual([
      "- [`react` 18.2.0 → 18.3.1](https://drydock.org/diff/react/18.2.0/18.3.1)",
      "- [`@types/react` 18.0.1 → 18.0.2](https://drydock.org/diff/@types/react/18.0.1/18.0.2)",
    ]);
  });

  test("derives pairs from yarn.lock for the manifest beside it", async () => {
    const lock = (version: string) =>
      [
        "# yarn lockfile v1",
        "",
        '"@babel/core@^7.0.0", "@babel/core@^7.1.0":',
        `  version "${version}"`,
        `  resolved "https://registry.yarnpkg.com/@babel/core/-/core-${version}.tgz"`,
        "",
        "private@^1.0.0:",
        `  version "${version}"`,
        '  resolved "https://npm.internal.example/private.tgz"',
      ].join("\n");
    const manifest = JSON.stringify({
      devDependencies: { "@babel/core": "^7.1.0", private: "^1.0.0" },
    });
    const { posted, contentReads } = await runWorkflow({
      ...renovate,
      files: [{ filename: "web/yarn.lock" }],
      contents: {
        "base:web/yarn.lock": lock("7.1.0"),
        "head:web/yarn.lock": lock("7.2.0"),
        "base:web/package.json": manifest,
        "head:web/package.json": manifest,
      },
    });
    expect(contentReads).toContain("head:web/package.json");
    expect(bullets(posted[0].body)).toEqual([
      "- [`@babel/core` 7.1.0 → 7.2.0](https://drydock.org/diff/@babel/core/7.1.0/7.2.0)",
    ]);
  });

  test("derives PyPI pairs from requirements pins and uv.lock", async () => {
    const uv = (httpx: string, anyio: string) =>
      [
        "version = 1",
        "",
        "[[package]]",
        'name = "app"',
        'version = "0.1.0"',
        'source = { virtual = "." }',
        "dependencies = [",
        '    { name = "httpx" },',
        "]",
        "",
        "[[package]]",
        'name = "httpx"',
        `version = "${httpx}"`,
        'source = { registry = "https://pypi.org/simple" }',
        "dependencies = [",
        '    { name = "anyio" },',
        "]",
        "",
        "[[package]]",
        'name = "anyio"',
        `version = "${anyio}"`,
        'source = { registry = "https://pypi.org/simple" }',
      ].join("\n");
    const { posted } = await runWorkflow({
      ...renovate,
      files: [{ filename: "requirements/base.txt" }, { filename: "uv.lock" }],
      contents: {
        "base:requirements/base.txt":
          "Django==4.2.0 \\\n    --hash=sha256:abc\nrequests>=2\nmarkered==1.0; python_version<'3.9'\nmarkered==2.0; python_version>='3.9'\n",
        "head:requirements/base.txt":
          "Django==4.2.1 \\\n    --hash=sha256:def\nrequests>=2\nmarkered==1.1; python_version<'3.9'\nmarkered==2.1; python_version>='3.9'\n",
        "base:uv.lock": uv("0.27.0", "4.0.0"),
        "head:uv.lock": uv("0.27.2", "4.1.0"),
      },
    });
    expect(bullets(posted[0].body)).toEqual([
      "- [`django` 4.2.0 → 4.2.1](https://drydock.org/diff/pypi/django/4.2.0/4.2.1)",
      "- [`httpx` 0.27.0 → 0.27.2](https://drydock.org/diff/pypi/httpx/0.27.0/0.27.2)",
    ]);
  });

  test("reads the base side at the merge base", async () => {
    const lock = (v: string) =>
      JSON.stringify({
        lockfileVersion: 3,
        packages: { "": { dependencies: { a: "^1" } }, "node_modules/a": { version: v } },
      });
    const { posted } = await runWorkflow({
      ...renovate,
      files: [{ filename: "package-lock.json" }],
      contents: {
        "base-tip:package-lock.json": lock("1.5.0"),
        "base:package-lock.json": lock("1.0.0"),
        "head:package-lock.json": lock("1.1.0"),
      },
    });
    expect(bullets(posted[0].body)).toEqual([
      "- [`a` 1.0.0 → 1.1.0](https://drydock.org/diff/a/1.0.0/1.1.0)",
    ]);
  });

  test("posts nothing without a supported lockfile, for a fork head, or on a parse failure", async () => {
    const none = await runWorkflow({ ...renovate, files: [{ filename: "package.json" }] });
    expect(none.posted).toEqual([]);

    const fork = await runWorkflow({
      ...renovate,
      headRepo: "attacker/app",
      files: [{ filename: "package-lock.json" }],
    });
    expect(fork.posted).toEqual([]);
    expect(fork.contentReads).toEqual([]);

    const broken = await runWorkflow({
      ...renovate,
      files: [{ filename: "package-lock.json" }],
      contents: { "base:package-lock.json": "{", "head:package-lock.json": "{" },
    });
    expect(broken.posted).toEqual([]);
    expect(broken.core.warning).toHaveBeenCalledOnce();

    const apiDown = await runWorkflow({
      ...renovate,
      listFilesError: Object.assign(new Error("Server Error"), { name: "HttpError", status: 502 }),
    });
    expect(apiDown.posted).toEqual([]);
    expect(apiDown.core.warning).toHaveBeenCalledOnce();
  });

  test("skips packages a configured registry may serve", async () => {
    const lock = (scoped: string, plain: string) =>
      [
        "lockfileVersion: '9.0'",
        "importers:",
        "  .:",
        "    dependencies:",
        "      '@corp/tool':",
        "        specifier: ^1.0.0",
        `        version: ${scoped}`,
        "      '@other/tool':",
        "        specifier: ^1.0.0",
        `        version: ${scoped}`,
        "      left-pad:",
        "        specifier: ^1.0.0",
        `        version: ${plain}`,
      ].join("\n");
    const files = [{ filename: "app/pnpm-lock.yaml" }];
    const contents = {
      "base:app/pnpm-lock.yaml": lock("1.0.0", "1.0.0"),
      "head:app/pnpm-lock.yaml": lock("1.1.0", "1.1.0"),
      "head:app/.npmrc":
        "@corp:registry=https://npm.corp.example/\nregistry=https://registry.npmjs.org/\n",
      "head:.yarnrc.yml": 'npmScopes:\n  other:\n    npmRegistryServer: "https://other.example"\n',
    };
    const scoped = await runWorkflow({ ...renovate, files, contents });
    expect(bullets(scoped.posted[0].body)).toEqual([
      "- [`left-pad` 1.0.0 → 1.1.0](https://drydock.org/diff/left-pad/1.0.0/1.1.0)",
    ]);

    const everything = await runWorkflow({
      ...renovate,
      files,
      contents: { ...contents, "head:.npmrc": "registry=https://npm.corp.example/" },
    });
    expect(everything.posted).toEqual([]);

    const pip = await runWorkflow({
      ...renovate,
      files: [{ filename: "requirements.txt" }],
      contents: {
        "base:requirements.txt":
          "--extra-index-url https://pypi.corp.example/simple\ninternal==1.0\n",
        "head:requirements.txt":
          "--extra-index-url https://pypi.corp.example/simple\ninternal==1.1\n",
      },
    });
    expect(pip.posted).toEqual([]);
  });
});
