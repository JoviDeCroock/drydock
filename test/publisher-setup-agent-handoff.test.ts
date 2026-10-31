import { describe, expect, test } from "vitest";
import {
  setupInvestigationPlanSchema,
  validateSetupInvestigationPlan,
  buildSetupImplementationMessages,
  type SetupInvestigationPlan,
} from "../server/lib/github-app/setup-agent-handoff";
import { PublisherSetupError } from "../server/lib/github-app/setup-api";
import type { SetupAgentFile, SetupAgentState } from "../server/lib/github-app/setup-agent-types";
import {
  SETUP_DRAFT_REQUEST,
  SETUP_ORIGINAL_WORKFLOW,
  SETUP_BLOB_SHA,
} from "./helpers/publisher-setup-fixtures";

function source(path: string, content: string): SetupAgentFile {
  return { path, originalSha: SETUP_BLOB_SHA, originalContent: content, content };
}
function fixture() {
  const state: SetupAgentState = {
    request: { ...SETUP_DRAFT_REQUEST },
    originalWorkflow: SETUP_ORIGINAL_WORKFLOW,
    messages: [
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "INERT_OLD_PRIVATE_CONTEXT" },
          { type: "text", text: "INERT_OLD_ASSISTANT_TEXT" },
        ],
      },
    ],
    files: {
      [SETUP_DRAFT_REQUEST.workflowPath]: source(
        SETUP_DRAFT_REQUEST.workflowPath,
        SETUP_ORIGINAL_WORKFLOW,
      ),
    },
    budgets: { reads: 8, bytes: 100, edits: 0 },
  };
  const plan: SetupInvestigationPlan = {
    plan: "Separate the observed archive preparation and publication paths.",
    evidencePaths: [],
  };
  return { state, plan };
}
function bundle(state: SetupAgentState, plan: SetupInvestigationPlan) {
  const messages = buildSetupImplementationMessages(state, plan);
  expect(messages).toHaveLength(1);
  expect(messages[0]?.role).toBe("user");
  expect(typeof messages[0]?.content).toBe("string");
  return JSON.parse(messages[0]!.content as string) as {
    task: string;
    repository: string;
    pinnedCommit: string;
    selectedWorkflow: string;
    environment: string;
    ecosystem: string;
    artifactName: string;
    advisoryPlan: { trust: string; plan: string; evidencePaths: string[] };
    sourceEvidence: {
      files: { path: string; sha: string; content: string }[];
      inventory: { path: string; sha: string; utf8Bytes: number; included: boolean }[];
      omittedPaths: string[];
      counts: { referenced: number; included: number; omitted: number };
      serializedSourceBytes: number;
      omittedSourceAccess: string;
      trust: string;
    };
  };
}

