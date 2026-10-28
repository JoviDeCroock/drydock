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
          name: npm-release-candidates
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
          name: npm-release-candidates
      - run: npm publish *.tgz --provenance
`;
// Publish-job shapes from the ecosystem workflow-gate guides. A draft that
// follows a guide must pass validation.
export const SETUP_NPM_GUIDE_WORKFLOW = `name: Release
on:
  workflow_dispatch:
jobs:
  pack:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm pack --json > pack.json
      - run: sha256sum *.tgz > SHA256SUMS
      - uses: actions/upload-artifact@v4
        with:
          name: npm-release-candidates
          path: |
            *.tgz
            SHA256SUMS
  publish:
    needs: pack
    runs-on: ubuntu-latest
    environment: production
    permissions:
      id-token: write
    steps:
      - uses: actions/download-artifact@v4
        with:
          name: npm-release-candidates
      - run: sha256sum --check --strict SHA256SUMS
      - run: npm publish *.tgz
`;
export const SETUP_NPM_STAGING_GUIDE_WORKFLOW = `name: Release
on:
  workflow_dispatch:
jobs:
  pack:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm pack --pack-destination dist
      - run: cd dist && sha256sum *.tgz > SHA256SUMS
      - uses: actions/upload-artifact@v4
        with:
          name: npm-release-candidates
          path: dist/
  stage:
    needs: pack
    runs-on: ubuntu-latest
    environment: production
    permissions:
      id-token: write
      contents: read
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          registry-url: https://registry.npmjs.org
      - run: npm install -g npm@^11.15.0
      - uses: actions/download-artifact@v4
        with:
          name: npm-release-candidates
          path: dist
      - run: cd dist && sha256sum --check --strict SHA256SUMS
      - run: npm stage publish dist/*.tgz
`;
export const SETUP_PYPI_ORIGINAL_WORKFLOW = `name: Release
on:
  release:
    types: [published]
jobs:
  release:
    runs-on: ubuntu-latest
    environment: pypi
    permissions:
      id-token: write
    steps:
      - uses: actions/checkout@v4
      - run: python -m build
      - uses: pypa/gh-action-pypi-publish@release/v1
`;
export const SETUP_PYPI_GUIDE_WORKFLOW = `name: Release
on:
  release:
    types: [published]
jobs:
  build-release-artifacts:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: python -m build
      - run: cd dist && sha256sum *.whl *.tar.gz > SHA256SUMS
      - uses: actions/upload-artifact@v4
        with:
          name: pypi-release-candidate
          path: |
            dist/*.whl
            dist/*.tar.gz
            dist/SHA256SUMS
          if-no-files-found: error
  publish:
    needs: build-release-artifacts
    runs-on: ubuntu-latest
    environment: pypi
    permissions:
      id-token: write
      contents: read
    steps:
      - uses: actions/download-artifact@v4
        with: { name: pypi-release-candidate, path: dist }
      - run: cd dist && sha256sum --check --strict SHA256SUMS
      - run: rm dist/SHA256SUMS
      - uses: pypa/gh-action-pypi-publish@release/v1
`;
export const SETUP_VSCODE_ORIGINAL_WORKFLOW = `name: Release
on:
  workflow_dispatch:
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npx @vscode/vsce publish
        env:
          VSCE_PAT: \${{ secrets.VSCE_PAT }}
`;
export const SETUP_VSCODE_GUIDE_WORKFLOW = `name: Release
on:
  workflow_dispatch:
jobs:
  package:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npx @vscode/vsce package --out dist/extension.vsix
      - run: cd dist && sha256sum *.vsix > SHA256SUMS
      - uses: actions/upload-artifact@v4
        with:
          name: vscode-release-candidate
          path: dist/
  publish:
    needs: package
    runs-on: ubuntu-latest
    environment: production
    steps:
      - uses: actions/download-artifact@v4
        with:
          name: vscode-release-candidate
          path: dist
      - run: cd dist && sha256sum --check --strict SHA256SUMS
      - run: npx @vscode/vsce publish --packagePath dist/extension.vsix
        env:
          VSCE_PAT: \${{ secrets.VSCE_PAT }}
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
