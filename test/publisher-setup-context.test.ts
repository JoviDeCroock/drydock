import { describe, expect, test, vi } from "vitest";
import { stringify } from "yaml";
import { readSetupContext } from "../server/lib/github-app/setup-context";
import type { SetupGithubClient } from "../server/lib/github-app/setup-api";
import { SETUP_BASE_SHA, SETUP_ORIGINAL_WORKFLOW } from "./helpers/publisher-setup-fixtures";

type Evidence = { content: string; mode?: string; override?: Record<string, unknown> };
function repository(files: Record<string, Evidence>, directoryModes: Record<string, string> = {}) {
  const sha = "b".repeat(40);
  const directories = new Map<string, string>([["", SETUP_BASE_SHA]]);
  for (const path of Object.keys(files)) {
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index++) {
      const directory = parts.slice(0, index).join("/");
      if (!directories.has(directory))
        directories.set(directory, String(directories.size).padStart(40, "0"));
    }
  }
  const request = vi.fn(async (suffix: string) => {
    const url = new URL(`https://api.github.com/repos/octo/release${suffix}`);
    if (suffix.startsWith("/git/trees/")) {
      const directory = [...directories].find(([, value]) => suffix.endsWith(value))?.[0];
      if (directory === undefined) return null;
      const entries: Record<string, unknown>[] = [];
      for (const [child, childSha] of directories)
        if (
          child &&
          child.slice(0, child.lastIndexOf("/") < 0 ? 0 : child.lastIndexOf("/")) === directory
        )
          entries.push({
            path: child.split("/").at(-1),
            mode: directoryModes[child] ?? "040000",
            type: directoryModes[child] === "120000" ? "blob" : "tree",
            sha: childSha,
          });
      for (const [path, file] of Object.entries(files))
        if ((path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "") === directory)
          entries.push({
            path: path.split("/").at(-1),
            mode: file.mode ?? "100644",
            type: "blob",
            sha,
          });
      return { tree: entries, truncated: false };
    }
    expect(url.searchParams.get("ref")).toBe(SETUP_BASE_SHA);
    const path = decodeURIComponent(url.pathname.split("/contents/")[1] ?? "");
    const file = files[path];
    if (file)
      return {
        type: "file",
        path,
        sha,
        encoding: "base64",
        size: new TextEncoder().encode(file.content).byteLength,
        content: Buffer.from(file.content).toString("base64"),
        ...file.override,
      };
    if (directories.has(path))
      return [...directories.keys()]
        .filter(
          (child) => child.startsWith(`${path}/`) && !child.slice(path.length + 1).includes("/"),
        )
        .map((child) => ({ name: child.split("/").at(-1), path: child, type: "dir" }));
    return null;
  });
  const client = { request } as unknown as SetupGithubClient;
  return { client, request };
}

