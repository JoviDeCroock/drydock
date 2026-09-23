/**
 * The Docs page's workflow examples: the exact files the setup wizard writes
 * for these placeholder names, so the page can say so. They are copies rather
 * than imports because the templates live in the Worker's ecosystem adapters,
 * which the browser bundle must not pull in; `test/workers/gate-setup-template.test.ts`
 * renders the adapters with the same inputs and fails when a copy drifts.
 */
export const GATE_WORKFLOW_EXAMPLE_ENVIRONMENT = "production";

export const GATE_WORKFLOW_EXAMPLES = {
  pypi: {
    packageName: "acme-toolkit",
    yaml: `# Drydock workflow gate — PyPI
# Project: acme-toolkit
# Drydock reviews the built wheels/sdist before the publish job is allowed to run.
name: "Publish acme-toolkit"

on:
  workflow_dispatch:
  push:
    tags:
      - "v*"

# No token scope by default; each job asks for exactly what it needs.
permissions: {}

jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          # The build runs third-party build backends; keep the token off disk.
          persist-credentials: false
      - uses: actions/setup-python@5fda3b95a4ea91299a34e894583c3862153e4b97 # v7.0.0
        with:
          python-version: "3.x"
      - run: python -m pip install build
      - run: python -m build
      # Record the digests Drydock reviews and the publish job re-checks.
      - run: cd dist && sha256sum *.whl *.tar.gz > SHA256SUMS
      - uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1
        with:
          name: pypi-release-candidate
          path: dist/

  publish:
    needs: build
    runs-on: ubuntu-latest
    # Drydock is this environment's deployment-protection rule: the job stays
    # queued until the release is approved in Drydock.
    environment: "production"
    permissions:
      # OIDC for PyPI trusted publishing; no API token exists in this workflow.
      id-token: write
    steps:
      - uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1
        with:
          name: pypi-release-candidate
          path: dist
      # Fail closed if the downloaded bytes drifted from what was reviewed.
      - run: cd dist && sha256sum --check --strict SHA256SUMS
      - run: rm dist/SHA256SUMS
      - uses: pypa/gh-action-pypi-publish@dc37677b2e1c63e2034f94d8a5b11f265b73ba33 # v1.14.2
`,
  },
  npm: {
    packageName: "@acme/toolkit",
    yaml: `# Drydock workflow gate — npm
# Package: @acme/toolkit
# Drydock reviews the packed tarballs before the publish job is allowed to run.
name: "Publish @acme/toolkit"

on:
  workflow_dispatch:
  push:
    tags:
      - "v*"

# No token scope by default; each job asks for exactly what it needs.
permissions: {}

jobs:
  pack:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          # npm ci runs dependency install scripts next; keep the token off disk.
          persist-credentials: false
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: 22
          # A release build restores no cache another workflow could have written.
          package-manager-cache: false
      # No registry pin on setup-node: that writes an .npmrc expecting an auth
      # token, and a token is exactly what this workflow exists to avoid.
      - run: npm ci
      - run: mkdir -p dist
      - run: npm pack --pack-destination dist
      # Record the digests Drydock reviews and the publish job re-checks.
      - run: cd dist && sha256sum *.tgz > SHA256SUMS
      - uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1
        with:
          name: npm-release-candidates
          path: dist/

  publish:
    needs: pack
    runs-on: ubuntu-latest
    # Drydock is this environment's deployment-protection rule: the job stays
    # queued until the release is approved in Drydock.
    environment: "production"
    permissions:
      # OIDC for npm trusted publishing; no npm token exists in this workflow.
      id-token: write
    steps:
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: 22
          package-manager-cache: false
      # npm's OIDC trusted publishing needs npm >= 11.5.1; the npm bundled with
      # Node 22 is older and would fall back to looking for a token that does
      # not exist here. Exact version: this job can mint a publish token.
      - run: npm install -g npm@11.19.1
      - uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1
        with:
          name: npm-release-candidates
          path: dist
      # Fail closed if the downloaded bytes drifted from what was reviewed.
      - run: cd dist && sha256sum --check --strict SHA256SUMS
      # Trusted publishing attaches provenance by itself from a public
      # repository; requesting it explicitly fails the publish from a private one.
      - run: |
          for tgz in dist/*.tgz; do
            npm publish "$tgz" --access public
          done
`,
  },
  vscode: {
    packageName: "acme.toolkit",
    yaml: `# Drydock workflow gate — VS Code extension
# Extension: acme.toolkit
# Drydock reviews the packaged VSIX before the publish job is allowed to run.
name: "Publish acme.toolkit"

on:
  workflow_dispatch:
  push:
    tags:
      - "v*"

# No token scope by default; each job asks for exactly what it needs.
permissions: {}

jobs:
  package:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          # npm ci runs dependency install scripts next; keep the token off disk.
          persist-credentials: false
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: 22
          # A release build restores no cache another workflow could have written.
          package-manager-cache: false
      - run: npm ci
      - run: mkdir -p dist
      # vsce comes from package-lock.json (a devDependency), never fetched ad hoc.
      - run: ./node_modules/.bin/vsce package --out dist/extension.vsix
      # Record the digest Drydock reviews and the publish job re-checks.
      - run: cd dist && sha256sum *.vsix > SHA256SUMS
      - uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1
        with:
          name: vscode-release-candidate
          path: dist/

  publish:
    needs: package
    runs-on: ubuntu-latest
    # Drydock is this environment's deployment-protection rule: the job stays
    # queued until the release is approved in Drydock.
    environment: "production"
    permissions:
      # Read access for the lockfile only; the Marketplace PAT is the credential.
      contents: read
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: 22
          package-manager-cache: false
      # The lockfile's vsce and nothing newer, with no install scripts: this is
      # the one job that can read the PAT. Nothing here rebuilds the extension.
      - run: npm ci --ignore-scripts
      - uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1
        with:
          name: vscode-release-candidate
          path: dist
      # Fail closed if the downloaded bytes drifted from what was reviewed.
      - run: cd dist && sha256sum --check --strict SHA256SUMS
      - run: ./node_modules/.bin/vsce publish --packagePath dist/extension.vsix
        env:
          VSCE_PAT: \${{ secrets.VSCE_PAT }}
`,
  },
} as const;
