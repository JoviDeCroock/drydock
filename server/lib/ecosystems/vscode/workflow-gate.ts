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
import { buildManifestOrFail, groupReleaseCandidates } from "../../workflow-gates/group-candidates";
import type {
  ParsedGateArtifact,
  PreparedReleaseCandidate,
  WorkflowArtifactKind,
  WorkflowGateAdapter,
} from "../../workflow-gates/types";

// No `detectArtifact`: VSIX has an unambiguous `.vsix` extension, and content
// detection only runs for extension-ambiguous tar archives. Claiming there
// would let npm/PyPI tarballs that happen to contain `extension/package.json`
// masquerade as VSIX.
export const vscodeWorkflowGateAdapter: WorkflowGateAdapter = {
  ecosystem: "vscode",
  artifactName: "vscode-release-candidate",
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
};

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
