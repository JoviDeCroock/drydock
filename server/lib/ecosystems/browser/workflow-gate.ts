import {
  browserAdapter,
  browserExtensionIdentity,
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
    try {
      parseBrowserExtensionManifest(contents.files);
      return "zip";
    } catch {
      return null;
    }
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
      const identity = browserExtensionIdentity(parsed);
      const identityKey = identity.toLowerCase();
      const group = groups.get(identityKey);
      if (group) {
        if (group.version !== parsed.version) {
          throw new WorkflowArtifactError(
            "artifact_identity_inconsistent",
            `${artifact.path} version ${parsed.version} disagrees with ${group.version} for ${identity}`,
          );
        }
        throw new WorkflowArtifactError(
          "artifact_identity_inconsistent",
          `browser extension ${identity} has more than one archive in this release`,
        );
      }
      groups.set(identityKey, { identity, version: parsed.version, artifact });
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
