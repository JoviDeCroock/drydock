// Pure generators for the guided-setup artifacts. These produce copy-paste
// best-practice config; nothing here mutates a repo. The shapes mirror two
// authoritative references:
//   - npm staged publishing via trusted publishing (OIDC), per the
//     npm-trusted-publishing skill: stage-only OIDC, no NPM_TOKEN, publish-path
//     caching disabled, the credentialed job gated behind the `npm` environment.
//   - The Drydock PyPI workflow gate, per drydock-ci-example/.github/workflows/
//     release.yml: build → upload `pypi-release-candidate` → publish via Trusted
//     Publishing gated on a GitHub Environment; the publish job never rebuilds.

const DEFAULT_NPM_WORKFLOW_FILENAME = "release.yml";
const DEFAULT_NPM_ENVIRONMENT = "npm";
const DEFAULT_PYPI_ENVIRONMENT = "pypi";
const DEFAULT_PYTHON_VERSION = "3.12";

export interface NpmWorkflowInput {
  /** Published package name, e.g. `@scope/pkg` or `pkg`. Used for the env URL and identity check. */
  packageName: string;
  /** GitHub environment that gates the credentialed stage job. */
  environment?: string;
}

export interface NpmTrustInput {
  /** GitHub owner/org login. */
  owner: string;
  /** GitHub repository name (without owner). */
  repo: string;
  packageName: string;
  /** Workflow filename only (npm wants the filename, not the full path). */
  workflowFilename?: string;
  environment?: string;
}

export interface PypiWorkflowInput {
  /** GitHub environment that gates the publish job (must match the PyPI Trusted Publisher env). */
  environment?: string;
  pythonVersion?: string;
}

function safePackagePlaceholder(packageName: string): string {
  const trimmed = packageName.trim();
  return trimmed || "<package>";
}

/**
 * Generates a tag-triggered npm release workflow that stages the tarball through
 * trusted publishing. The build job has no credentials; only the `stage` job
 * gets `id-token: write`, runs behind the `npm` environment, disables the
 * package-manager cache, and validates the tarball identity before staging.
 */
export function npmStagedPublishWorkflow(input: NpmWorkflowInput): string {
  const pkg = safePackagePlaceholder(input.packageName);
  const environment =
    (input.environment ?? DEFAULT_NPM_ENVIRONMENT).trim() || DEFAULT_NPM_ENVIRONMENT;
  return `name: Release (npm staged publish via trusted publishing)

# Staged publishing: CI stages the tarball through npm trusted publishing (OIDC),
# Drydock reviews the staged release, and a maintainer approves the public
# release with 2FA. No long-lived NPM_TOKEN is used. Configure the npm trusted
# publisher (stage-only) before this runs — GitHub YAML alone does not enable
# trusted publishing.

on:
  push:
    tags: ["v*"]

permissions:
  contents: read

jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          registry-url: https://registry.npmjs.org
          # Never restore a dependency cache anywhere in the publish path, not
          # even in the uncredentialed build — a poisoned cache must not reach
          # the tarball that gets staged.
          package-manager-cache: false
      - run: npm ci --ignore-scripts
      - run: npm pack
      - uses: actions/upload-artifact@v4
        with:
          name: npm-tarball
          path: "*.tgz"
          if-no-files-found: error

  stage:
    needs: build
    runs-on: ubuntu-latest
    # The gate: only this job can mint the npm OIDC token, and it runs behind the
    # \`${environment}\` GitHub Environment so a maintainer-controlled deployment
    # policy applies before anything is staged.
    environment:
      name: ${environment}
      url: https://www.npmjs.com/package/${pkg}
    permissions:
      contents: read
      id-token: write # OIDC token exchange for npm trusted publishing
    steps:
      - uses: actions/download-artifact@v4
        with:
          name: npm-tarball
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          registry-url: https://registry.npmjs.org
          # Never restore a dependency cache in the credentialed publish path.
          package-manager-cache: false
      - name: Use npm with staged publishing
        run: npm install -g npm@^11.15.0
      - name: Stage the publish for review
        run: |
          TARBALL="$(ls *.tgz)"
          # Verify the tarball identity before staging; never stage an unexpected package.
          tar -xOf "$TARBALL" package/package.json | node -e '
            const p = JSON.parse(require("fs").readFileSync(0, "utf8"));
            if (p.name !== "${pkg}") { console.error("package name mismatch: " + p.name); process.exit(1); }
            console.log(p.name + "@" + p.version);
          '
          # Stage instead of publish — a maintainer approves the public release after Drydock review.
          npm stage publish "$TARBALL" --access public --tag latest
`;
}

