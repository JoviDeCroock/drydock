import {
  buildVscodeReleaseManifest,
  extensionIdFromManifest,
  inferVscodeArtifactKind,
  normalizeVsixFiles,
  parseVscodeExtensionManifest,
  vscodeAdapter,
} from "./";
import { erasePackageAdapter } from "../package-adapter";
import { WorkflowArtifactError } from "../../github-app/artifacts";
import {
  GATE_SETUP_ACTIONS,
  GATE_SETUP_PINNING_NOTE,
  GATE_SETUP_NPM_CLI_VERSION,
} from "../../workflow-gates/gate-setup-actions";
import { buildManifestOrFail, groupReleaseCandidates } from "../../workflow-gates/group-candidates";
import type {
  GateSetupTemplate,
  GateSetupTemplateInput,
  ParsedGateArtifact,
  PreparedReleaseCandidate,
  WorkflowArtifactKind,
  WorkflowGateAdapter,
} from "../../workflow-gates/types";

const VSCODE_GATE_ARTIFACT_NAME = "vscode-release-candidate";

// No `detectArtifact`: VSIX has an unambiguous `.vsix` extension, and content
// detection only runs for extension-ambiguous tar archives. Claiming there
// would let npm/PyPI tarballs that happen to contain `extension/package.json`
// masquerade as VSIX.
export const vscodeWorkflowGateAdapter: WorkflowGateAdapter = {
  ecosystem: "vscode",
  artifactName: VSCODE_GATE_ARTIFACT_NAME,
  packageAdapter: erasePackageAdapter(vscodeAdapter),

  classifyArtifact(path: string): WorkflowArtifactKind | null {
    return inferVscodeArtifactKind(path);
  },

  prepareReleaseCandidates(artifacts: ParsedGateArtifact[]): PreparedReleaseCandidate[] {
    return groupReleaseCandidates(artifacts, {
      identity(artifact) {
        const manifest = parseExtensionManifest(artifact);
        const extensionId = extensionIdFromManifest(manifest);
        // The Marketplace resolves publisher/name case-insensitively, and the
        // parser accepts grandfathered capitalized names, so group by a
        // normalized lowercase key. This fails closed on case-only duplicates
        // (e.g. golang.Go and golang.go) instead of splitting them into two
        // review candidates, while the stored value keeps the original id.
        return { key: extensionId.toLowerCase(), name: extensionId, version: manifest.version };
      },
      allowMultiplePerGroup: false,
      duplicateMessage: (identity) =>
        `extension ${identity.name} has more than one VSIX artifact in this release`,
      buildManifest: (identity, [artifact]) =>
        buildManifestOrFail(
          () =>
            buildVscodeReleaseManifest(identity.name, identity.version, [
              { path: artifact.path, sha256: artifact.sha256 },
            ]),
          "derived VSIX release identity is not valid",
        ),
      candidate: (manifest, [artifact]) => ({
        ecosystem: "vscode",
        pipelineInput: {
          manifest,
          artifact: {
            path: artifact.path,
            sha256: artifact.sha256,
            files: artifact.files,
            ...(artifact.suspiciousEntries
              ? { suspiciousEntries: artifact.suspiciousEntries }
              : {}),
          },
        },
        package: { name: manifest.package, version: manifest.version },
      }),
    });
  },

  gateSetupTemplate(input: GateSetupTemplateInput): GateSetupTemplate {
    return vscodeGateSetupTemplate(input);
  },
};

/**
 * The VS Code extension publish workflow the setup wizard generates for a
 * maintainer to commit.
 *
 * Same contract as the canonical example in `docs/workflow-gates.md`: package
 * once, record `SHA256SUMS` beside the VSIX, upload both, pause at the gated
 * environment, re-check the digest on download, and publish the reviewed VSIX
 * bytes without repacking. The Marketplace has no OIDC path, so the PAT lives
 * in the gated environment's secrets — reachable only from the approved job.
 *
 * That PAT is not bound to this workflow and outlives the run, so the publish
 * job runs `vsce` from the repository's own lockfile, installed with scripts
 * off: pinning only `@vscode/vsce`'s version (say, `npx @vscode/vsce@x.y.z`)
 * still resolves its dependency ranges fresh on every run, and any newly
 * published release in that tree would load beside the credential.
 */
