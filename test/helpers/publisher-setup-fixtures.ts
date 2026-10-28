import type {
  PublisherSetupDraftRequest,
  PublisherSetupProposal,
} from "../../server/lib/github-app/setup-types";

export const SETUP_BASE_SHA = "a".repeat(40);
export const SETUP_BLOB_SHA = "b".repeat(40);
export const SETUP_DRAFT_REQUEST: PublisherSetupDraftRequest = {
  installationRowId: "installation-row",
  repositoryFullName: "octo/release",
  workflowPath: ".github/workflows/release.yml",
  baseSha: SETUP_BASE_SHA,
  environment: "production",
  ecosystem: "npm",
};
export const SETUP_ORIGINAL_WORKFLOW = `name: Release
on:
  workflow_dispatch:
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm run build
      - run: npm publish --provenance
`;
export const SETUP_PROPOSED_WORKFLOW = `name: Release
on:
  workflow_dispatch:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm run build
      - run: npm pack
      - uses: actions/upload-artifact@v4
        with:
          name: npm-release-candidate
          path: '*.tgz'
          if-no-files-found: error
  publish:
    needs: build
    environment: production
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          registry-url: https://registry.npmjs.org
      - uses: actions/download-artifact@v4
        with:
          name: npm-release-candidate
      - run: npm publish *.tgz --provenance
`;
export function setupProposal(
  overrides: Partial<PublisherSetupProposal> = {},
): PublisherSetupProposal {
  return {
    ...SETUP_DRAFT_REQUEST,
    repositoryId: 42,
    defaultBranch: "main",
    originalSha: SETUP_BLOB_SHA,
    content: SETUP_PROPOSED_WORKFLOW,
    summary: "Build once and review the uploaded package before publishing it.",
    manualSteps: ["Enable the Drydock protection rule."],
    expiresAt: Date.now() + 20 * 60_000,
    ...overrides,
  };
}
