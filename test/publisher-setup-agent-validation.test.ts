import { describe, expect, test } from "vitest";
import { parseDocument } from "yaml";
import { createSetupAgentState } from "../server/lib/github-app/setup-agent";
import { validateSetupAgentChanges } from "../server/lib/github-app/setup-agent-validation";
import {
  SETUP_DRAFT_REQUEST,
  SETUP_ORIGINAL_WORKFLOW,
  SETUP_PROPOSED_WORKFLOW,
  SETUP_BLOB_SHA,
} from "./helpers/publisher-setup-fixtures";

function state() {
  const result = createSetupAgentState(
    SETUP_DRAFT_REQUEST,
    {
      path: SETUP_DRAFT_REQUEST.workflowPath,
      sha: SETUP_BLOB_SHA,
      content: SETUP_ORIGINAL_WORKFLOW,
    },
    "draft",
  );
  result.files[result.request.workflowPath].content = SETUP_PROPOSED_WORKFLOW;
  return result;
}
function mutate(path: (string | number)[], value: unknown) {
  const result = state();
  const doc = parseDocument(result.files[result.request.workflowPath].content);
  doc.setIn(path, value);
  result.files[result.request.workflowPath].content = doc.toString();
  return result;
}

describe("generic setup observable release checks", () => {
  test("accepts repository-specific script changes instead of a publisher template", () => {
    const result = mutate(
      ["jobs", "publish", "steps", 2, "run"],
      "node scripts/release-candidates.mjs",
    );
    result.files["scripts/release-candidates.mjs"] = {
      path: "scripts/release-candidates.mjs",
      originalSha: null,
      originalContent: null,
      content:
        "// A repository-specific publisher is reviewed independently.\nexport function options(manifest) { return manifest.packages; }\n",
    };
    expect(validateSetupAgentChanges(result)).toEqual({ valid: true, issues: [] });
  });
  test.each([
    [["on"], { push: { branches: ["other"] } }],
    [["jobs", "publish", "environment"], "other"],
    [["jobs", "publish", "needs"], "missing"],
    [["jobs", "publish", "steps", 1, "with", "run-id"], 123],
    [["jobs", "publish", "steps", 2, "run"], "npm ci\nnpm publish *.tgz"],
    [["jobs", "publish", "steps", 2, "env"], { NODE_AUTH_TOKEN: "${{ secrets.NEW_TOKEN }}" }],
  ] as [(string | number)[], unknown][])(
    "rejects a verifiable release-contract violation %#",
    (path, value) => {
      expect(validateSetupAgentChanges(mutate(path, value)).valid).toBe(false);
    },
  );
  test("a second protected publisher cannot borrow another job's artifact download", () => {
    const result = mutate(["jobs", "secondPublish"], {
      "runs-on": "ubuntu-latest",
      environment: "production",
      steps: [{ run: "npm publish . --ignore-scripts" }],
    });
    expect(validateSetupAgentChanges(result)).toMatchObject({
      valid: false,
      issues: expect.arrayContaining([expect.stringContaining("every protected publisher")]),
    });
  });
  test("version-only Changesets action is not mistaken for a publisher", () => {
    const result = mutate(["jobs", "version"], {
      "runs-on": "ubuntu-latest",
      steps: [{ uses: "changesets/action@v1", with: { version: "pnpm run version" } }],
    });
    expect(validateSetupAgentChanges(result).valid).toBe(true);
  });
  test("allows script-only edits to an already gated workflow", () => {
    const result = state();
    const file = result.files[result.request.workflowPath];
    file.originalContent = file.content;
    result.files["scripts/release.mjs"] = {
      path: "scripts/release.mjs",
      originalSha: "c".repeat(40),
      originalContent: "export const reviewed = false;",
      content: "export const reviewed = true;",
    };
    expect(validateSetupAgentChanges(result).valid).toBe(true);
  });
  test("rejects thirteen supporting edits when the selected workflow is unchanged", () => {
    const result = state();
    const file = result.files[result.request.workflowPath];
    file.originalContent = file.content;
    for (let i = 0; i < 13; i++)
      result.files[`scripts/file-${i}.mjs`] = {
        path: `scripts/file-${i}.mjs`,
        originalSha: null,
        originalContent: null,
        content: "export {};",
      };
    expect(validateSetupAgentChanges(result).valid).toBe(false);
  });
  test("counts an unchanged selected workflow against the serialized proposal budget", () => {
    const result = state();
    const selected = result.files[result.request.workflowPath];
    selected.content += "\n# " + "x".repeat(20_000);
    selected.originalContent = selected.content;
    for (let i = 0; i < 4; i++)
      result.files[`scripts/large-${i}.mjs`] = {
        path: `scripts/large-${i}.mjs`,
        originalSha: null,
        originalContent: null,
        content: "x".repeat(63_000),
      };
    expect(validateSetupAgentChanges(result).valid).toBe(false);
  });

  test("reports malformed YAML without returning source text", () => {
    const result = state();
    result.files[result.request.workflowPath].content = "jobs: {}\njobs: PRIVATE_SOURCE";
    const validation = validateSetupAgentChanges(result);
    expect(validation.valid).toBe(false);
    expect(JSON.stringify(validation)).not.toContain("PRIVATE_SOURCE");
  });
});
