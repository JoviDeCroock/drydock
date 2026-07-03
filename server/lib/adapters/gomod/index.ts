import {
  computeRisk,
  createPackageDiff,
  deterministicFindings,
  redactFindings,
  summarizePackageJsonDiff,
} from "../../review";
import type { PackageAdapter, ReleaseProvenance } from "../types";
import {
  acquireBaselineGo,
  acquireStagedGo,
  baselineFromPreviousGoArtifacts,
  pickGoPackageIdentity,
} from "./acquire";
import { createGoBroker, type GoBroker } from "./broker";
import { goReleaseFindings } from "./findings";
import { parseGoAdapterInput } from "./manifest";
import type {
  GoAdapterDetails,
  GoAdapterInput,
  GoArtifactInput,
  GoReleaseCandidateReview,
  GoReleaseManifest,
} from "./types";

export const goAdapter: PackageAdapter<GoAdapterInput, GoBroker> = {
  id: "go",
  codePatternSet: "go",

  parseInput(raw: unknown): GoAdapterInput {
    return parseGoAdapterInput(raw);
  },

  createBroker(ctx, ref) {
    return createGoBroker(ctx, ref);
  },

  async acquireStaged(_ctx, input, _broker) {
    return acquireStagedGo(input);
  },

  async acquireBaseline(ctx, input, broker, _staged) {
    return acquireBaselineGo(ctx, input, broker);
  },

  runFindings(args) {
    const details = args.details as GoAdapterDetails;
    return [
      ...deterministicFindings(args.staged.files, args.fileDiff, null, {
        codePatternSet: "go",
      }),
      ...goReleaseFindings(
        details.manifest,
        details.preparedArtifacts,
        args.baseline?.files ?? null,
      ),
    ];
  },

  describe({ details, previous }) {
    const d = details as GoAdapterDetails;
    const identity = pickGoPackageIdentity(d.manifest, d.preparedArtifacts);
    return {
      name: identity.name,
      stagedVersion: identity.version,
      stagedTag: null,
      previousVersion: previous?.manifest?.version ?? null,
    };
  },

  summarizeDetails(details) {
    const d = details as GoAdapterDetails;
    return {
      manifest: d.manifest,
      artifacts: d.artifacts,
      provenance: {
        // Go modules only reach review through the workflow gate; the manifest
        // carries each module zip digest recomputed from the immutable bundle
        // bytes, which the publish job re-verifies before the tag/proxy fetch.
        ecosystem: "go",
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

export function createGoReleaseCandidateReview(input: {
  manifest: GoReleaseManifest;
  artifacts: GoArtifactInput[];
  previousArtifacts?: GoArtifactInput[];
}): GoReleaseCandidateReview {
  const adapterInput = goAdapter.parseInput(input);
  const staged = acquireStagedGo(adapterInput);
  const baseline = baselineFromPreviousGoArtifacts(adapterInput);
  const diff = createPackageDiff(baseline.artifact?.files ?? [], staged.artifact.files);
  const ruleFindings = redactFindings(
    goAdapter.runFindings({
      staged: staged.artifact,
      baseline: baseline.artifact,
      details: staged.details,
      fileDiff: diff,
      manifestDiff: summarizePackageJsonDiff(baseline.artifact?.manifest, staged.artifact.manifest),
      stagedManifestText: null,
    }),
  );
  const packageIdentity = goAdapter.describe({
    input: adapterInput,
    staged: staged.artifact,
    details: staged.details,
    baseline: baseline.baseline,
    previous: baseline.artifact,
  });
  const details = staged.details as GoAdapterDetails;

  return {
    ecosystem: "go",
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

export { GO_RELEASE_MANIFEST_SCHEMA, GO_RULE_IDS, GO_RULES_VERSION } from "./types";
export type {
  GoAdapterInput,
  GoArtifactInput,
  GoPreparedArtifact,
  GoReleaseCandidateReview,
  GoReleaseManifest,
} from "./types";
export {
  inferGoArtifactKind,
  isValidGoModulePath,
  isValidGoVersion,
  parseGoModFile,
  parseGoModuleZipRoot,
  parseGoReleaseManifest,
} from "./manifest";
export { compareGoVersions, pickGoBaselineVersion, prepareGoArtifact } from "./acquire";
export { escapeGoModulePath, goProxyZipUrl, isAllowedGoProxyArtifactUrl } from "./broker";
