import { isMap, isScalar, isSeq, parseDocument, Scalar, stringify } from "yaml";
import { PublisherSetupError } from "./setup-api";
import { npmArchivePrepareCommand, npmArchivePublishCommand } from "./setup-npm-archives";

export const NPM_PREPARE_TOKEN = "__DRYDOCK_NPM_PREPARE__";
export const NPM_PUBLISH_TOKEN = "__DRYDOCK_NPM_PUBLISH__";
export const NPM_STAGE_TOKEN = "__DRYDOCK_NPM_STAGE_PUBLISH__";
const commands = new Map([
  [NPM_PREPARE_TOKEN, npmArchivePrepareCommand],
  [NPM_PUBLISH_TOKEN, npmArchivePublishCommand("publish")],
  [NPM_STAGE_TOKEN, npmArchivePublishCommand("stage")],
]);

function transformCommands(content: string, expand: boolean): string {
  const document = parseDocument(content, { uniqueKeys: true });
  if (document.errors.length || document.warnings.length)
    throw new PublisherSetupError(
      "workflow_invalid",
      "The workflow must be valid YAML without duplicate keys or custom tags.",
      409,
    );
  const jobs = document.get("jobs", true);
  if (!isMap(jobs)) return content;
  const replacements = expand
    ? commands
    : new Map([...commands].map(([token, command]) => [command, token]));
  let changed = false;
  for (const job of jobs.items) {
    if (!isMap(job.value)) continue;
    const steps = job.value.get("steps", true);
    if (!isSeq(steps)) continue;
    for (const step of steps.items) {
      if (!isMap(step)) continue;
      const withValue = step.get("with", true);
      for (const scalar of [
        step.get("run", true),
        isMap(withValue) ? withValue.get("publish", true) : null,
      ]) {
        if (!isScalar(scalar) || typeof scalar.value !== "string") continue;
        const replacement = replacements.get(scalar.value);
        if (!replacement) continue;
        scalar.value = replacement;
        scalar.type = Scalar.QUOTE_DOUBLE;
        changed = true;
      }
    }
  }
  return changed ? document.toString({ lineWidth: 0 }) : content;
}

/** Only whole run/publish scalars expand; repository prose cannot interpolate code. */
export function materializeSetupCommands(content: string): string {
  return transformCommands(content, true);
}

/** The judge reviews known programs by contract; altered commands never collapse. */
export function summarizeSetupCommands(content: string): string {
  return transformCommands(content, false);
}

const setup = [
  { uses: "actions/checkout@v4", with: { "persist-credentials": false } },
  { uses: "pnpm/action-setup@v4", with: { version: "11" } },
  {
    uses: "actions/setup-node@v4",
    with: { "node-version": 24, "registry-url": "https://registry.npmjs.org" },
  },
  { run: "pnpm install --frozen-lockfile --ignore-scripts" },
  { run: "npm install -g npm@11.15.0" },
];
const versionJob = {
  "runs-on": "ubuntu-latest",
  permissions: { contents: "write", "pull-requests": "write" },
  outputs: { should_publish: "${{ steps.check.outputs.should_publish }}" },
  steps: [
    ...setup,
    {
      uses: "changesets/action@v1",
      id: "version",
      with: { version: "pnpm run version", commitMode: "github-api" },
      env: { GITHUB_TOKEN: "${{ secrets.GITHUB_TOKEN }}" },
    },
    {
      id: "check",
      if: "steps.version.outputs.hasChangesets == 'false'",
      run: "node .github/scripts/has-unpublished-packages.mjs",
    },
  ],
};
const publishIf = "needs.release.outputs.should_publish == 'true'";
const publisher = {
  uses: "changesets/action@v1",
  with: {
    publish: "node .github/scripts/stage-packages.mjs",
    createGithubReleases: true,
    commitMode: "github-api",
  },
  env: { GITHUB_TOKEN: "${{ secrets.GITHUB_TOKEN }}" },
};
const gitIdentity = {
  run: 'git config user.name "github-actions[bot]"\ngit config user.email "41898282+github-actions[bot]@users.noreply.github.com"',
};
const changesetsBefore = {
  name: "Release",
  on: { push: { branches: ["main"] } },
  concurrency: "${{ github.workflow }}-${{ github.ref }}",
  jobs: {
    release: versionJob,
    publish: {
      "runs-on": "ubuntu-latest",
      needs: "release",
      if: publishIf,
      environment: "production",
      permissions: { contents: "write", "id-token": "write" },
      steps: [...setup, gitIdentity, publisher],
    },
  },
};
const changesetsAfter = {
  ...changesetsBefore,
  jobs: {
    release: versionJob,
    prepare: {
      "runs-on": "ubuntu-latest",
      needs: "release",
      if: publishIf,
      outputs: { has_packages: "${{ steps.pack.outputs.has_packages }}" },
      steps: [
        ...setup,
        { id: "pack", run: NPM_PREPARE_TOKEN },
        {
          uses: "actions/upload-artifact@v4",
          with: {
            name: "npm-release-candidates",
            path: "drydock-release/",
            "if-no-files-found": "error",
          },
        },
      ],
    },
    publish: {
      "runs-on": "ubuntu-latest",
      needs: ["release", "prepare"],
      if: "needs.release.outputs.should_publish == 'true' && needs.prepare.outputs.has_packages == 'true'",
      environment: "production",
      permissions: { contents: "write", "id-token": "write" },
      steps: [
        setup[0],
        setup[2],
        setup[4],
        gitIdentity,
        {
          uses: "actions/download-artifact@v4",
          with: { name: "npm-release-candidates", path: "drydock-release" },
        },
        { ...publisher, with: { ...publisher.with, publish: NPM_STAGE_TOKEN } },
      ],
    },
  },
};