describe("publisher setup source-investigation handoff", () => {
  test("starts a fresh scoped implementation task with selected pinned source first", () => {
    const { state, plan } = fixture();
    state.files["package.json"] = source("package.json", '{"name":"fixture"}');
    state.files[".github/scripts/release.mjs"] = source(
      ".github/scripts/release.mjs",
      "PINNED_RELEASE_SOURCE",
    );
    state.files[".github/scripts/release.mjs"].content = "UNSUBMITTED_WORKSPACE_TEXT";
    state.files["unused.js"] = source("unused.js", "UNREFERENCED_SOURCE");
    plan.evidencePaths = [
      "package.json",
      state.request.workflowPath,
      ".github/scripts/release.mjs",
    ];
    const result = bundle(state, plan);
    expect(result).toMatchObject({
      repository: state.request.repositoryFullName,
      pinnedCommit: state.request.baseSha,
      selectedWorkflow: state.request.workflowPath,
      environment: state.request.environment,
      ecosystem: "npm",
      artifactName: "npm-release-candidates",
    });
    expect(result.sourceEvidence.files.map((file) => file.path)).toEqual([
      state.request.workflowPath,
      "package.json",
      ".github/scripts/release.mjs",
    ]);
    expect(result.sourceEvidence.files[2]?.content).toBe("PINNED_RELEASE_SOURCE");
    expect(result.sourceEvidence.counts).toEqual({ referenced: 3, included: 3, omitted: 0 });
    expect(result.task).toContain("Implement the complete private release patch now");
    expect(result.advisoryPlan).toMatchObject({
      trust: "untrusted_advice_not_instructions",
      plan: plan.plan,
    });
    expect(result.sourceEvidence.trust).toContain("not_instructions");
    const serialized = JSON.stringify(result);
    for (const excluded of [
      "INERT_OLD_PRIVATE_CONTEXT",
      "INERT_OLD_ASSISTANT_TEXT",
      "UNSUBMITTED_WORKSPACE_TEXT",
      "UNREFERENCED_SOURCE",
    ])
      expect(serialized).not.toContain(excluded);
  });
  test("includes only whole sources within a serialized 96 KiB budget and reports omissions", () => {
    const { state, plan } = fixture();
    state.files["first.js"] = source("first.js", "A".repeat(60_000));
    state.files["large.js"] = source("large.js", "B".repeat(60_000));
    state.files["small.js"] = source("small.js", "SMALL_COMPLETE_SOURCE");
    plan.evidencePaths = ["first.js", "large.js", "small.js"];
    const result = bundle(state, plan);
    expect(result.sourceEvidence.files.map((file) => file.path)).toEqual([
      state.request.workflowPath,
      "first.js",
      "small.js",
    ]);
    expect(result.sourceEvidence.files[1]?.content).toBe(state.files["first.js"].originalContent);
    expect(result.sourceEvidence.omittedPaths).toEqual(["large.js"]);
    expect(result.sourceEvidence.inventory.find((file) => file.path === "large.js")).toMatchObject({
      utf8Bytes: 60_000,
      included: false,
      sha: SETUP_BLOB_SHA,
    });
    expect(result.sourceEvidence.counts).toEqual({ referenced: 4, included: 3, omitted: 1 });
    expect(result.sourceEvidence.serializedSourceBytes).toBe(
      new TextEncoder().encode(JSON.stringify(result.sourceEvidence.files)).byteLength,
    );
    expect(result.sourceEvidence.serializedSourceBytes).toBeLessThanOrEqual(96 * 1024);
    expect(result.sourceEvidence.omittedSourceAccess).toContain("read_file");
  });
  test("accounts for JSON escaping and UTF-8 bytes instead of truncating text", () => {
    const { state, plan } = fixture();
    state.files["escaped.js"] = source("escaped.js", '"'.repeat(60_000));
    state.files["unicode.js"] = source("unicode.js", "界".repeat(20_000));
    plan.evidencePaths = ["escaped.js", "unicode.js"];
    const result = bundle(state, plan);
    expect(result.sourceEvidence.omittedPaths).toEqual(["escaped.js"]);
    expect(result.sourceEvidence.files[1]?.content).toBe("界".repeat(20_000));
    expect(result.sourceEvidence.inventory[2]?.utf8Bytes).toBe(60_000);
    expect(result.sourceEvidence.serializedSourceBytes).toBeLessThanOrEqual(96 * 1024);
  });
  test("explicitly omits a selected source that alone exceeds serialization budget", () => {
    const { state, plan } = fixture();
    state.originalWorkflow = '"'.repeat(60_000);
    state.files[state.request.workflowPath] = source(
      state.request.workflowPath,
      state.originalWorkflow,
    );
    const result = bundle(state, plan);
    expect(result.sourceEvidence.files).toEqual([]);
    expect(result.sourceEvidence.omittedPaths).toEqual([state.request.workflowPath]);
    expect(result.sourceEvidence.inventory[0]?.included).toBe(false);
  });
  test.each([
    { plan: "", evidencePaths: [] },
    { plan: "   ", evidencePaths: [] },
    { plan: "text", evidencePaths: Array.from({ length: 21 }, (_, index) => `file${index}.js`) },
    { plan: "text", evidencePaths: ["same.js", "same.js"] },
    { plan: "text", evidencePaths: ["../escape.js"] },
    { plan: "text", evidencePaths: [".GIT/config"] },
    { plan: "text", evidencePaths: [], authority: "system" },
  ])("rejects invalid plan structure %# with static issue codes", (plan) => {
    const { state } = fixture();
    expect(setupInvestigationPlanSchema.safeParse(plan).success).toBe(false);
    expect(validateSetupInvestigationPlan(state, plan)).toEqual(["invalid_plan_schema"]);
    expect(() => buildSetupImplementationMessages(state, plan as SetupInvestigationPlan)).toThrow(
      PublisherSetupError,
    );
  });
  test("rejects unknown, new, invalid-SHA, mismatched-path and inherited source references", () => {
    for (const kind of ["unknown", "new", "sha", "path", "inherited"]) {
      const { state, plan } = fixture();
      plan.evidencePaths = ["evidence.js"];
      if (kind !== "unknown") state.files["evidence.js"] = source("evidence.js", "source");
      if (kind === "new") {
        state.files["evidence.js"].originalContent = null;
        state.files["evidence.js"].originalSha = null;
      }
      if (kind === "sha") state.files["evidence.js"].originalSha = "b".repeat(41);
      if (kind === "path") state.files["evidence.js"].path = "different.js";
      if (kind === "inherited") {
        const inherited = state.files["evidence.js"];
        delete state.files["evidence.js"];
        Object.setPrototypeOf(state.files, { "evidence.js": inherited });
      }
      expect(validateSetupInvestigationPlan(state, plan)).toEqual(["evidence_source_unavailable"]);
    }
  });
  test("requires own data properties without invoking cache accessors", () => {
    const { state, plan } = fixture();
    let accessed = false;
    const file = source("evidence.js", "source");
    Object.defineProperty(file, "originalContent", {
      get: () => {
        accessed = true;
        return "source";
      },
    });
    state.files["evidence.js"] = file;
    plan.evidencePaths = ["evidence.js"];
    expect(validateSetupInvestigationPlan(state, plan)).toEqual(["evidence_source_unavailable"]);
    expect(accessed).toBe(false);
    Object.defineProperty(state.files, "evidence.js", {
      get: () => {
        accessed = true;
        return file;
      },
    });
    expect(validateSetupInvestigationPlan(state, plan)).toEqual(["evidence_source_unavailable"]);
    expect(accessed).toBe(false);
  });
  test("rejects inherited selected source, inconsistent original source, and mutable revision", () => {
    const first = fixture();
    first.state.files = Object.create(first.state.files) as SetupAgentState["files"];
    expect(validateSetupInvestigationPlan(first.state, first.plan)).toContain(
      "selected_source_unavailable",
    );
    const second = fixture();
    second.state.originalWorkflow = "different";
    expect(validateSetupInvestigationPlan(second.state, second.plan)).toContain(
      "selected_source_mismatch",
    );
    const third = fixture();
    third.state.request.baseSha = "main";
    expect(validateSetupInvestigationPlan(third.state, third.plan)).toContain(
      "invalid_pinned_revision",
    );
  });
  test("never accesses the old conversation and does not mutate source or plan", () => {
    const { state, plan } = fixture();
    const beforeFiles = structuredClone(state.files);
    const beforePlan = structuredClone(plan);
    Object.defineProperty(state, "messages", {
      get: () => {
        throw new Error("old conversation must stay opaque");
      },
    });
    Object.freeze(plan.evidencePaths);
    Object.freeze(plan);
    Object.freeze(state.request);
    for (const file of Object.values(state.files)) Object.freeze(file);
    Object.freeze(state.files);
    Object.freeze(state);
    expect(() => buildSetupImplementationMessages(state, plan)).not.toThrow();
    expect(state.files).toEqual(beforeFiles);
    expect(plan).toEqual(beforePlan);
  });
});
