import {
  buildVscodeReleaseManifest,
  extensionIdFromManifest,
  inferVscodeArtifactKind,
  normalizeVsixFiles,
  parseVscodeExtensionManifest,
  vscodeAdapter,
} from "../adapters/vscode";
import type { AdapterBroker, PackageAdapter } from "../adapters/types";
import { WorkflowArtifactError } from "../github-app/artifacts";
import type {
  ArchiveContents,
  ParsedGateArtifact,
  PreparedReleaseCandidate,
  WorkflowArtifactKind,
  WorkflowGateAdapter,
} from "./types";

export const vscodeWorkflowGateAdapter: WorkflowGateAdapter = {
  ecosystem: "vscode",
  artifactName: "vscode-release-candidate",
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
};

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
