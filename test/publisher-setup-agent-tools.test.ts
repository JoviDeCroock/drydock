import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import {
  createSetupAgentTools,
  setupAgentCandidateDigest,
  setupAgentChangedFiles,
} from "../server/lib/github-app/setup-agent-tools";
import type { SetupAgentState } from "../server/lib/github-app/setup-agent-types";
import { SETUP_DRAFT_REQUEST } from "./helpers/publisher-setup-fixtures";

const BASE = "a".repeat(40);
const WORKFLOW = ".github/workflows/release.yml";
const ORIGINAL = "name: Release\njobs: {}\n";
const CHANGED = "name: Reviewed release\njobs: {}\n";

function fixture(extra: Record<string, string> = {}, modes: Record<string, string> = {}) {
  const source = { [WORKFLOW]: ORIGINAL, "package.json": '{"name":"fixture"}', ...extra };
  const treeIds = new Map<string, string>([["", BASE]]);
  const blobs = new Map<string, { path: string; content: string }>();
  let id = 1;
  const makeId = () => (++id).toString(16).padStart(40, "0");
  for (const [path, content] of Object.entries(source)) {
    let directory = "";
    for (const segment of path.split("/").slice(0, -1)) {
      directory = directory ? `${directory}/${segment}` : segment;
      if (!treeIds.has(directory)) treeIds.set(directory, makeId());
    }
    blobs.set(makeId(), { path, content });
  }
  const request = vi.fn(async (suffix: string) => {
    const directory = [...treeIds].find(([, sha]) => suffix === `/git/trees/${sha}`)?.[0];
    if (directory !== undefined) {
      const prefix = directory ? `${directory}/` : "";
      const tree: { path: string; type: string; mode: string; sha: string }[] = [];
      for (const [path, sha] of treeIds)
        if (
          path.startsWith(prefix) &&
          path !== directory &&
          !path.slice(prefix.length).includes("/")
        )
          tree.push({
            path: path.slice(prefix.length),
            type: "tree",
            mode: modes[path] ?? "040000",
            sha,
          });
      for (const [sha, file] of blobs)
        if (file.path.startsWith(prefix) && !file.path.slice(prefix.length).includes("/"))
          tree.push({
            path: file.path.slice(prefix.length),
            type: "blob",
            mode: modes[file.path] ?? "100644",
            sha,
          });
      return { truncated: false, tree };
    }
    const sha = suffix.slice("/git/blobs/".length);
    const blob = blobs.get(sha);
    if (suffix.startsWith("/git/blobs/") && blob)
      return {
        sha,
        encoding: "base64",
        content: Buffer.from(blob.content).toString("base64"),
        size: Buffer.byteLength(blob.content),
      };
    throw new Error("Private upstream failure that must never escape");
  });
  const state: SetupAgentState = {
    request: { ...SETUP_DRAFT_REQUEST, workflowPath: WORKFLOW, baseSha: BASE },
    originalWorkflow: ORIGINAL,
    messages: [],
    files: {},
    budgets: { reads: 0, bytes: 0, edits: 0 },
  };
  const validateChanges = vi.fn(() => ({ valid: true, issues: [] }));
  const tools = createSetupAgentTools({ request }, state, "draft", { validateChanges });
  return { request, state, tools, validateChanges };
}

async function call(tools: object, name: string, input: Record<string, unknown> = {}) {
  const selected = (tools as Record<string, unknown>)[name] as {
    inputSchema: z.ZodType;
    execute: (input: unknown, options: unknown) => Promise<unknown>;
  };
  return (await selected.execute(selected.inputSchema.parse(input), {
    toolCallId: "fixture",
    messages: [],
  })) as Record<string, unknown>;
}

async function changeWorkflow(f: ReturnType<typeof fixture>) {
  const file = await call(f.tools, "read_file", { path: WORKFLOW });
  return call(f.tools, "stage_file", {
    path: WORKFLOW,
    expectedRevision: file.revision,
    content: CHANGED,
  });
}

