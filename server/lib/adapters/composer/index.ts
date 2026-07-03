import {
  computeRisk,
  createPackageDiff,
  deterministicFindings,
  redactFindings,
  summarizePackageJsonDiff,
} from "../../review";
import type { PackageAdapter, ReleaseProvenance } from "../types";
import {
  acquireBaselineComposer,
  acquireStagedComposer,
  baselineFromPreviousArtifacts,
  pickPackageIdentity,
} from "./acquire";
import { createComposerBroker, type ComposerBroker } from "./broker";
import { composerReleaseFindings, summarizeBaselineComposerJson } from "./findings";
import { parseComposerAdapterInput } from "./manifest";
import type {
  ComposerAdapterDetails,
  ComposerAdapterInput,
  ComposerArtifactInput,
  ComposerReleaseCandidateReview,
  ComposerReleaseManifest,
} from "./types";

export const composerAdapter: PackageAdapter<ComposerAdapterInput, ComposerBroker> = {
  id: "composer",
  codePatternSet: "php",

  parseInput(raw: unknown): ComposerAdapterInput {
    return parseComposerAdapterInput(raw);
  },

  createBroker(ctx, ref) {
    return createComposerBroker(ctx, ref);
  },

  async acquireStaged(_ctx, input, _broker) {
    return acquireStagedComposer(input);
  },

  async acquireBaseline(ctx, input, broker, _staged) {
    return acquireBaselineComposer(ctx, input, broker);
  },

  runFindings(args) {
    const details = args.details as ComposerAdapterDetails;
    const baselineComposerJson = summarizeBaselineComposerJson(args.baseline?.files);
    return [
      ...deterministicFindings(args.staged.files, args.fileDiff, null, {
        codePatternSet: "php",
      }),
      ...composerReleaseFindings(details.manifest, details.preparedArtifacts, baselineComposerJson),
    ];
  },

  describe({ details, previous }) {
    const d = details as ComposerAdapterDetails;
    const identity = pickPackageIdentity(d.manifest, d.preparedArtifacts);
    return {
      name: identity.name,
      stagedVersion: identity.version,
      stagedTag: null,
      previousVersion: previous?.manifest?.version ?? null,
    };
  },

  summarizeDetails(details) {
    const d = details as ComposerAdapterDetails;
    return {
      manifest: d.manifest,
      artifacts: d.artifacts,
      provenance: {
        // Composer artifacts only reach review through the workflow gate; the
        // manifest carries the archive digest recomputed from the immutable
        // bundle bytes, which the publish job re-verifies before upload.
        ecosystem: "composer",
        mode: "workflow_gate",
        artifacts: d.manifest.artifacts.map((artifact) => ({
          path: artifact.path,
          kind: "tarball" as const,
          sha256: artifact.sha256,
        })),
      } satisfies ReleaseProvenance,
    };
  },
};

export function createComposerReleaseCandidateReview(input: {
  manifest: ComposerReleaseManifest;
  artifacts: ComposerArtifactInput[];
  previousArtifacts?: ComposerArtifactInput[];
}): ComposerReleaseCandidateReview {
  const adapterInput = composerAdapter.parseInput(input);
  const staged = acquireStagedComposer(adapterInput);
  const baseline = baselineFromPreviousArtifacts(adapterInput);
  const diff = createPackageDiff(baseline.artifact?.files ?? [], staged.artifact.files);
  const ruleFindings = redactFindings(
    composerAdapter.runFindings({
      staged: staged.artifact,
      baseline: baseline.artifact,
      details: staged.details,
      fileDiff: diff,
      manifestDiff: summarizePackageJsonDiff(baseline.artifact?.manifest, staged.artifact.manifest),
      stagedManifestText: null,
    }),
  );
  const packageIdentity = composerAdapter.describe({
    input: adapterInput,
    staged: staged.artifact,
    details: staged.details,
    baseline: baseline.baseline,
    previous: baseline.artifact,
  });
  const details = staged.details as ComposerAdapterDetails;

  return {
    ecosystem: "composer",
    manifest: adapterInput.manifest,
    package: {
      name: packageIdentity.name,
      version: packageIdentity.stagedVersion,
    },
    artifactCount: details.preparedArtifacts.length,
    fileCount: staged.artifact.files.length,
    previousFileCount: baseline.artifact?.files.length ?? 0,
    artifacts: details.artifacts,
    diff,
    ruleFindings,
    risk: computeRisk(ruleFindings),
  };
}

export {
  COMPOSER_RELEASE_MANIFEST_SCHEMA,
  COMPOSER_RULES_VERSION,
  COMPOSER_UNVERSIONED,
} from "./types";
export type {
  ComposerAdapterInput,
  ComposerArtifactInput,
  ComposerPreparedArtifact,
  ComposerReleaseCandidateReview,
  ComposerReleaseManifest,
} from "./types";
export {
  inferComposerArtifactKind,
  isValidComposerPackageName,
  normalizeComposerPackageName,
  parseComposerReleaseManifest,
} from "./manifest";
export {
  pickComposerBaselineRelease,
  prepareComposerArtifact,
  selectComposerReleaseArtifact,
} from "./acquire";
export { isAllowedComposerArtifactUrl } from "./broker";
export { findComposerJsonFile, summarizeComposerArtifact } from "./findings";
