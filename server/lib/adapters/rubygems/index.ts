import {
  computeRisk,
  createPackageDiff,
  deterministicFindings,
  redactFindings,
  summarizePackageJsonDiff,
} from "../../review";
import type { PackageAdapter, ReleaseProvenance } from "../types";
import {
  acquireBaselineRubygems,
  acquireStagedRubygems,
  baselineFromPreviousArtifacts,
  pickPackageIdentity,
} from "./acquire";
import { createRubygemsBroker, type RubygemsBroker } from "./broker";
import { rubygemsReleaseFindings } from "./findings";
import { parseRubygemsAdapterInput } from "./manifest";
import type {
  RubygemsAdapterDetails,
  RubygemsAdapterInput,
  RubygemsArtifactInput,
  RubygemsReleaseCandidateReview,
  RubygemsReleaseManifest,
} from "./types";

export const rubygemsAdapter: PackageAdapter<RubygemsAdapterInput, RubygemsBroker> = {
  id: "rubygems",
  codePatternSet: "ruby",

  parseInput(raw: unknown): RubygemsAdapterInput {
    return parseRubygemsAdapterInput(raw);
  },

  createBroker(ctx, ref) {
    return createRubygemsBroker(ctx, ref);
  },

  async acquireStaged(_ctx, input, _broker) {
    return acquireStagedRubygems(input);
  },

  async acquireBaseline(ctx, input, broker, staged) {
    return acquireBaselineRubygems(ctx, input, broker, staged);
  },

  runFindings(args) {
    const details = args.details as RubygemsAdapterDetails;
    return [
      ...deterministicFindings(args.staged.files, args.fileDiff, null, {
        codePatternSet: "ruby",
      }),
      ...rubygemsReleaseFindings(
        details.manifest,
        details.preparedArtifacts,
        args.baseline?.files ?? null,
      ),
    ];
  },

  describe({ details, previous }) {
    const d = details as RubygemsAdapterDetails;
    const identity = pickPackageIdentity(d.manifest, d.preparedArtifacts);
    return {
      name: identity.name,
      stagedVersion: identity.version,
      stagedTag: null,
      previousVersion: previous?.manifest?.version ?? null,
    };
  },

  summarizeDetails(details) {
    const d = details as RubygemsAdapterDetails;
    return {
      manifest: d.manifest,
      artifacts: d.artifacts,
      provenance: {
        // RubyGems artifacts only reach review through the workflow gate; the
        // manifest carries each .gem digest recomputed from the immutable
        // bundle bytes, which the publish job re-verifies before upload.
        ecosystem: "rubygems",
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

export function createRubygemsReleaseCandidateReview(input: {
  manifest: RubygemsReleaseManifest;
  artifacts: RubygemsArtifactInput[];
  previousArtifacts?: RubygemsArtifactInput[];
}): RubygemsReleaseCandidateReview {
  const adapterInput = rubygemsAdapter.parseInput(input);
  const staged = acquireStagedRubygems(adapterInput);
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
  const details = staged.details as RubygemsAdapterDetails;

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

export { RUBYGEMS_RELEASE_MANIFEST_SCHEMA, RUBYGEMS_RULES_VERSION } from "./types";
export type {
  RubygemsAdapterInput,
  RubygemsArtifactInput,
  RubygemsPreparedArtifact,
  RubygemsReleaseCandidateReview,
  RubygemsReleaseManifest,
} from "./types";
export {
  inferRubygemsArtifactKind,
  normalizeRubygemsGemName,
  parseRubygemsReleaseManifest,
} from "./manifest";
export {
  isAllowedRubygemsArtifactUrl,
  pickRubygemsBaselineRelease,
  prepareRubygemsArtifact,
  selectRubygemsReleaseArtifacts,
} from "./acquire";
export { parseGemspecYaml, summarizeRubygemsArtifact, GEM_METADATA_PATH } from "./findings";