describe("private publisher setup agent tools", () => {
  test("reads only regular blobs through pinned trees and searches arbitrary source as inert evidence", async () => {
    const f = fixture({
      "scripts/release.py": "raise RuntimeError('must never execute')\n# publish\n",
    });
    expect(await call(f.tools, "list_directory", { path: "" })).toMatchObject({
      ok: true,
      entries: expect.arrayContaining([{ path: "scripts", type: "tree", mode: "040000" }]),
    });
    expect(await call(f.tools, "read_file", { path: "scripts/release.py" })).toMatchObject({
      ok: true,
      content: expect.stringContaining("must never execute"),
      nextOffset: null,
    });
    expect(
      await call(f.tools, "search_files", { paths: ["scripts/release.py"], query: "PUBLISH" }),
    ).toMatchObject({ matches: [{ path: "scripts/release.py", line: 2, snippet: "# publish" }] });
    expect(
      f.request.mock.calls.every(([suffix]) => /^\/git\/(trees|blobs)\/[a-f0-9]{40}$/.test(suffix)),
    ).toBe(true);
    expect(setupAgentChangedFiles(f.state)).toEqual([]);
  });

  test.each([
    "../secret",
    "/tmp/secret",
    "https://example.com/source",
    ".git/config",
    "dir/../../secret",
    "a\\b",
    ".GIT/config",
    "new\nline.txt",
    `${"nested/".repeat(16)}file.txt`,
  ])("rejects unsafe path %s before requesting it", async (path) => {
    const f = fixture();
    expect(await call(f.tools, "read_file", { path })).toEqual({
      ok: false,
      error: "invalid_path",
    });
    expect(f.request).not.toHaveBeenCalled();
  });

  test.each<Record<string, string>>([{ "package.json": "120000" }, { ".github": "120000" }])(
    "rejects symlink files and ancestor directories",
    async (modes) => {
      const f = fixture({}, modes);
      const path = modes["package.json"] ? "package.json" : WORKFLOW;
      expect(await call(f.tools, "read_file", { path })).toEqual({
        ok: false,
        error: "unsupported_repository_entry",
      });
      expect(f.request.mock.calls.every(([suffix]) => !suffix.startsWith("/git/blobs/"))).toBe(
        true,
      );
    },
  );

  test("requires read-before-write and serializes conflicting edits", async () => {
    const f = fixture();
    expect(
      await call(f.tools, "stage_file", {
        path: WORKFLOW,
        expectedRevision: "0".repeat(64),
        content: CHANGED,
      }),
    ).toMatchObject({ error: "read_before_write_required" });
    const file = await call(f.tools, "read_file", { path: WORKFLOW });
    const result = await Promise.all([
      call(f.tools, "edit_file", {
        path: WORKFLOW,
        expectedRevision: file.revision,
        find: "Release",
        replace: "First",
      }),
      call(f.tools, "edit_file", {
        path: WORKFLOW,
        expectedRevision: file.revision,
        find: "Release",
        replace: "Second",
      }),
    ]);
    expect(result.filter((value) => value.ok === true)).toHaveLength(1);
    expect(result[1].ok).toBe(false);
    expect(f.state.files[WORKFLOW].content).toContain("First");
    expect(f.state.budgets.edits).toBe(1);
  });

  test("proves absence before creating files without treating absent reads as changes", async () => {
    const f = fixture();
    const missing = await call(f.tools, "read_file", { path: "custom/release.sh" });
    expect(missing).toMatchObject({ exists: false, content: "" });
    expect(setupAgentChangedFiles(f.state)).toEqual([]);
    expect(
      await call(f.tools, "stage_file", {
        path: "custom/release.sh",
        expectedRevision: missing.revision,
        content: "",
      }),
    ).toMatchObject({ ok: true });
    const created = await call(f.tools, "read_file", { path: "custom/release.sh" });
    expect(created).toMatchObject({ exists: true });
    expect(created.revision).not.toBe(missing.revision);
    expect(setupAgentChangedFiles(f.state)).toMatchObject([
      { path: "custom/release.sh", originalSha: null, content: "" },
    ]);
  });

  test("creates a confirmed-absent file without a prior read but never replaces one unread", async () => {
    const f = fixture({ "scripts/existing.mjs": "export {};\n" });
    expect(
      await call(f.tools, "stage_file", { path: "scripts/new.mjs", content: "export {};\n" }),
    ).toMatchObject({ ok: true });
    expect(setupAgentChangedFiles(f.state)).toMatchObject([
      { path: "scripts/new.mjs", originalSha: null },
    ]);
    expect(
      await call(f.tools, "stage_file", { path: "scripts/existing.mjs", content: "changed\n" }),
    ).toMatchObject({ error: "file_exists_read_first" });
    expect(
      await call(f.tools, "stage_file", { path: "scripts/new.mjs", content: "again\n" }),
    ).toMatchObject({ error: "file_exists_read_first" });
    expect(f.state.files["scripts/existing.mjs"]?.content).toBe("export {};\n");
  });
  test("refuses paths that differ only by letter case from a repository entry", async () => {
    const f = fixture({ "scripts/release.mjs": "export {};\n" });
    expect(await call(f.tools, "read_file", { path: "Scripts/release.mjs" })).toMatchObject({
      ok: false,
      error: "case_conflict",
    });
    expect(await call(f.tools, "read_file", { path: "scripts/Release.mjs" })).toMatchObject({
      ok: false,
      error: "case_conflict",
    });
    expect(f.state.missingFiles ?? []).toEqual([]);
  });
  test("requires a unique exact edit and the latest revision, which each edit returns", async () => {
    const f = fixture({ "text.txt": "same same" });
    const read = await call(f.tools, "read_file", { path: "text.txt" });
    expect(
      await call(f.tools, "edit_file", {
        path: "text.txt",
        expectedRevision: read.revision,
        find: "same",
        replace: "new",
      }),
    ).toMatchObject({ error: "find_must_match_once" });
    const changed = await changeWorkflow(f);
    const updated = await call(f.tools, "read_file", { path: WORKFLOW });
    expect(updated.revision).toBe(changed.revision);
    const edited = await call(f.tools, "edit_file", {
      path: WORKFLOW,
      expectedRevision: changed.revision,
      find: "Reviewed",
      replace: "Gated",
    });
    expect(edited).toMatchObject({ ok: true });
    expect(
      await call(f.tools, "edit_file", {
        path: WORKFLOW,
        expectedRevision: edited.revision,
        find: "Gated",
        replace: "Protected",
      }),
    ).toMatchObject({ ok: true });
    expect(
      await call(f.tools, "stage_file", {
        path: WORKFLOW,
        expectedRevision: updated.revision,
        content: CHANGED,
      }),
    ).toMatchObject({ error: "stale_file_revision" });
  });

  test("fails closed without release validation and never submits malformed YAML", async () => {
    const f = fixture();
    await changeWorkflow(f);
    const noValidator = createSetupAgentTools({ request: f.request }, f.state, "draft");
    expect(await call(noValidator, "submit_changes", { summary: "Prepare" })).toMatchObject({
      error: "validation_failed",
      issues: ["Release validation is unavailable."],
    });
    const read = await call(f.tools, "read_file", { path: WORKFLOW });
    await call(f.tools, "stage_file", {
      path: WORKFLOW,
      expectedRevision: read.revision,
      content: "jobs: [",
    });
    expect(await call(f.tools, "submit_changes", { summary: "Prepare" })).toMatchObject({
      error: "validation_failed",
      issues: [expect.stringContaining("Invalid bounded YAML")],
    });
    expect(f.state.submitted).toBeUndefined();
  });

  test("accepts an oversized submission summary and stores it shortened", async () => {
    const f = fixture();
    await changeWorkflow(f);
    const summary = `Gate publication. ${"Package before the gate. ".repeat(80)}`;
    expect(await call(f.tools, "submit_changes", { summary })).toMatchObject({ ok: true });
    expect(f.state.submitted?.summary.length).toBeLessThanOrEqual(1000);
    expect(f.state.submitted?.summary).toMatch(/^Gate publication\..*…$/);
  });

  test("binds successful submission and independent assessment to the complete frozen digest", async () => {
    const f = fixture();
    await changeWorkflow(f);
    const submitted = await call(f.tools, "submit_changes", { summary: "Gate publication" });
    expect(submitted).toMatchObject({ ok: true, digest: await setupAgentCandidateDigest(f.state) });
    const read = await call(f.tools, "read_file", { path: WORKFLOW });
    expect(
      await call(f.tools, "stage_file", {
        path: WORKFLOW,
        expectedRevision: read.revision,
        content: ORIGINAL,
      }),
    ).toMatchObject({ error: "workspace_frozen" });
    f.state.candidateDigest = String(submitted.digest);
    const judge = createSetupAgentTools({ request: f.request }, f.state, "judge", {
      validateChanges: f.validateChanges,
    });
    expect(Object.keys(judge)).not.toEqual(
      expect.arrayContaining(["stage_file", "edit_file", "submit_changes"]),
    );
    await call(judge, "inspect_changes", { path: WORKFLOW });
    expect(
      await call(judge, "finish_review", { verdict: "pass", summary: "Checked", issues: [] }),
    ).toEqual({ ok: true });
    expect(f.state.assessment).toEqual({
      verdict: "pass",
      summary: "Checked",
      issues: [],
      digest: submitted.digest,
    });
    expect(f.request.mock.calls.every(([suffix]) => suffix.startsWith("/git/"))).toBe(true);
  });

  test("rejects a modified candidate and a pass verdict with unresolved issues", async () => {
    const f = fixture();
    await changeWorkflow(f);
    const submitted = await call(f.tools, "submit_changes", { summary: "Gate publication" });
    f.state.candidateDigest = String(submitted.digest);
    const judge = createSetupAgentTools({ request: f.request }, f.state, "judge", {
      validateChanges: f.validateChanges,
    });
    expect(
      await call(judge, "finish_review", {
        verdict: "pass",
        summary: "Checked",
        issues: ["Unresolved"],
      }),
    ).toMatchObject({ error: "pass_cannot_have_issues" });
    f.state.files[WORKFLOW].content += "# unreviewed\n";
    expect(
      await call(judge, "finish_review", { verdict: "pass", summary: "Checked", issues: [] }),
    ).toMatchObject({ error: "candidate_digest_mismatch" });
    expect(f.state.assessment).toBeUndefined();
  });

  test("paginates both original and proposed files without losing the complete inventory", async () => {
    const f = fixture();
    await changeWorkflow(f);
    const result = await call(f.tools, "inspect_changes", {
      path: WORKFLOW,
      offset: 10,
      maxChars: 8,
    });
    expect(result).toMatchObject({
      files: [{ path: WORKFLOW }],
      changes: [{ before: ORIGINAL.slice(10, 18), after: CHANGED.slice(10, 18), nextOffset: 18 }],
    });
  });

  test("enforces byte/read budgets and does not leak upstream errors", async () => {
    const f = fixture({ "large.txt": "x".repeat(65_537) });
    expect(await call(f.tools, "read_file", { path: "large.txt" })).toMatchObject({
      error: "repository_file_unavailable",
    });
    f.state.budgets.reads = 200;
    const fresh = createSetupAgentTools({ request: f.request }, f.state, "draft");
    expect(await call(fresh, "read_file", { path: WORKFLOW })).toMatchObject({
      error: "repository_read_budget_exhausted",
    });
    const broken = fixture();
    broken.request.mockRejectedValue(new Error("sensitive token"));
    expect(await call(broken.tools, "read_file", { path: WORKFLOW })).toEqual({
      ok: false,
      error: "repository_tool_failed",
    });
  });

  test("preserves read-before-write proof across private JSON checkpoints", async () => {
    const f = fixture();
    const read = await call(f.tools, "read_file", { path: WORKFLOW });
    const restored: SetupAgentState = JSON.parse(JSON.stringify(f.state));
    const tools = createSetupAgentTools({ request: f.request }, restored, "draft", {
      validateChanges: f.validateChanges,
    });
    expect(
      await call(tools, "stage_file", {
        path: WORKFLOW,
        expectedRevision: read.revision,
        content: CHANGED,
      }),
    ).toMatchObject({ ok: true });
    expect(f.state.files[WORKFLOW].content).toBe(ORIGINAL);
    expect(restored.files[WORKFLOW].content).toBe(CHANGED);
  });

  test("enforces changed-file and aggregate-byte limits before staging", async () => {
    const f = fixture();
    await changeWorkflow(f);
    for (let i = 0; i < 12; i++) {
      const path = `generated/${i}.txt`;
      const read = await call(f.tools, "read_file", { path });
      expect(
        await call(f.tools, "stage_file", {
          path,
          expectedRevision: read.revision,
          content: "bounded",
        }),
      ).toMatchObject({ ok: true });
    }
    const missing = await call(f.tools, "read_file", { path: "generated/overflow.txt" });
    expect(
      await call(f.tools, "stage_file", {
        path: "generated/overflow.txt",
        expectedRevision: missing.revision,
        content: "extra",
      }),
    ).toMatchObject({ error: "candidate_budget_exhausted" });
    expect(setupAgentChangedFiles(f.state)).toHaveLength(13);

    const bytes = fixture();
    for (let i = 0; i < 4; i++) {
      const path = `large-${i}.txt`;
      const read = await call(bytes.tools, "read_file", { path });
      expect(
        await call(bytes.tools, "stage_file", {
          path,
          expectedRevision: read.revision,
          content: "x".repeat(65_536),
        }),
      ).toMatchObject({ ok: true });
    }
    const read = await call(bytes.tools, "read_file", { path: WORKFLOW });
    expect(
      await call(bytes.tools, "stage_file", {
        path: WORKFLOW,
        expectedRevision: read.revision,
        content: CHANGED,
      }),
    ).toMatchObject({ error: "candidate_budget_exhausted" });
    expect(bytes.state.files[WORKFLOW].content).toBe(ORIGINAL);
  });

  test("binds every supporting file into the digest independently of cache insertion order", async () => {
    const f = fixture();
    await changeWorkflow(f);
    const missing = await call(f.tools, "read_file", { path: "scripts/arbitrary.js" });
    const before = await setupAgentCandidateDigest(f.state);
    expect(
      await call(f.tools, "stage_file", {
        path: "scripts/arbitrary.js",
        expectedRevision: missing.revision,
        content: "throw new Error('never execute generated code');",
      }),
    ).toMatchObject({ ok: true });
    const after = await setupAgentCandidateDigest(f.state);
    expect(after).not.toBe(before);
    f.state.files = Object.fromEntries(Object.entries(f.state.files).reverse());
    expect(await setupAgentCandidateDigest(f.state)).toBe(after);
  });

  test("paginates directory metadata and bounds cumulative decoded source bytes", async () => {
    const extra = Object.fromEntries(
      Array.from({ length: 260 }, (_, i) => [`item-${String(i).padStart(3, "0")}.txt`, "x"]),
    );
    const f = fixture(extra);
    const page = await call(f.tools, "list_directory", { path: "" });
    expect(page.entries as unknown[]).toHaveLength(250);
    expect(page.nextOffset).toBe(250);
    expect(await call(f.tools, "list_directory", { path: "", offset: 250 })).toMatchObject({
      nextOffset: null,
      truncated: false,
    });
    f.state.budgets.bytes = 2_097_152;
    expect(await call(f.tools, "read_file", { path: "package.json" })).toMatchObject({
      error: "repository_byte_budget_exhausted",
    });
  });

  test("treats prototype-shaped repository filenames as ordinary own dictionary entries", async () => {
    const f = fixture();
    const before = Object.getPrototypeOf(f.state.files);
    const read = await call(f.tools, "read_file", { path: "__proto__" });
    expect(
      await call(f.tools, "stage_file", {
        path: "__proto__",
        expectedRevision: read.revision,
        content: "ordinary source",
      }),
    ).toMatchObject({ ok: true });
    expect(Object.getPrototypeOf(f.state.files)).toBe(before);
    expect(Object.hasOwn(f.state.files, "__proto__")).toBe(true);
    expect((await call(f.tools, "read_file", { path: "__proto__" })).content).toBe(
      "ordinary source",
    );
    const restored = JSON.parse(JSON.stringify(f.state));
    expect(Object.hasOwn(restored.files, "__proto__")).toBe(true);
    expect(restored.files.__proto__.content).toBe("ordinary source");
  });

  test("allows script-only changes after loading the selected unchanged workflow", async () => {
    const f = fixture({ "scripts/release.js": "original source" });
    const script = await call(f.tools, "read_file", { path: "scripts/release.js" });
    await call(f.tools, "stage_file", {
      path: "scripts/release.js",
      expectedRevision: script.revision,
      content: "reviewed source",
    });
    expect(
      await call(f.tools, "submit_changes", { summary: "Update release script" }),
    ).toMatchObject({
      error: "validation_failed",
      issues: ["Read the selected workflow before submitting changes."],
    });
    await call(f.tools, "read_file", { path: WORKFLOW });
    expect(
      await call(f.tools, "submit_changes", { summary: "Update release script" }),
    ).toMatchObject({ ok: true });
    expect(setupAgentChangedFiles(f.state).map((file) => file.path)).toEqual([
      "scripts/release.js",
    ]);
    expect(f.state.files[WORKFLOW].content).toBe(ORIGINAL);
  });

  test("requires contiguous judge coverage of every changed file's complete original and proposed text", async () => {
    const f = fixture({ "scripts/release.js": "x".repeat(24_001) });
    await changeWorkflow(f);
    const script = await call(f.tools, "read_file", { path: "scripts/release.js" });
    await call(f.tools, "stage_file", {
      path: "scripts/release.js",
      expectedRevision: script.revision,
      content: "short replacement",
    });
    // Draft-phase inspection must not satisfy the independent judge's coverage.
    await call(f.tools, "inspect_changes", { path: WORKFLOW });
    await call(f.tools, "inspect_changes", { path: "scripts/release.js" });
    const submitted = await call(f.tools, "submit_changes", { summary: "Gate publication" });
    f.state.candidateDigest = String(submitted.digest);
    let judge = createSetupAgentTools({ request: f.request }, f.state, "judge", {
      validateChanges: f.validateChanges,
    });
    const finish = () =>
      call(judge, "finish_review", { verdict: "pass", summary: "Checked", issues: [] });
    expect(await finish()).toMatchObject({
      error: "inspection_incomplete",
      unreadPaths: [WORKFLOW, "scripts/release.js"],
    });
    await call(judge, "inspect_changes", { path: WORKFLOW });
    await call(judge, "inspect_changes", { path: "scripts/release.js", offset: 12_000 });
    expect(await finish()).toMatchObject({
      error: "inspection_incomplete",
      unreadPaths: ["scripts/release.js"],
    });
    await call(judge, "inspect_changes", { path: "scripts/release.js", offset: 0 });
    await call(judge, "inspect_changes", { path: "scripts/release.js", offset: 24_000 });
    expect(await finish()).toMatchObject({ error: "inspection_incomplete" });
    const restored: SetupAgentState = JSON.parse(JSON.stringify(f.state));
    judge = createSetupAgentTools({ request: f.request }, restored, "judge", {
      validateChanges: f.validateChanges,
    });
    await call(judge, "inspect_changes", { path: "scripts/release.js", offset: 12_000 });
    expect(await finish()).toMatchObject({ error: "inspection_incomplete" });
    await call(judge, "inspect_changes", { path: "scripts/release.js", offset: 24_000 });
    expect(await finish()).toEqual({ ok: true });
    expect(restored.assessment?.digest).toBe(submitted.digest);
  });

  test("requires actionable negative findings and bounds the issue count", async () => {
    const f = fixture();
    await changeWorkflow(f);
    const submitted = await call(f.tools, "submit_changes", { summary: "Gate publication" });
    f.state.candidateDigest = String(submitted.digest);
    const judge = createSetupAgentTools({ request: f.request }, f.state, "judge", {
      validateChanges: f.validateChanges,
    });
    expect(
      await call(judge, "finish_review", {
        verdict: "changes_requested",
        summary: "Incomplete",
        issues: [],
      }),
    ).toMatchObject({ error: "changes_requested_requires_issues" });
    await expect(
      call(judge, "finish_review", {
        verdict: "changes_requested",
        summary: "Incomplete",
        issues: Array(9).fill("Issue"),
      }),
    ).rejects.toThrow();
    expect(
      await call(judge, "finish_review", {
        verdict: "changes_requested",
        summary: "Incomplete",
        issues: ["The publish script loses its build step."],
      }),
    ).toEqual({ ok: true });
  });

  test("limits supporting scripts to twelve even when the selected workflow is unchanged", async () => {
    const f = fixture();
    await call(f.tools, "read_file", { path: WORKFLOW });
    for (let i = 0; i < 12; i++) {
      const path = `scripts/${i}.js`;
      const read = await call(f.tools, "read_file", { path });
      expect(
        await call(f.tools, "stage_file", {
          path,
          expectedRevision: read.revision,
          content: "inert source",
        }),
      ).toMatchObject({ ok: true });
    }
    const path = "scripts/overflow.js";
    const read = await call(f.tools, "read_file", { path });
    expect(
      await call(f.tools, "stage_file", {
        path,
        expectedRevision: read.revision,
        content: "extra source",
      }),
    ).toMatchObject({ error: "candidate_budget_exhausted" });
    f.state.files[path] = {
      path,
      originalSha: null,
      originalContent: null,
      content: "older checkpoint with thirteen scripts",
    };
    expect(await call(f.tools, "submit_changes", { summary: "Update scripts" })).toMatchObject({
      error: "validation_failed",
      issues: ["The proposed change exceeds its file or byte budget."],
    });
    expect(f.state.submitted).toBeUndefined();
  });

  test("batches pinned reads with independent missing, invalid-path, and symlink results", async () => {
    const f = fixture({ "linked.js": "untrusted symlink target" }, { "linked.js": "120000" });
    const result = await call(f.tools, "read_files", {
      paths: [WORKFLOW, "package.json", "scripts/new.js", "../secret", "linked.js"],
    });
    expect(result).toMatchObject({
      ok: true,
      files: [
        { ok: true, path: WORKFLOW, content: ORIGINAL, exists: true },
        { ok: true, path: "package.json", exists: true },
        { ok: true, path: "scripts/new.js", exists: false, content: "" },
        { ok: false, path: "../secret", error: "invalid_path" },
        { ok: false, path: "linked.js", error: "unsupported_repository_entry" },
      ],
    });
    const files = result.files as { path: string; revision?: string }[];
    expect(
      await call(f.tools, "stage_file", {
        path: "scripts/new.js",
        expectedRevision: files[2].revision,
        content: "inert generated source",
      }),
    ).toMatchObject({ ok: true });
    expect(await call(f.tools, "read_files", { paths: ["scripts/new.js"] })).toMatchObject({
      files: [{ content: "inert generated source", exists: true }],
    });
    const workflowRead = await call(f.tools, "read_file", { path: WORKFLOW });
    expect(workflowRead.revision).toBe(files[0].revision);
    expect(
      f.request.mock.calls.every(([suffix]) => /^\/git\/(trees|blobs)\/[a-f0-9]{40}$/.test(suffix)),
    ).toBe(true);
  });

  test("bounds batched content at forty-eight thousand characters and validates before reading", async () => {
    const paths = Array.from({ length: 8 }, (_, i) => `source-${i}.txt`);
    const f = fixture(Object.fromEntries(paths.map((path) => [path, "x".repeat(7000)])));
    expect(await call(f.tools, "read_files", { paths, maxChars: 12_000 })).toEqual({
      ok: false,
      error: "batch_content_budget_exhausted",
    });
    expect(f.request).not.toHaveBeenCalled();
    await expect(
      call(f.tools, "read_files", { paths: [...paths, "overflow.txt"] }),
    ).rejects.toThrow();
    const result = await call(f.tools, "read_files", { paths });
    const files = result.files as { content: string; nextOffset: number }[];
    expect(files).toHaveLength(8);
    expect(files.reduce((sum, file) => sum + file.content.length, 0)).toBe(48_000);
    expect(files.every((file) => file.nextOffset === 6000)).toBe(true);
    expect(await call(f.tools, "read_file", { path: paths[0], offset: 6000 })).toMatchObject({
      content: "x".repeat(1000),
      nextOffset: null,
    });
  });

  test("preserves per-file budget enforcement and redacts individual upstream batch failures", async () => {
    const f = fixture();
    f.request.mockRejectedValue(new Error("sensitive upstream value"));
    expect(await call(f.tools, "read_files", { paths: [WORKFLOW, "package.json"] })).toEqual({
      ok: true,
      files: [
        { ok: false, path: WORKFLOW, error: "repository_tool_failed" },
        { ok: false, path: "package.json", error: "repository_tool_failed" },
      ],
    });
    expect(f.state.readRevisions).toBeUndefined();
    const exhausted = fixture();
    exhausted.state.budgets.reads = 200;
    expect(
      await call(exhausted.tools, "read_files", { paths: [WORKFLOW, "package.json"] }),
    ).toMatchObject({
      files: [
        { error: "repository_read_budget_exhausted" },
        { error: "repository_read_budget_exhausted" },
      ],
    });
    expect(exhausted.request).not.toHaveBeenCalled();
  });

  test("reports workspace inventory and remaining budgets without source, network calls, or mutations", async () => {
    const marker = "private source must not appear in metadata";
    const f = fixture({ "scripts/release.js": marker });
    await call(f.tools, "read_files", { paths: [WORKFLOW, "scripts/release.js"] });
    const read = await call(f.tools, "read_file", { path: "scripts/release.js" });
    await call(f.tools, "stage_file", {
      path: "scripts/release.js",
      expectedRevision: read.revision,
      content: "changed source",
    });
    const before = JSON.stringify(f.state);
    const requestCount = f.request.mock.calls.length;
    const status = await call(f.tools, "workspace_status");
    expect(status).toMatchObject({
      ok: true,
      baseSha: BASE,
      selectedWorkflow: WORKFLOW,
      editable: true,
      cachedPaths: [WORKFLOW, "scripts/release.js"],
      changedFiles: [{ path: "scripts/release.js", bytes: 14 }],
      budgets: {
        reads: { used: f.state.budgets.reads, remaining: 200 - f.state.budgets.reads, limit: 200 },
        bytes: {
          used: f.state.budgets.bytes,
          remaining: 2_097_152 - f.state.budgets.bytes,
          limit: 2_097_152,
        },
        edits: { used: 1, remaining: 99, limit: 100 },
      },
    });
    expect(JSON.stringify(status)).not.toContain(marker);
    expect(JSON.stringify(status)).not.toContain("changed source");
    expect(JSON.stringify(f.state)).toBe(before);
    expect(f.request).toHaveBeenCalledTimes(requestCount);
    const judge = createSetupAgentTools({ request: f.request }, f.state, "judge");
    expect(await call(judge, "workspace_status")).toMatchObject({ editable: false });
    expect(await call(judge, "read_files", { paths: [WORKFLOW] })).toMatchObject({
      files: [{ content: ORIGINAL }],
    });
  });
});
