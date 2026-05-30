import {
  computeRisk,
  createPackageDiff,
  deterministicFindings,
  redactFindings,
  summarizePackageJsonDiff,
} from "../../review";
import type { PackageAdapter } from "../types";
import {
  acquireBaselinePyPi,
  acquireStagedPyPi,
  baselineFromPreviousArtifacts,
  pickPackageIdentity,
} from "./acquire";
import { createPyPiBroker, type PyPiBroker } from "./broker";
import { pyPiReleaseFindings } from "./findings";
import { parsePyPiAdapterInput } from "./manifest";
import type {
  PyPiAdapterDetails,
  PyPiAdapterInput,
  PyPiArtifactInput,
  PyPiReleaseCandidateReview,
  PyPiReleaseManifest,
} from "./types";

export const pypiAdapter: PackageAdapter<PyPiAdapterInput, PyPiBroker> = {
  id: "pypi",
  codePatternSet: "python",

  parseInput(raw: unknown): PyPiAdapterInput {
    return parsePyPiAdapterInput(raw);
  },

  createBroker(ctx, ref) {
    return createPyPiBroker(ctx, ref);
  },

  async acquireStaged(_ctx, input, _broker) {
    return acquireStagedPyPi(input);
  },

  async acquireBaseline(ctx, input, broker, staged) {
    return acquireBaselinePyPi(ctx, input, broker, staged);
  },

  runFindings(args) {
    const details = args.details as PyPiAdapterDetails;
    return [
      ...deterministicFindings(args.staged.files, args.fileDiff, null, {
        codePatternSet: "python",
      }),
      ...pyPiReleaseFindings(details.manifest, details.preparedArtifacts),
    ];
  },

  describe({ details, previous }) {
    const d = details as PyPiAdapterDetails;
    const identity = pickPackageIdentity(d.manifest, d.preparedArtifacts);
    return {
      name: identity.name,
      stagedVersion: identity.version,
      stagedTag: null,
      previousVersion: previous?.manifest?.version ?? null,
    };
  },

  summarizeDetails(details) {
    const d = details as PyPiAdapterDetails;
    return {
      manifest: d.manifest,
      artifacts: d.artifacts,
    };
  },
};

export function createPyPiReleaseCandidateReview(input: {
  manifest: PyPiReleaseManifest;
  artifacts: PyPiArtifactInput[];
  previousArtifacts?: PyPiArtifactInput[];
}): PyPiReleaseCandidateReview {
  const adapterInput = pypiAdapter.parseInput(input);
  const staged = acquireStagedPyPi(adapterInput);
  const baseline = baselineFromPreviousArtifacts(adapterInput);
  const diff = createPackageDiff(baseline.artifact?.files ?? [], staged.artifact.files);
  const ruleFindings = redactFindings(
    pypiAdapter.runFindings({
      staged: staged.artifact,
      baseline: baseline.artifact,
      details: staged.details,
      fileDiff: diff,
      manifestDiff: summarizePackageJsonDiff(baseline.artifact?.manifest, staged.artifact.manifest),
      stagedManifestText: null,
    }),
  );
  const packageIdentity = pypiAdapter.describe({
    input: adapterInput,
    staged: staged.artifact,
    details: staged.details,
    baseline: baseline.baseline,
    previous: baseline.artifact,
  });
  const details = staged.details as PyPiAdapterDetails;

  return {
    ecosystem: "pypi",
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

export { PYPI_RELEASE_MANIFEST_SCHEMA, PYPI_RULE_IDS, PYPI_RULES_VERSION } from "./types";
export type {
  PyPiAdapterDetails,
  PyPiAdapterInput,
  PyPiArtifactInput,
  PyPiArtifactKind,
  PyPiArtifactSummary,
  PyPiBaselineSelection,
  PyPiBaselineSelectionSource,
  PyPiPreparedArtifact,
  PyPiProjectMetadata,
  PyPiReleaseCandidateReview,
  PyPiReleaseFile,
  PyPiReleaseManifest,
  PyPiReleaseManifestArtifact,
  PyPiRemoteArtifact,
} from "./types";
export {
  inferPyPiArtifactKind,
  isValidPyPiProjectName,
  normalizePyPiProjectName,
  parsePyPiAdapterInput,
  parsePyPiReleaseManifest,
} from "./manifest";
export {
  isAllowedPyPiArtifactUrl,
  pickPyPiBaselineRelease,
  preparePyPiArtifact,
  selectPyPiReleaseArtifacts,
} from "./acquire";
