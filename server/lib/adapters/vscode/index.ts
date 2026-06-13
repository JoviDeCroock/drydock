import {
  computeRisk,
  createPackageDiff,
  redactFindings,
  summarizePackageJsonDiff,
} from "../../review";
import type { AcquiredArtifact, BaselineInfo, PackageAdapter } from "../types";
import { buildVscodeFindings } from "./findings";
import {
  extensionIdFromManifest,
  normalizeVsixFiles,
  packageJsonSummaryForVscode,
  parseVscodeAdapterInput,
  parseVscodeExtensionManifest,
} from "./manifest";
import type {
  VscodeAdapterDetails,
  VscodeAdapterInput,
  VscodeArtifactInput,
  VscodeReleaseCandidateReview,
} from "./types";

interface VscodeBroker {
  dispose(): void;
}

const vscodeBroker: VscodeBroker = {
  dispose() {},
};

export const vscodeAdapter: PackageAdapter<VscodeAdapterInput, VscodeBroker> = {
  id: "vscode",
  codePatternSet: "javascript",

  parseInput(raw: unknown): VscodeAdapterInput {
    return parseVscodeAdapterInput(raw);
  },

  createBroker() {
    return vscodeBroker;
  },

  acquireStaged(_ctx, input) {
    return Promise.resolve(acquireVscodeArtifact(input.manifest, input.artifact));
  },

  acquireBaseline(_ctx, input) {
    if (!input.previousArtifact) {
      return Promise.resolve({
        artifact: null,
        baseline: emptyBaseline("baseline-unavailable"),
      });
    }
    const acquired = acquireVscodeArtifact(input.manifest, input.previousArtifact);
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
    return buildVscodeFindings({
      staged: args.staged,
      details: args.details as VscodeAdapterDetails,
      fileDiff: args.fileDiff,
      manifestDiff: args.manifestDiff,
      stagedManifestText: args.stagedManifestText,
    });
  },

  describe({ staged, details, previous }) {
    const d = details as VscodeAdapterDetails;
    return {
      name: staged.manifest?.name ?? d.manifest.package,
      stagedVersion: staged.manifest?.version ?? d.manifest.version,
      stagedTag: null,
      previousVersion: previous?.manifest?.version ?? null,
    };
  },

  summarizeDetails(details) {
    const d = details as VscodeAdapterDetails;
    return {
      manifest: d.manifest,
      artifact: d.artifact,
    };
  },
};

function acquireVscodeArtifact(
  releaseManifest: VscodeAdapterInput["manifest"],
  artifactInput: VscodeArtifactInput,
): { artifact: AcquiredArtifact; details: VscodeAdapterDetails } {
  const files = normalizeVsixFiles(artifactInput.files);
  const { file, manifest } = parseVscodeExtensionManifest(files);
  const extensionId = extensionIdFromManifest(manifest);
  return {
    artifact: {
      files,
      manifest: packageJsonSummaryForVscode(manifest),
    },
    details: {
      manifest: releaseManifest,
      artifact: {
        path: artifactInput.path,
        sha256: artifactInput.sha256,
        extensionId,
        packageJsonPath: file.path,
        activationEvents: manifest.activationEvents,
        main: manifest.main,
        browser: manifest.browser,
        extensionDependencies: manifest.extensionDependencies,
        extensionPack: manifest.extensionPack,
        configurationProperties: manifest.configurationProperties,
        enginesVscode: manifest.enginesVscode,
      },
    },
  };
}

function emptyBaseline(reason: string): BaselineInfo {
  return {
    version: null,
    tag: null,
    source: "none",
    distTagVersion: null,
    reason,
  };
}

export function createVscodeExtensionReview(input: {
  manifest: VscodeAdapterInput["manifest"];
  artifact: VscodeArtifactInput;
  previousArtifact?: VscodeArtifactInput;
}): VscodeReleaseCandidateReview {
  const adapterInput = vscodeAdapter.parseInput(input);
  const staged = acquireVscodeArtifact(adapterInput.manifest, adapterInput.artifact);
  const baseline = adapterInput.previousArtifact
    ? acquireVscodeArtifact(adapterInput.manifest, adapterInput.previousArtifact)
    : null;
  const diff = createPackageDiff(baseline?.artifact.files ?? [], staged.artifact.files);
  const ruleFindings = redactFindings(
    vscodeAdapter.runFindings({
      staged: staged.artifact,
      baseline: baseline?.artifact ?? null,
      details: staged.details,
      fileDiff: diff,
      manifestDiff: summarizePackageJsonDiff(baseline?.artifact.manifest, staged.artifact.manifest),
      stagedManifestText:
        staged.artifact.files.find((file) => file.path === "package.json")?.textSample ?? null,
    }),
  );
  return {
    ecosystem: "vscode",
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

export { VSCODE_RELEASE_MANIFEST_SCHEMA, VSCODE_RULE_IDS, VSCODE_RULES_VERSION } from "./types";
export type {
  VscodeAdapterDetails,
  VscodeAdapterInput,
  VscodeArtifactInput,
  VscodeExtensionManifest,
  VscodeReleaseCandidateReview,
  VscodeReleaseManifest,
} from "./types";
export {
  buildVscodeReleaseManifest,
  extensionIdFromManifest,
  inferVscodeArtifactKind,
  normalizeVsixFiles,
  packageJsonSummaryForVscode,
  parseVscodeAdapterInput,
  parseVscodeExtensionManifest,
  parseVscodeReleaseManifest,
} from "./manifest";
