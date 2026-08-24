import {
  browserAdapter,
  browserExtensionCandidateName,
  buildBrowserReleaseManifest,
  inferBrowserArtifactKind,
  parseBrowserExtensionManifest,
} from "./";
import type { AdapterBroker, PackageAdapter } from "../package-adapter";
import { WorkflowArtifactError } from "../../github-app/artifacts";
import type {
  ArchiveContents,
  ParsedGateArtifact,
  PreparedReleaseCandidate,
  WorkflowArtifactKind,
  WorkflowGateAdapter,
} from "../../workflow-gates/types";

export const browserWorkflowGateAdapter: WorkflowGateAdapter = {
  ecosystem: "browser",
  artifactName: "browser-extension-release-candidate",
  packageAdapter: browserAdapter as PackageAdapter<unknown, AdapterBroker>,

  classifyArtifact(path: string): WorkflowArtifactKind | null {
    return inferBrowserArtifactKind(path);
  },

  classifyArtifactForAutoDetection(path: string): WorkflowArtifactKind | null {
    // XPI is browser-specific, but ZIP is a generic CI artifact extension. A
    // pinned browser target may claim ZIPs; auto-detect must ignore them so an
    // unrelated source/archive upload cannot block another ecosystem's gate.
    return inferBrowserArtifactKind(path) === "xpi" ? "xpi" : null;
  },

  sandboxFormat() {
    // Extension builders commonly stream ZIP entries with data descriptors;
    // the bounded central-directory-first reader follows store consumers.
    return "zip-buffered";
  },

  detectArtifact(contents: ArchiveContents): WorkflowArtifactKind | null {
    void contents;
    // Browser ZIP/XPI artifacts have unambiguous file extensions. Content
    // detection only runs for extension-ambiguous tar archives, where a root
    // manifest.json may legitimately belong to an npm package instead.
    return null;
  },

  prepareReleaseCandidates(artifacts: ParsedGateArtifact[]): PreparedReleaseCandidate[] {
    const groups = new Map<
      string,
      { identity: string; version: string; artifact: ParsedGateArtifact }
    >();
    for (const artifact of artifacts) {
      let parsed;
      try {
        parsed = parseBrowserExtensionManifest(artifact.files).manifest;
      } catch (err) {
        throw new WorkflowArtifactError(
          "artifact_identity_missing",
          err instanceof Error
            ? `${artifact.path}: ${err.message}`
            : `${artifact.path}: manifest.json is invalid`,
        );
      }
      const candidateName = browserExtensionCandidateName(parsed);
      // Gecko IDs are stable store identities. Chrome archives commonly omit
      // one, so keep name-only artifacts separate by their verified digest
      // instead of merging unrelated same-name extensions. Preserve Gecko ID
      // casing because a casing change denotes a different extension identity.
      const identityKey = parsed.extensionId
        ? `extension:${parsed.extensionId}`
        : `artifact:${artifact.sha256}`;
      const group = groups.get(identityKey);
      if (group) {
        if (group.version !== parsed.version) {
          throw new WorkflowArtifactError(
            "artifact_identity_inconsistent",
            `${artifact.path} version ${parsed.version} disagrees with ${group.version} for ${candidateName}`,
          );
        }
        throw new WorkflowArtifactError(
          "artifact_identity_inconsistent",
          `browser extension ${candidateName} has more than one archive in this release`,
        );
      }
      groups.set(identityKey, { identity: candidateName, version: parsed.version, artifact });
    }

    return [...groups.values()].map(({ identity, version, artifact }) => {
      let manifest;
      try {
        manifest = buildBrowserReleaseManifest(identity, version, [
          { path: artifact.path, sha256: artifact.sha256 },
        ]);
      } catch (err) {
        throw new WorkflowArtifactError(
          "artifact_identity_missing",
          err instanceof Error ? err.message : "derived browser extension identity is invalid",
        );
      }
      return {
        ecosystem: "browser",
        // The digest separates name-only Chrome artifacts that legitimately
        // share a display name without trusting that display name as identity.
        scanKey: artifact.sha256,
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
      };
    });
  },
};
