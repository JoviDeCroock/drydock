import {
  buildVscodeReleaseManifest,
  extensionIdFromManifest,
  inferVscodeArtifactKind,
  normalizeVsixFiles,
  parseVscodeExtensionManifest,
  vscodeAdapter,
} from "./";
import type { AdapterBroker, PackageAdapter } from "../package-adapter";
import { WorkflowArtifactError } from "../../github-app/artifacts";
import type {
  ArchiveContents,
  GateSetupTemplate,
  GateSetupTemplateInput,
  ParsedGateArtifact,
  PreparedReleaseCandidate,
  WorkflowArtifactKind,
  WorkflowGateAdapter,
} from "../../workflow-gates/types";

const VSCODE_GATE_ARTIFACT_NAME = "vscode-release-candidate";

export const vscodeWorkflowGateAdapter: WorkflowGateAdapter = {
  ecosystem: "vscode",
  artifactName: VSCODE_GATE_ARTIFACT_NAME,
  packageAdapter: vscodeAdapter as PackageAdapter<unknown, AdapterBroker>,

  classifyArtifact(path: string): WorkflowArtifactKind | null {
    return inferVscodeArtifactKind(path);
  },

  detectArtifact(contents: ArchiveContents): WorkflowArtifactKind | null {
    void contents;
    // VSIX has an unambiguous `.vsix` extension. Content detection only runs
    // for extension-ambiguous tar archives, so claiming here would let npm/PyPI
    // tarballs that happen to contain `extension/package.json` masquerade as VSIX.
    return null;
  },

  prepareReleaseCandidates(artifacts: ParsedGateArtifact[]): PreparedReleaseCandidate[] {
    return deriveVscodeReleaseCandidates(artifacts);
  },

  gateSetupTemplate(input: GateSetupTemplateInput): GateSetupTemplate {
    return vscodeGateSetupTemplate(input);
  },
};

/**
 * The VS Code extension publish workflow the setup wizard offers as a pull
 * request.
 *
 * Same contract as the canonical example in `docs/workflow-gates.md`: package
 * once, record `SHA256SUMS` beside the VSIX, upload both, pause at the gated
 * environment, re-check the digest on download, and publish the reviewed VSIX
 * bytes without repacking. The Marketplace has no OIDC path, so the PAT lives
 * in the gated environment's secrets — reachable only from the approved job.
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

jobs:
  package:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - run: npx @vscode/vsce package --out dist/extension.vsix
      # Record the digest Drydock reviews and the publish job re-checks.
      - run: cd dist && sha256sum *.vsix > SHA256SUMS
      - uses: actions/upload-artifact@v4
        with:
          name: ${VSCODE_GATE_ARTIFACT_NAME}
          path: dist/

  publish:
    needs: package
    runs-on: ubuntu-latest
    # Drydock is this environment's deployment-protection rule: the job stays
    # queued until the release is approved in Drydock.
    environment: "${environmentName}"
    steps:
      - uses: actions/download-artifact@v4
        with:
          name: ${VSCODE_GATE_ARTIFACT_NAME}
          path: dist
      # Fail closed if the downloaded bytes drifted from what was reviewed.
      - run: cd dist && sha256sum --check --strict SHA256SUMS
      - run: npx @vscode/vsce publish --packagePath dist/extension.vsix
        env:
          VSCE_PAT: \${{ secrets.VSCE_PAT }}
`,
    notes: [
      `Store the Marketplace PAT as a secret on the \`${environmentName}\` environment, not as a repository secret — an environment secret is only readable from the job the gate has released.`,
      `Publish the reviewed VSIX bytes for \`${packageName}\`: repacking after approval breaks the review boundary.`,
      "Scope the PAT to the publisher and rotate it on the same schedule as any other release credential.",
    ],
  };
}

function deriveVscodeReleaseCandidates(
  artifacts: ParsedGateArtifact[],
): PreparedReleaseCandidate[] {
  const groups = new Map<
    string,
    { extensionId: string; version: string; artifact: ParsedGateArtifact }
  >();
  for (const artifact of artifacts) {
    const files = normalizeVsixFiles(artifact.files);
    const { manifest: extensionManifest } = parseExtensionManifest(artifact, files);
    const extensionId = extensionIdFromManifest(extensionManifest);
    // The Marketplace resolves publisher/name case-insensitively, and the parser
    // accepts grandfathered capitalized names, so group by a normalized lowercase
    // key. This fails closed on case-only duplicates (e.g. golang.Go and
    // golang.go) instead of splitting them into two review candidates, while the
    // stored value keeps the original id for display.
    const identityKey = extensionId.toLowerCase();
    const group = groups.get(identityKey);
    if (!group) {
      groups.set(identityKey, { extensionId, version: extensionManifest.version, artifact });
      continue;
    }
    if (extensionManifest.version !== group.version) {
      throw new WorkflowArtifactError(
        "artifact_identity_inconsistent",
        `${artifact.path} version ${extensionManifest.version} disagrees with ${group.version} for ${extensionId}`,
      );
    }
    throw new WorkflowArtifactError(
      "artifact_identity_inconsistent",
      `extension ${extensionId} has more than one VSIX artifact in this release`,
    );
  }

  return [...groups.values()].map((group) => {
    const { artifact, extensionId, version } = group;
    const manifest = buildManifest(extensionId, version, artifact);
    return {
      ecosystem: "vscode",
      pipelineInput: {
        manifest,
        artifact: {
          path: artifact.path,
          sha256: artifact.sha256,
          files: artifact.files,
          ...(artifact.suspiciousEntries ? { suspiciousEntries: artifact.suspiciousEntries } : {}),
        },
      },
      package: { name: manifest.package, version: manifest.version },
    };
  });
}

function parseExtensionManifest(artifact: ParsedGateArtifact, files: ParsedGateArtifact["files"]) {
  try {
    return parseVscodeExtensionManifest(files);
  } catch (err) {
    throw new WorkflowArtifactError(
      "artifact_identity_missing",
      err instanceof Error
        ? `${artifact.path}: ${err.message}`
        : `${artifact.path}: VSIX extension identity is not valid`,
    );
  }
}

function buildManifest(extensionId: string, version: string, artifact: ParsedGateArtifact) {
  try {
    return buildVscodeReleaseManifest(extensionId, version, [
      { path: artifact.path, sha256: artifact.sha256 },
    ]);
  } catch (err) {
    throw new WorkflowArtifactError(
      "artifact_identity_missing",
      err instanceof Error ? err.message : "derived VSIX release identity is not valid",
    );
  }
}