const rootBefore = {
  name: "Release",
  on: { workflow_dispatch: null },
  jobs: {
    release: {
      "runs-on": "ubuntu-latest",
      steps: [
        { uses: "actions/checkout@v4" },
        { run: "npm ci" },
        { run: "npm run build" },
        { run: "npm publish --provenance" },
      ],
    },
  },
};
const rootAfter = {
  ...rootBefore,
  jobs: {
    pack: {
      "runs-on": "ubuntu-latest",
      steps: [
        { uses: "actions/checkout@v4" },
        { run: "npm ci" },
        { run: "npm run build" },
        { run: "npm pack" },
        { run: "sha256sum *.tgz > SHA256SUMS" },
        {
          uses: "actions/upload-artifact@v4",
          with: {
            name: "npm-release-candidates",
            path: "*.tgz\nSHA256SUMS",
            "if-no-files-found": "error",
          },
        },
      ],
    },
    publish: {
      "runs-on": "ubuntu-latest",
      needs: "pack",
      environment: "production",
      permissions: { contents: "read", "id-token": "write" },
      steps: [
        setup[2],
        setup[4],
        { uses: "actions/download-artifact@v4", with: { name: "npm-release-candidates" } },
        { run: "sha256sum --check --strict SHA256SUMS" },
        { run: "npm publish *.tgz --ignore-scripts --provenance" },
      ],
    },
  },
};

export const SETUP_WORKED_EXAMPLES = [
  {
    case: "single npm package",
    evidence:
      "One public root package; the existing npm ci and npm run build produce its dist files. No custom publication hooks or workspace selection.",
    originalWorkflow: stringify(rootBefore, { lineWidth: 0 }),
    proposedWorkflow: stringify(rootAfter, { lineWidth: 0 }),
    explanation:
      "Preserve triggers and build commands; pack and hash before the environment; publish the single downloaded tarball with scripts disabled and existing provenance. OIDC configuration is a manual follow-up, not a reason to add credentials.",
  },
  {
    case: "pnpm Changesets staged monorepo",
    evidence:
      "The root is private; pnpm-workspace.yaml selects packages/* and private examples. The supplied custom stage script skips private/ignored/already-published packages, runs prepublishOnly builds via pnpm publishing, derives prerelease dist-tags and access, creates annotated tags, and emits New tag lines for Changesets GitHub releases.",
    originalWorkflow: stringify(changesetsBefore, { lineWidth: 0 }),
    proposedWorkflow: stringify(changesetsAfter, { lineWidth: 0 }),
    explanation:
      "Keep the version-only action, release conditions/outputs, existing action pins and git identity. Prepare packages before entering the environment, including prepublishOnly then pnpm pack so workspace dependencies are transformed. Stage each reviewed tarball with its recorded access/tag and scripts disabled, retaining Changesets tag/release behavior. Never replace stage publishing with direct publication or run a directory publisher after the gate. Skip the protected job when selection is empty.",
  },
];

export const NPM_ARCHIVE_TEMPLATE_CONTRACT = `Reserved whole-scalar tokens expand on the server into reviewed inline Node programs, not repository scripts. ${NPM_PREPARE_TOKEN}: discover root and supported workspace packages, preserve Changesets ignore/private/already-published selection, run prepublishOnly before pnpm pack, preserve workspace dependency rewriting, and record per-package access/prerelease tag in drydock-release/manifest.json plus exact .tgz bytes and SHA256SUMS; output has_packages. ${NPM_STAGE_TOKEN}: verify the entire bundle/manifest/digests/source commit and safe filenames before staging exact tarballs with npm stage publish --ignore-scripts, preserving access/tag, annotated Git tags and New tag output. ${NPM_PUBLISH_TOKEN}: the same contract using npm publish for sources that directly publish. Use tokens exactly in a run scalar, or publish input on an existing Changesets action. Download into drydock-release. Do not retype, edit, wrap, or concatenate the tokens. These templates support simple workspace paths, not arbitrary custom selection or postpublish hooks; missing or incompatible evidence requires manual setup. The judge sees tokens only for exact canonical program bytes that passed deterministic validation.`;
