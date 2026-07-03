import {
  computeRisk,
  createPackageDiff,
  deterministicFindings,
  redactFindings,
  summarizePackageJsonDiff,
} from "../../review";
import type { PackageAdapter, ReleaseProvenance } from "../types";
import {
  acquireBaselineCrates,
  acquireStagedCrates,
  baselineFromPreviousCratesArtifacts,
  pickCratesPackageIdentity,
} from "./acquire";
import { createCratesBroker, type CratesBroker } from "./broker";
import { cratesReleaseFindings } from "./findings";
import { parseCratesAdapterInput } from "./manifest";
import type {
  CratesAdapterDetails,
  CratesAdapterInput,
  CratesArtifactInput,
  CratesReleaseCandidateReview,
  CratesReleaseManifest,
} from "./types";

export const cratesAdapter: PackageAdapter<CratesAdapterInput, CratesBroker> = {
  id: "crates",
  codePatternSet: "rust",

  parseInput(raw: unknown): CratesAdapterInput {
    return parseCratesAdapterInput(raw);
  },

  createBroker(ctx, ref) {
    return createCratesBroker(ctx, ref);
  },

  async acquireStaged(_ctx, input, _broker) {
    return acquireStagedCrates(input);
  },

  async acquireBaseline(ctx, input, broker, _staged) {
    return acquireBaselineCrates(ctx, input, broker);
  },

  runFindings(args) {
    const details = args.details as CratesAdapterDetails;
    return [
      ...deterministicFindings(args.staged.files, args.fileDiff, null, {
        codePatternSet: "rust",
      }),
      ...cratesReleaseFindings(
        details.manifest,
        details.preparedArtifacts,
        args.baseline?.files ?? null,
      ),
    ];
  },

  describe({ details, previous }) {
    const d = details as CratesAdapterDetails;
    const identity = pickCratesPackageIdentity(d.manifest, d.preparedArtifacts);
    return {
      name: identity.name,
      stagedVersion: identity.version,
      stagedTag: null,
      previousVersion: previous?.manifest?.version ?? null,
    };
  },

  summarizeDetails(details) {
    const d = details as CratesAdapterDetails;
    return {
      manifest: d.manifest,
      artifacts: d.artifacts,
      provenance: {
        // crates artifacts only reach review through the workflow gate; the
        // manifest carries each `.crate` digest recomputed from the immutable
        // bundle bytes, which the publish job re-verifies before upload.
        ecosystem: "crates",
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

export function createCratesReleaseCandidateReview(input: {
  manifest: CratesReleaseManifest;
  artifacts: CratesArtifactInput[];
  previousArtifacts?: CratesArtifactInput[];
}): CratesReleaseCandidateReview {
  const adapterInput = cratesAdapter.parseInput(input);
  const staged = acquireStagedCrates(adapterInput);
  const baseline = baselineFromPreviousCratesArtifacts(adapterInput);
  const diff = createPackageDiff(baseline.artifact?.files ?? [], staged.artifact.files);
  const ruleFindings = redactFindings(
    cratesAdapter.runFindings({
      staged: staged.artifact,
      baseline: baseline.artifact,
      details: staged.details,
      fileDiff: diff,
      manifestDiff: summarizePackageJsonDiff(baseline.artifact?.manifest, staged.artifact.manifest),
      stagedManifestText: null,
    }),
  );
  const packageIdentity = cratesAdapter.describe({
    input: adapterInput,
    staged: staged.artifact,
    details: staged.details,
    baseline: baseline.baseline,
    previous: baseline.artifact,
  });
  const details = staged.details as CratesAdapterDetails;

  return {
    ecosystem: "crates",
    manifest: adapterInput.manifest,
    package: {
      name: packageIdentity.name,
      version: packageIdentity.stagedVersion,
    },
    fileCount: staged.artifact.files.length,
    previousFileCount: baseline.artifact?.files.length ?? 0,
    artifacts: details.artifacts,
    diff,
    ruleFindings,
    risk: computeRisk(ruleFindings),
  };
}

export { CRATES_RELEASE_MANIFEST_SCHEMA, CRATES_RULE_IDS, CRATES_RULES_VERSION } from "./types";
export type {
  CratesAdapterInput,
  CratesArtifactInput,
  CratesPreparedArtifact,
  CratesReleaseCandidateReview,
  CratesReleaseManifest,
} from "./types";
export {
  inferCratesArtifactKind,
  isValidCrateName,
  parseCargoManifest,
  parseCratesReleaseManifest,
} from "./manifest";
export { pickCratesBaselineVersion, prepareCratesArtifact } from "./acquire";
export { cratesIndexPath, cratesStaticArtifactUrl, isAllowedCratesArtifactUrl } from "./broker";