function vscodeGateSetupTemplate({
  environmentName,
  packageName,
}: GateSetupTemplateInput): GateSetupTemplate {
  return {
    workflowPath: ".github/workflows/drydock-vscode-release.yml",
    yaml: `# Drydock workflow gate — VS Code extension
# Extension: ${packageName}
# Drydock reviews the packaged VSIX before the publish job is allowed to run.
name: "Publish ${packageName}"

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
      - uses: ${GATE_SETUP_ACTIONS.checkout}
        with:
          # npm ci runs dependency install scripts next; keep the token off disk.
          persist-credentials: false
      - uses: ${GATE_SETUP_ACTIONS.setupNode}
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
      - uses: ${GATE_SETUP_ACTIONS.uploadArtifact}
        with:
          name: ${VSCODE_GATE_ARTIFACT_NAME}
          path: dist/

  publish:
    needs: package
    runs-on: ubuntu-latest
    # Drydock is this environment's deployment-protection rule: the job stays
    # queued until the release is approved in Drydock.
    environment: "${environmentName}"
    permissions:
      # Read access for the lockfile only; the Marketplace PAT is the credential.
      contents: read
    steps:
      - uses: ${GATE_SETUP_ACTIONS.checkout}
        with:
          persist-credentials: false
      - uses: ${GATE_SETUP_ACTIONS.setupNode}
        with:
          node-version: 22
          package-manager-cache: false
      # The lockfile's vsce and nothing newer, with no install scripts and no
      # git dependencies (npm still runs a git dependency's prepare scripts
      # under --ignore-scripts): this is the one job that can read the PAT.
      # Nothing here rebuilds the extension.
      - run: npm install -g npm@${GATE_SETUP_NPM_CLI_VERSION}
      - run: npm ci --ignore-scripts --allow-git=none
      - uses: ${GATE_SETUP_ACTIONS.downloadArtifact}
        with:
          name: ${VSCODE_GATE_ARTIFACT_NAME}
          path: dist
      # Fail closed if the downloaded bytes drifted from what was reviewed.
      - run: cd dist && sha256sum --check --strict SHA256SUMS
      - run: ./node_modules/.bin/vsce publish --packagePath dist/extension.vsix
        env:
          VSCE_PAT: \${{ secrets.VSCE_PAT }}
`,
    notes: [
      `Store the Marketplace PAT as a secret on the \`${environmentName}\` environment, not as a repository secret — an environment secret is only readable from the job the gate has released.`,
      `Publish the reviewed VSIX bytes for \`${packageName}\`: repacking after approval breaks the review boundary.`,
      "Scope the PAT to the publisher and rotate it on the same schedule as any other release credential.",
      "Add `@vscode/vsce` to `devDependencies` and commit the lockfile. Both jobs run that exact tree — the publish job with install scripts off and git dependencies refused — because the PAT outlives the run: `npx @vscode/vsce@<version>` pins vsce itself but still resolves its dependencies fresh on every run. A git dependency anywhere in the lockfile is left out of the publish job's install, so keep vsce's tree free of them.",
      GATE_SETUP_PINNING_NOTE,
    ],
  };
}

function parseExtensionManifest(artifact: ParsedGateArtifact) {
  try {
    return parseVscodeExtensionManifest(normalizeVsixFiles(artifact.files)).manifest;
  } catch (err) {
    throw new WorkflowArtifactError(
      "artifact_identity_missing",
      err instanceof Error
        ? `${artifact.path}: ${err.message}`
        : `${artifact.path}: VSIX extension identity is not valid`,
    );
  }
}