describe("publisher setup supporting evidence", () => {
  test("fetches pinned root/workspace manifests and direct run/Changesets script references without executing source", async () => {
    const marker =
      "globalThis.publisherSetupContextExecuted = true; throw new Error('hostile source');";
    const { client, request } = repository({
      "package.json": {
        content: JSON.stringify({
          workspaces: {
            packages: [
              "packages/*",
              "modules/library",
              "!packages/private",
              "packages/**",
              "../escape",
            ],
          },
        }),
      },
      "pnpm-workspace.yaml": { content: "packages:\n  - tools/cli\n" },
      ".changeset/config.json": { content: '{"access":"public"}' },
      ".github/scripts/release.mjs": { content: marker },
      ".github/scripts/version.cjs": { content: "throw new Error('do not execute')" },
      "packages/a/package.json": { content: '{"scripts":{"prepublishOnly":"npm run build"}}' },
      "packages/b/package.json": { content: '{"name":"b"}' },
      "modules/library/package.json": { content: '{"name":"library"}' },
      "tools/cli/package.json": { content: '{"name":"cli"}' },
    });
    const workflow = `jobs:\n  release:\n    steps:\n      - run: node .github/scripts/release.mjs\n      - uses: changesets/action@v1\n        with:\n          version: node './.github/scripts/version.cjs'\n          publish: node .github/scripts/release.mjs\n`;
    const result = await readSetupContext(client, workflow, SETUP_BASE_SHA);
    expect(result.files.map((file) => file.path)).toEqual([
      "package.json",
      "pnpm-workspace.yaml",
      ".changeset/config.json",
      ".github/scripts/release.mjs",
      ".github/scripts/version.cjs",
      "packages/a/package.json",
      "packages/b/package.json",
      "modules/library/package.json",
      "tools/cli/package.json",
    ]);
    expect(result.files.find((file) => file.path.endsWith("release.mjs"))?.content).toBe(marker);
    expect(Reflect.get(globalThis, "publisherSetupContextExecuted")).toBeUndefined();
    expect(result.warnings.join(" ")).toContain("unsupported workspace patterns");
    expect(
      request.mock.calls.every(([suffix]) => !suffix.includes("escape") && !suffix.includes("**")),
    ).toBe(true);
  });
  test("rejects traversal and symlinks even when Contents would return a dereferenced regular file", async () => {
    const { client, request } = repository({
      "package.json": { content: '{"workspaces":["secrets/*"]}', mode: "120000" },
      ".github/scripts/link.js": { content: "private data", mode: "120000" },
    });
    const result = await readSetupContext(
      client,
      `jobs:\n  release:\n    steps:\n      - run: |\n          node .github/scripts/../../secrets.js\n          node .github/scripts/link.js\n          node .github/scripts/\${DYNAMIC}.js\n`,
      SETUP_BASE_SHA,
    );
    expect(result.files).toEqual([]);
    expect(result.warnings.join(" ")).toContain("Symlink");
    expect(request.mock.calls.filter(([suffix]) => suffix.startsWith("/contents/"))).toEqual([]);
    expect(
      request.mock.calls.every(
        ([suffix]) => !suffix.includes("secrets") && !suffix.includes("DYNAMIC"),
      ),
    ).toBe(true);
  });
  test("caps workspace manifests and total decoded UTF-8 bytes with explicit incomplete-evidence warnings", async () => {
    const files: Record<string, Evidence> = {};
    for (let index = 0; index < 45; index++)
      files[`packages/pkg${String(index).padStart(2, "0")}/package.json`] = {
        content: "x".repeat(12_000),
      };
    const { client, request } = repository(files);
    const result = await readSetupContext(client, SETUP_ORIGINAL_WORKFLOW, SETUP_BASE_SHA);
    expect(result.files).toHaveLength(8);
    expect(result.files.reduce((total, file) => total + Buffer.byteLength(file.content), 0)).toBe(
      96_000,
    );
    expect(result.warnings.join(" ")).toContain("96 KB total limit");
    expect(result.warnings.join(" ")).toContain("Workspace manifest limit");
    expect(
      request.mock.calls.filter(([suffix]) => suffix.startsWith("/contents/packages/pkg")),
    ).toHaveLength(40);
    expect(request.mock.calls.length).toBeLessThanOrEqual(160);
  });
  test("bounds the total file count without executing dozens of referenced scripts", async () => {
    const files: Record<string, Evidence> = {};
    const steps: string[] = [];
    for (let index = 0; index < 60; index++) {
      files[`.github/scripts/script${index}.mjs`] = { content: "throw new Error('evidence only')" };
      steps.push(`      - run: node .github/scripts/script${index}.mjs`);
    }
    const { client } = repository(files);
    const result = await readSetupContext(
      client,
      `jobs:\n  release:\n    steps:\n${steps.join("\n")}\n`,
      SETUP_BASE_SHA,
    );
    expect(result.files).toHaveLength(48);
    expect(result.warnings.join(" ")).toContain("file limit reached");
  });
  test("does not traverse symlink directories", async () => {
    const { client, request } = repository(
      { ".github/scripts/release.mjs": { content: "private target" } },
      { ".github": "120000" },
    );
    const result = await readSetupContext(
      client,
      "jobs:\n  release:\n    steps:\n      - run: node .github/scripts/release.mjs\n",
      SETUP_BASE_SHA,
    );
    expect(result.files).toEqual([]);
    expect(result.warnings.join(" ")).toContain("directories were skipped");
    expect(request.mock.calls.filter(([suffix]) => suffix.startsWith("/contents/"))).toEqual([]);
  });
  test.each([
    "node --enable-source-maps .github/scripts/stage-packages.mjs",
    "node --enable-source-maps .github/scripts/stage-packages.mjs\\nnode .github/scripts/stage-packages.mjs",
    "node .github/scripts/${SCRIPT}.mjs",
  ])("warns when a referenced script uses an unsupported invocation: %s", async (command) => {
    const { client } = repository({
      ".github/scripts/stage-packages.mjs": { content: "evidence only" },
    });
    const workflow = `jobs:\n  release:\n    steps:\n      - run: |\n${command
      .replaceAll("\\n", "\n")
      .split("\n")
      .map((line) => `          ${line}`)
      .join("\n")}\n`;
    const result = await readSetupContext(client, workflow, SETUP_BASE_SHA);
    expect(result.warnings).toContain(
      "Nonliteral or unsupported release-script references were skipped.",
    );
  });
  test.each(["step", "job", "workflow", "inline", "conditional"])(
    "warns instead of resolving a script from a non-root %s directory",
    async (scope) => {
      const { client, request } = repository({
        ".github/scripts/release.mjs": { content: "root script" },
      });
      const step: Record<string, unknown> = {
        run:
          scope === "conditional"
            ? "if [ -d packages/a ]; then cd packages/a; fi\nnode .github/scripts/release.mjs"
            : scope === "inline"
              ? "cd packages/a && node .github/scripts/release.mjs"
              : "node .github/scripts/release.mjs",
      };
      const job: Record<string, unknown> = { steps: [step] };
      const workflow: Record<string, unknown> = { jobs: { release: job } };
      if (scope === "step") step["working-directory"] = "packages/a";
      if (scope === "job") job.defaults = { run: { "working-directory": "packages/a" } };
      if (scope === "workflow") workflow.defaults = { run: { "working-directory": "packages/a" } };
      const result = await readSetupContext(client, stringify(workflow), SETUP_BASE_SHA);
      expect(result.warnings).toContain(
        "Release-script references outside the literal repository root require manual setup.",
      );
      expect(
        request.mock.calls.some(([suffix]) => suffix.includes("/contents/.github/scripts/")),
      ).toBe(false);
    },
  );
  test("literal root overrides remain supported and shell comments are not script invocations", async () => {
    const { client } = repository({ ".github/scripts/release.mjs": { content: "root script" } });
    const result = await readSetupContext(
      client,
      "defaults:\n  run:\n    working-directory: packages/a\njobs:\n  release:\n    steps:\n      - working-directory: .\n        run: |\n          # node --enable-source-maps .github/scripts/unseen.mjs\n          node .github/scripts/release.mjs\n",
      SETUP_BASE_SHA,
    );
    expect(result.files.map((file) => file.path)).toEqual([".github/scripts/release.mjs"]);
    expect(result.warnings).toEqual([]);
  });
  test("a missing referenced script warns while absent optional root metadata stays quiet", async () => {
    const { client } = repository({});
    const result = await readSetupContext(
      client,
      "jobs:\n  release:\n    steps:\n      - run: node .github/scripts/missing.mjs\n",
      SETUP_BASE_SHA,
    );
    expect(result.files).toEqual([]);
    expect(result.warnings).toEqual([
      "A referenced release script was missing or unavailable at the pinned revision.",
    ]);
  });
  test("Changesets action cwd cannot resolve a relative script against a different root", async () => {
    const { client, request } = repository({
      ".github/scripts/release.mjs": { content: "root script" },
    });
    const result = await readSetupContext(
      client,
      "jobs:\n  release:\n    steps:\n      - uses: changesets/action@v1\n        with:\n          cwd: packages/a\n          publish: node .github/scripts/release.mjs\n",
      SETUP_BASE_SHA,
    );
    expect(result.warnings).toContain(
      "Release-script references outside the literal repository root require manual setup.",
    );
    expect(
      request.mock.calls.some(([suffix]) => suffix.includes("/contents/.github/scripts/")),
    ).toBe(false);
  });
  test("bounds API reads while following several deeply nested literal workspaces", async () => {
    const patterns = Array.from({ length: 24 }, (_, index) => `dir${index}/a/b/c/d/e`);
    const files: Record<string, Evidence> = {
      "package.json": { content: JSON.stringify({ workspaces: patterns }) },
    };
    for (const pattern of patterns) files[`${pattern}/package.json`] = { content: "{}" };
    const { client, request } = repository(files);
    const result = await readSetupContext(client, SETUP_ORIGINAL_WORKFLOW, SETUP_BASE_SHA);
    expect(request).toHaveBeenCalledTimes(160);
    expect(result.warnings.join(" ")).toContain("request limit reached");
  });
  test.each([
    { label: "oversized", evidence: { content: "x".repeat(24_001) } },
    { label: "mismatched path", evidence: { content: "{}", override: { path: "another.json" } } },
    { label: "mismatched blob", evidence: { content: "{}", override: { sha: "c".repeat(40) } } },
    { label: "binary", evidence: { content: "\0" } },
    { label: "invalid UTF-8", evidence: { content: "x", override: { content: "/w==" } } },
  ])("skips $label evidence with a warning", async ({ evidence }) => {
    const { client } = repository({ "package.json": evidence });
    const result = await readSetupContext(client, SETUP_ORIGINAL_WORKFLOW, SETUP_BASE_SHA);
    expect(result.files).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
  test("does not interpret aliases or recursive/dynamic workspace patterns", async () => {
    const { client, request } = repository({
      "pnpm-workspace.yaml": {
        content:
          "packages: &packages\n - packages/**\n - ../secret\n - '!packages/private'\n - .hidden\n - '$DYNAMIC'\nextra: *packages\n",
      },
    });
    const result = await readSetupContext(client, SETUP_ORIGINAL_WORKFLOW, SETUP_BASE_SHA);
    expect(result.warnings).toContain("pnpm workspace configuration could not be inspected.");
    expect(
      request.mock.calls.every(
        ([suffix]) => !suffix.includes("secret") && !suffix.includes("DYNAMIC"),
      ),
    ).toBe(true);
  });
  test("rejects a mutable revision without contacting GitHub", async () => {
    const { client, request } = repository({});
    await expect(readSetupContext(client, SETUP_ORIGINAL_WORKFLOW, "main")).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(request).not.toHaveBeenCalled();
  });
});
