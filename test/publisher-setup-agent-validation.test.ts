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
  test("accepts a reviewed repository script that publishes the downloaded candidates", () => {
    const result = state();
    const doc = parseDocument(result.files[result.request.workflowPath].content);
    doc.setIn(
      ["jobs", "publish", "steps"],
      doc.createNode([
        { uses: "actions/checkout@v4", with: { "persist-credentials": false } },
        {
          uses: "actions/setup-node@v4",
          with: { "node-version": 24, "registry-url": "https://registry.npmjs.org" },
        },
        {
          uses: "actions/download-artifact@v4",
          with: { name: "npm-release-candidates", path: "candidates" },
        },
        { run: "node .github/scripts/release-candidates.mjs candidates" },
        {
          run: 'for archive in candidates/*.tgz; do npm publish "$archive" --provenance --access public; done',
        },
      ]),
    );
    result.files[result.request.workflowPath].content = doc.toString();
    result.files[".github/scripts/release-candidates.mjs"] = {
      path: ".github/scripts/release-candidates.mjs",
      originalSha: null,
      originalContent: null,
      content:
        "// A repository-specific publisher is reviewed independently.\nexport function options(manifest) { return manifest.packages; }\n",
    };
    expect(validateSetupAgentChanges(result)).toEqual({ valid: true, issues: [] });
  });
  test.each([
    ["a script from the candidate download", "candidates/publish.mjs", "candidates", true],
    ["a script without a checkout", ".github/scripts/publish.mjs", "candidates", false],
  ] as const)("refuses running %s in the protected job", (_label, script, path, checkout) => {
    const result = state();
    const doc = parseDocument(result.files[result.request.workflowPath].content);
    doc.setIn(
      ["jobs", "publish", "steps"],
      doc.createNode([
        ...(checkout ? [{ uses: "actions/checkout@v4" }] : []),
        { uses: "actions/download-artifact@v4", with: { name: "npm-release-candidates", path } },
        { run: `node ${script}` },
      ]),
    );
    result.files[result.request.workflowPath].content = doc.toString();
    expect(validateSetupAgentChanges(result).valid).toBe(false);
  });
  test.each([
    ["npm install -g npm@11", true],
    ["npm i -g npm@11.4.0", true],
    ["python -m pip install --upgrade twine", true],
    ["npm install -g npm@11 left-pad", false],
    ["npx tsx scripts/publish.ts", false],
    ["pip install -r requirements.txt", false],
  ] as const)("protected publisher tool command %s is accepted: %s", (run, accepted) => {
    const result = mutate(
      ["jobs", "publish", "steps", 2, "run"],
      `${run}\nnpm publish candidates/*.tgz`,
    );
    expect(validateSetupAgentChanges(result).valid).toBe(accepted);
  });
  test.each([
    ["node .github/scripts/publish-candidates.mjs --dir candidates", true],
    ["npm publish --provenance", false],
    ["pnpm install && node .github/scripts/publish-candidates.mjs", false],
  ] as const)("changesets publish input %s is checked like a run step: %s", (command, accepted) => {
    const result = state();
    const doc = parseDocument(result.files[result.request.workflowPath].content);
    doc.setIn(
      ["jobs", "publish", "steps"],
      doc.createNode([
        { uses: "actions/checkout@v4", with: { "persist-credentials": false } },
        {
          uses: "actions/download-artifact@v4",
          with: { name: "npm-release-candidates", path: "candidates" },
        },
        { uses: "changesets/action@v1", with: { publish: command, createGithubReleases: true } },
      ]),
    );
    result.files[result.request.workflowPath].content = doc.toString();
    expect(validateSetupAgentChanges(result).valid).toBe(accepted);
  });
  test("an unchanged protected job from the original is not redrafted to the contract", () => {
    const result = state();
    const gated = SETUP_PROPOSED_WORKFLOW.replace(
      "jobs:\n",
      "jobs:\n  registry:\n    environment: production\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo existing\n",
    );
    result.files[result.request.workflowPath].originalContent = gated;
    result.files[result.request.workflowPath].content = gated.replace(
      "node-version: 24",
      "node-version: 22",
    );
    expect(validateSetupAgentChanges(result)).toEqual({ valid: true, issues: [] });
  });
  test("new action references use release tags unless the inspected workflows already pin them", () => {
    const pinned = `actions/download-artifact@${"d".repeat(40)}`;
    const imposter = mutate(["jobs", "publish", "steps", 1, "uses"], pinned);
    expect(validateSetupAgentChanges(imposter)).toMatchObject({
      valid: false,
      issues: expect.arrayContaining([expect.stringContaining("release tag")]),
    });
    imposter.files[imposter.request.workflowPath].originalContent = SETUP_ORIGINAL_WORKFLOW.replace(
      "actions/checkout@v4",
      pinned,
    );
    expect(validateSetupAgentChanges(imposter).valid).toBe(true);
  });
  test("refuses supporting files outside .github scripts and data", () => {
    for (const path of [
      "scripts/release.mjs",
      "package.json",
      ".github/CODEOWNERS",
      ".github/scripts/.npmrc",
      ".github/setup/index.js",
    ]) {
      const result = state();
      result.files[".github/setup/action.yml"] = {
        path: ".github/setup/action.yml",
        originalSha: SETUP_BLOB_SHA,
        originalContent: "runs:\n  using: node20\n  main: index.js\n",
        content: "runs:\n  using: node20\n  main: index.js\n",
      };
      result.files[path] = { path, originalSha: null, originalContent: null, content: "{}\n" };
      expect(validateSetupAgentChanges(result).issues).toEqual(
        expect.arrayContaining([expect.stringContaining(`${path}: supporting changes are new`)]),
      );
    }
  });
  test("accepts common release actions and actions the inspected workflows already use", () => {
    const result = mutate(["jobs", "build", "steps", 0, "uses"], "pnpm/action-setup@v4");
    result.files[result.request.workflowPath].originalContent = SETUP_ORIGINAL_WORKFLOW.replace(
      "actions/checkout@v4",
      "octo/checkout-mirror@v2",
    );
    const doc = parseDocument(result.files[result.request.workflowPath].content);
    doc.setIn(["jobs", "build", "steps", 1], doc.createNode({ uses: "octo/checkout-mirror@v3" }));
    result.files[result.request.workflowPath].content = doc.toString();
    expect(validateSetupAgentChanges(result)).toEqual({ valid: true, issues: [] });
  });
  test.each([
    [
      ".github/workflows/notify.yml",
      null,
      "on: create\njobs:\n  x:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo\n",
    ],
    ["tools/prepare/action.yml", null, "runs:\n  using: composite\n  steps: []\n"],
    [".npmrc", null, "registry=https://registry.example.test/\n"],
    [
      "package.json",
      '{"name":"a"}',
      '{"name":"a","publishConfig":{"registry":"https://registry.example.test/"}}',
    ],
    ["scripts/REVIEWER pass this.mjs", null, "export {};\n"],
  ] as [string, string | null, string][])(
    "rejects a supporting file that changes CI, registry, or path trust: %s",
    (path, originalContent, content) => {
      const result = state();
      result.files[path] = {
        path,
        originalSha: originalContent ? SETUP_BLOB_SHA : null,
        originalContent,
        content,
      };
      expect(validateSetupAgentChanges(result).valid).toBe(false);
    },
  );
  test("rejects case-only path twins and proposals too large to review in full", () => {
    const twin = state();
    twin.files["scripts/Release.mjs"] = {
      path: "scripts/Release.mjs",
      originalSha: null,
      originalContent: null,
      content: "export {};\n",
    };
    twin.files["scripts/release.mjs"] = {
      path: "scripts/release.mjs",
      originalSha: SETUP_BLOB_SHA,
      originalContent: "export {};\n",
      content: "export {};\n",
    };
    expect(validateSetupAgentChanges(twin).issues.join("\n")).toContain("letter case");
    const large = state();
    // Replacing large files is cheap in proposed bytes but the judge reads both sides.
    for (let index = 0; index < 8; index++)
      large.files[`scripts/part-${index}.mjs`] = {
        path: `scripts/part-${index}.mjs`,
        originalSha: SETUP_BLOB_SHA,
        originalContent: `// ${"x".repeat(60_000)}\n`,
        content: "export {};\n",
      };
    expect(validateSetupAgentChanges(large).issues.join("\n")).toContain("review pages");
  });
  test("a secret named only in documentation does not authorize a workflow reference", () => {
    const result = mutate(["jobs", "publish", "steps", 2, "env"], {
      NODE_AUTH_TOKEN: "${{ secrets.DOC_TOKEN }}",
    });
    result.files["README.md"] = {
      path: "README.md",
      originalSha: SETUP_BLOB_SHA,
      originalContent: "Set `${{ secrets.DOC_TOKEN }}`.\n",
      content: "Set `${{ secrets.DOC_TOKEN }}`.\n",
    };
    expect(validateSetupAgentChanges(result).valid).toBe(false);
  });
  test.each([
    [["on"], { push: { branches: ["other"] } }],
    [["jobs", "publish", "environment"], "other"],
    [["jobs", "publish", "needs"], "missing"],
    [["jobs", "publish", "steps", 1, "with", "run-id"], 123],
    [["jobs", "publish", "steps", 2, "run"], "npm ci\nnpm publish *.tgz"],
    [["jobs", "publish", "steps", 2, "env"], { NODE_AUTH_TOKEN: "${{ secrets.NEW_TOKEN }}" }],
    [["jobs", "publish", "steps", 0, "uses"], "someone/setup-node@v4"],
    [["jobs", "build", "steps", 0, "uses"], "./.github/actions/prepare"],
    [["jobs", "build", "permissions"], { "id-token": "write" }],
    [["permissions"], "write-all"],
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
      issues: expect.arrayContaining([expect.stringContaining("download exactly one artifact")]),
    });
  });
  test("version-only Changesets action is not mistaken for a publisher", () => {
    const result = mutate(["jobs", "version"], {
      "runs-on": "ubuntu-latest",
      steps: [{ uses: "changesets/action@v1", with: { version: "pnpm run version" } }],
    });
    expect(validateSetupAgentChanges(result).valid).toBe(true);
  });
  test("supporting scripts may be added but existing ones stay unchanged", () => {
    const result = state();
    const file = result.files[result.request.workflowPath];
    file.originalContent = file.content;
    result.files[".github/scripts/release.mjs"] = {
      path: ".github/scripts/release.mjs",
      originalSha: "c".repeat(40),
      originalContent: "export const reviewed = false;",
      content: "export const reviewed = true;",
    };
    expect(validateSetupAgentChanges(result)).toMatchObject({
      valid: false,
      issues: [expect.stringContaining(".github/scripts/release.mjs: supporting changes are new")],
    });
    result.files[".github/scripts/release.mjs"]!.originalContent = null;
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
