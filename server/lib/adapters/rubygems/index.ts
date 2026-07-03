import {
  computeRisk,
  createPackageDiff,
  deterministicFindings,
  redactFindings,
  summarizePackageJsonDiff,
  tarSuspiciousEntryFindings,
} from "../../review";
import type { PackageAdapter, ReleaseProvenance } from "../types";
import {
  acquireBaselineRubyGems,
  acquireStagedRubyGems,
  baselineFromPreviousArtifacts,
  pickPackageIdentity,
} from "./acquire";
import { createRubyGemsBroker, type RubyGemsBroker } from "./broker";
import { rubyGemsReleaseFindings } from "./findings";
import { parseRubyGemsAdapterInput } from "./manifest";
import type {
  RubyGemsAdapterDetails,
  RubyGemsAdapterInput,
  RubyGemsArtifactInput,
  RubyGemsReleaseCandidateReview,
  RubyGemsReleaseManifest,
} from "./types";

export const rubygemsAdapter: PackageAdapter<RubyGemsAdapterInput, RubyGemsBroker> = {
  id: "rubygems",
  codePatternSet: "ruby",

  parseInput(raw: unknown): RubyGemsAdapterInput {
    return parseRubyGemsAdapterInput(raw);
  },

  createBroker(ctx, ref) {
    return createRubyGemsBroker(ctx, ref);
  },

  async acquireStaged(_ctx, input, _broker) {
    return acquireStagedRubyGems(input);
  },

  async acquireBaseline(ctx, input, broker, staged) {
    return acquireBaselineRubyGems(ctx, input, broker, staged);
  },

  runFindings(args) {
    const details = args.details as RubyGemsAdapterDetails;
    return [
      ...deterministicFindings(args.staged.files, args.fileDiff, null, {
        codePatternSet: "ruby",
      }),
      ...rubyGemsReleaseFindings(details.manifest, details.preparedArtifacts),
      ...tarSuspiciousEntryFindings(args.staged.suspiciousTarEntries),
    ];
  },

  describe({ details, previous }) {
    const d = details as RubyGemsAdapterDetails;
    const identity = pickPackageIdentity(d.manifest, d.preparedArtifacts);
    return {
      name: identity.name,
      stagedVersion: identity.version,
      stagedTag: null,
      previousVersion: previous?.manifest?.version ?? null,
    };
  },

  summarizeDetails(details) {
    const d = details as RubyGemsAdapterDetails;
    return {
      ecosystem: "rubygems",
      manifest: d.manifest,
      artifacts: d.artifacts,
      provenance: {
        // Gems only reach review through the workflow gate; the manifest carries
        // each `.gem` digest recomputed from the immutable bundle bytes, which
        // the publish job re-verifies before `gem push`.
        ecosystem: "rubygems",
        mode: "workflow_gate",
        artifacts: d.manifest.artifacts.map((artifact) => ({
          path: artifact.path,
          kind: "gem" as const,
          sha256: artifact.sha256,
        })),
      } satisfies ReleaseProvenance,
    };
  },
};

export function createRubyGemsReleaseCandidateReview(input: {
  manifest: RubyGemsReleaseManifest;
  artifacts: RubyGemsArtifactInput[];
  previousArtifacts?: RubyGemsArtifactInput[];
}): RubyGemsReleaseCandidateReview {
  const adapterInput = rubygemsAdapter.parseInput(input);
  const staged = acquireStagedRubyGems(adapterInput);
  const baseline = baselineFromPreviousArtifacts(adapterInput);
  const diff = createPackageDiff(baseline.artifact?.files ?? [], staged.artifact.files);
  const ruleFindings = redactFindings(
    rubygemsAdapter.runFindings({
      staged: staged.artifact,
      baseline: baseline.artifact,
      details: staged.details,
      fileDiff: diff,
      manifestDiff: summarizePackageJsonDiff(baseline.artifact?.manifest, staged.artifact.manifest),
      stagedManifestText: null,
    }),
  );
  const packageIdentity = rubygemsAdapter.describe({
    input: adapterInput,
    staged: staged.artifact,
    details: staged.details,
    baseline: baseline.baseline,
    previous: baseline.artifact,
  });
  const details = staged.details as RubyGemsAdapterDetails;

  return {
    ecosystem: "rubygems",
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
  RUBYGEMS_RELEASE_MANIFEST_SCHEMA,
  RUBYGEMS_RULE_IDS,
  RUBYGEMS_RULES_VERSION,
} from "./types";
export type {
  GemArtifactSummary,
  RubyGemsAdapterDetails,
  RubyGemsAdapterInput,
  RubyGemsArtifactInput,
  RubyGemsBaselineSelection,
  RubyGemsBaselineSelectionSource,
  RubyGemsPreparedArtifact,
  RubyGemsReleaseCandidateReview,
  RubyGemsReleaseManifest,
  RubyGemsReleaseManifestArtifact,
  RubyGemsRemoteArtifact,
  RubyGemsVersion,
} from "./types";
export type { GemspecDependency, GemspecSummary } from "./gemspec";
export { parseGemspecMetadata } from "./gemspec";
export {
  isValidGemName,
  isValidGemVersion,
  normalizeGemName,
  parseRubyGemsAdapterInput,
  parseRubyGemsReleaseManifest,
} from "./manifest";
export {
  acquireBaselineRubyGems,
  acquireStagedRubyGems,
  baselineFromPreviousArtifacts,
  pickPackageIdentity,
  pickRubyGemsBaselineVersion,
  prepareRubyGemsArtifact,
} from "./acquire";
export { isAllowedRubyGemsArtifactUrl } from "./broker";