/**
 * The npm-side trust configuration. Stage-only: enables `npm stage publish` and
 * disallows `npm publish`, so OIDC cannot bypass the staged approval gate.
 */
export function npmTrustCommand(input: NpmTrustInput): string {
  const pkg = safePackagePlaceholder(input.packageName);
  const owner = input.owner.trim() || "<owner>";
  const repo = input.repo.trim() || "<repo>";
  const workflow =
    (input.workflowFilename ?? DEFAULT_NPM_WORKFLOW_FILENAME).trim() ||
    DEFAULT_NPM_WORKFLOW_FILENAME;
  const environment =
    (input.environment ?? DEFAULT_NPM_ENVIRONMENT).trim() || DEFAULT_NPM_ENVIRONMENT;
  return `npm install -g npm@^11.15.0
npm trust github --repo ${owner}/${repo} --file ${workflow} --env ${environment} --allow-stage-publish --no-allow-publish ${pkg}
npm trust list ${pkg}`;
}

/**
 * The Drydock PyPI workflow gate, mirroring drydock-ci-example. Build uploads
 * `dist/*` as `pypi-release-candidate`; Drydock derives + reviews the release;
 * the publish job blocks on the GitHub Environment (where Drydock's deployment
 * protection rule lives) and downloads — never rebuilds — the reviewed bytes,
 * publishing via OIDC Trusted Publishing. No long-lived PyPI token is involved.
 */
export function pypiReleaseWorkflow(input: PypiWorkflowInput = {}): string {
  const environment =
    (input.environment ?? DEFAULT_PYPI_ENVIRONMENT).trim() || DEFAULT_PYPI_ENVIRONMENT;
  const python = (input.pythonVersion ?? DEFAULT_PYTHON_VERSION).trim() || DEFAULT_PYTHON_VERSION;
  return `name: Release (PyPI Trusted Publishing via Drydock gate)

# build  ->  upload dist/*  ->  [Drydock derives + reviews]  ->  publish
#
# Tag-triggered: pushing a \`v*\` tag builds the wheel + sdist and uploads
# dist/*. Drydock derives the release from the wheels/sdists (identity from
# METADATA/PKG-INFO, digests from the bytes) and reviews it. The publish job
# blocks on the \`${environment}\` GitHub Environment, where Drydock's deployment
# protection rule lives, and only resumes once the review approves. It never
# rebuilds — it downloads exactly what was reviewed, so integrity rests on
# GitHub artifact immutability. Publishing uses OIDC Trusted Publishing; no
# long-lived PyPI token is involved.

on:
  push:
    tags: ["v*"]

permissions:
  contents: read

jobs:
  build-release-artifacts:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-python@v5
        with:
          python-version: "${python}"

      - name: Build wheel + sdist
        run: |
          python -m pip install --upgrade build
          python -m build

      - name: Upload release candidate for review
        uses: actions/upload-artifact@v4
        with:
          # Drydock looks for an artifact named exactly "pypi-release-candidate".
          name: pypi-release-candidate
          path: dist/*
          if-no-files-found: error

  publish:
    needs: build-release-artifacts
    runs-on: ubuntu-latest
    # This is the gate. Drydock's deployment protection rule lives on this
    # environment; the job waits here until the review approves.
    environment: ${environment}
    permissions:
      id-token: write # OIDC token exchange for PyPI Trusted Publishing
      contents: read
    steps:
      # No checkout, no rebuild. We publish exactly the artifact Drydock
      # reviewed — GitHub artifact storage is immutable, so the bytes the gate
      # approved are the bytes we download here.
      - name: Download the reviewed candidate
        uses: actions/download-artifact@v4
        with:
          name: pypi-release-candidate
          path: dist

      - name: Publish to PyPI
        uses: pypa/gh-action-pypi-publish@release/v1
        with:
          packages-dir: dist/
`;
}

export const setupDefaults = {
  npmWorkflowFilename: DEFAULT_NPM_WORKFLOW_FILENAME,
  npmEnvironment: DEFAULT_NPM_ENVIRONMENT,
  pypiEnvironment: DEFAULT_PYPI_ENVIRONMENT,
  pypiWorkflowFilename: "release.yml",
} as const;
