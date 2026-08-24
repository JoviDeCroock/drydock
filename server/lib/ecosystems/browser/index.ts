import {
  computeRisk,
  createPackageDiff,
  redactFindings,
  summarizePackageJsonDiff,
} from "../../review";
import type {
  AcquiredArtifact,
  AdapterBroker,
  BaselineInfo,
  PackageAdapter,
  ReleaseProvenance,
} from "../package-adapter";
import { buildBrowserFindings } from "./findings";
import {
  packageJsonSummaryForBrowser,
  parseBrowserAdapterInput,
  parseBrowserExtensionManifest,
} from "./manifest";
import type {
  BrowserAdapterDetails,
  BrowserAdapterInput,
  BrowserArtifactInput,
  BrowserReleaseCandidateReview,
} from "./types";

export const browserAdapter: PackageAdapter<BrowserAdapterInput, AdapterBroker> = {
  id: "browser",
  codePatternSet: "javascript",

  parseInput(raw) {
    return parseBrowserAdapterInput(raw);
  },

  createBroker() {
    return { dispose(): void {} };
  },

  acquireStaged(_ctx, input) {
    return Promise.resolve(acquireBrowserArtifact(input.manifest, input.artifact));
  },

  acquireBaseline(_ctx, input) {
    if (!input.previousArtifact) {
      return Promise.resolve({ artifact: null, baseline: emptyBaseline() });
    }
    const acquired = acquireBrowserArtifact(input.manifest, input.previousArtifact);
    return Promise.resolve({
      artifact: acquired.artifact,
      baseline: {
        version: acquired.artifact.manifest?.version ?? null,
        tag: null,
        source: "latest-published",
        distTagVersion: null,
        reason: "provided-previous-artifact",
      } satisfies BaselineInfo,
    });
  },

  runFindings(args) {
    return buildBrowserFindings({
      staged: args.staged,
      details: args.details as BrowserAdapterDetails,
      fileDiff: args.fileDiff,
      manifestDiff: args.manifestDiff,
      stagedManifestText: args.stagedManifestText,
    });
  },

  describe({ staged, details, previous }) {
    const d = details as BrowserAdapterDetails;
    return {
      name: staged.manifest?.name ?? d.manifest.package,
      stagedVersion: staged.manifest?.version ?? d.manifest.version,
      stagedTag: null,
      previousVersion: previous?.manifest?.version ?? null,
    };
  },

  historyPackageName({ details }) {
    // A Chrome archive commonly has only a localized/reused display name.
    // Cross-release history is safe only when the manifest embeds a stable ID.
    return (details as BrowserAdapterDetails).artifact.extensionId;
  },

  summarizeDetails(details) {
    const d = details as BrowserAdapterDetails;
    return {
      manifest: d.manifest,
      artifact: d.artifact,
      // A null identity keeps display-name-only Chrome archives out of public
      // package-name indexes while still allowing the gate review itself.
      publicPackageIdentity: d.artifact.extensionId,
      provenance: {
        ecosystem: "browser",
        mode: "workflow_gate",
        artifacts: d.manifest.artifacts.map((artifact) => ({
          path: artifact.path,
          kind: artifact.kind,
          sha256: artifact.sha256,
        })),
      } satisfies ReleaseProvenance,
    };
  },
};

function acquireBrowserArtifact(
  releaseManifest: BrowserAdapterInput["manifest"],
  artifactInput: BrowserArtifactInput,
): { artifact: AcquiredArtifact; details: BrowserAdapterDetails } {
  const { manifest } = parseBrowserExtensionManifest(artifactInput.files);
  const kind = releaseManifest.artifacts[0].kind;
  return {
    artifact: {
      files: artifactInput.files,
      manifest: packageJsonSummaryForBrowser(manifest),
      ...(artifactInput.suspiciousEntries
        ? { suspiciousTarEntries: artifactInput.suspiciousEntries }
        : {}),
    },
    details: {
      manifest: releaseManifest,
      artifact: {
        path: artifactInput.path,
        sha256: artifactInput.sha256,
        kind,
        extensionId: manifest.extensionId,
        displayName: manifest.name,
        manifestPath: "manifest.json",
        manifestVersion: manifest.manifestVersion,
        permissions: manifest.permissions,
        optionalPermissions: manifest.optionalPermissions,
        hostPermissions: manifest.hostPermissions,
        optionalHostPermissions: manifest.optionalHostPermissions,
        contentScriptMatches: manifest.contentScriptMatches,
        contentScriptEntrypoints: manifest.contentScriptEntrypoints,
        userScriptEntrypoints: manifest.userScriptEntrypoints,
        externallyConnectableMatches: manifest.externallyConnectableMatches,
        backgroundEntrypoints: manifest.backgroundEntrypoints,
        extensionPageEntrypoints: manifest.extensionPageEntrypoints,
        contentSecurityPolicy: manifest.contentSecurityPolicy,
      },
    },
  };
}

function emptyBaseline(): BaselineInfo {
  return {
    version: null,
    tag: null,
    source: "none",
    distTagVersion: null,
    reason: "no-store-identity-for-public-baseline",
    comparisonSkipped: "baseline-unavailable",
  };
}

export function createBrowserExtensionReview(input: {
  manifest: BrowserAdapterInput["manifest"];
  artifact: BrowserArtifactInput;
  previousArtifact?: BrowserArtifactInput;
}): BrowserReleaseCandidateReview {
  const adapterInput = browserAdapter.parseInput(input);
  const staged = acquireBrowserArtifact(adapterInput.manifest, adapterInput.artifact);
  const baseline = adapterInput.previousArtifact
    ? acquireBrowserArtifact(adapterInput.manifest, adapterInput.previousArtifact)
    : null;
  const diff = createPackageDiff(baseline?.artifact.files ?? [], staged.artifact.files);
  const ruleFindings = redactFindings(
    browserAdapter.runFindings({
      staged: staged.artifact,
      baseline: baseline?.artifact ?? null,
      details: staged.details,
      fileDiff: diff,
      manifestDiff: summarizePackageJsonDiff(baseline?.artifact.manifest, staged.artifact.manifest),
      stagedManifestText:
        staged.artifact.files.find((file) => file.path === "manifest.json")?.textSample ?? null,
    }),
  );
  return {
    ecosystem: "browser",
    manifest: adapterInput.manifest,
    package: {
      name: staged.artifact.manifest?.name ?? null,
      version: staged.artifact.manifest?.version ?? null,
    },
    fileCount: staged.artifact.files.length,
    previousFileCount: baseline?.artifact.files.length ?? 0,
    diff,
    ruleFindings,
    risk: computeRisk(ruleFindings),
  };
}

export {
  browserExtensionCandidateName,
  buildBrowserReleaseManifest,
  inferBrowserArtifactKind,
  parseBrowserExtensionManifest,
} from "./manifest";
export { BROWSER_RULE_IDS, BROWSER_RULES_VERSION } from "./types";
export type {
  BrowserAdapterInput,
  BrowserArtifactInput,
  BrowserReleaseCandidateReview,
} from "./types";
