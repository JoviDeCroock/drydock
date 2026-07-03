import type { FileRecord, PackageJsonSummary } from "../../review";
import { stripCommonArchiveRoot } from "../artifact-input";
import type { AcquiredArtifact, AdapterContext, BaselineInfo, StagedDetails } from "../types";
import { cratesStaticArtifactUrl, type CratesBroker } from "./broker";
import { summarizeCratesArtifact } from "./findings";
import { inferCratesArtifactKind } from "./manifest";
import type {
  CratesAdapterDetails,
  CratesAdapterInput,
  CratesArtifactInput,
  CratesIndexEntry,
  CratesPreparedArtifact,
  CratesReleaseManifest,
} from "./types";

export function prepareCratesArtifact(input: CratesArtifactInput): CratesPreparedArtifact {
  const kind = inferCratesArtifactKind(input.path);
  if (!kind) throw new Error("crates artifact must be a .crate archive");
  // A `.crate` is a gzipped tar rooted at `{name}-{version}/`; strip that root
  // so staged/baseline diffs align across versions.
  const files = stripCommonArchiveRoot(input.files);
  return {
    path: input.path,
    kind,
    files,
    summary: summarizeCratesArtifact(input.path, files),
    ...(input.suspiciousEntries ? { suspiciousEntries: input.suspiciousEntries } : {}),
  };
}

export function acquireStagedCrates(input: CratesAdapterInput): {
  artifact: AcquiredArtifact;
  details: StagedDetails;
} {
  assertManifestArtifactSet(input.manifest, input.artifacts);
  const preparedArtifacts = input.artifacts.map(prepareCratesArtifact);
  if (preparedArtifacts.length !== 1) {
    // cargo publishes exactly one `.crate` per version; two archives claiming
    // the same crate release is ambiguous and must not ship.
    throw new Error("a crates release candidate must contain exactly one .crate artifact");
  }
  const [prepared] = preparedArtifacts;
  return {
    artifact: {
      files: prepared.files,
      manifest: manifestSummaryFor(input.manifest, prepared),
    },
    details: {
      manifest: input.manifest,
      artifacts: [prepared.summary],
      preparedArtifacts,
    } satisfies CratesAdapterDetails,
  };
}

export async function acquireBaselineCrates(
  ctx: AdapterContext,
  input: CratesAdapterInput,
  broker: CratesBroker,
): Promise<{ artifact: AcquiredArtifact | null; baseline: BaselineInfo }> {
  if (input.previousArtifacts?.length) {
    return baselineFromPreviousCratesArtifacts(input);
  }

  const entries = input.metadata ?? (await broker.fetchIndexEntries(input.manifest.package));
  if (!entries) return emptyCratesBaseline("index-unavailable");

  const version = pickCratesBaselineVersion(entries, input.manifest.version);
  if (!version) return emptyCratesBaseline("no-published-baseline");

  const url = cratesStaticArtifactUrl(input.manifest.package, version);
  const result = await broker.downloadPublicArtifact(url);
  const prepared = prepareCratesArtifact({
    path: `${input.manifest.package.toLowerCase()}-${version}.crate`,
    files: result.files,
  });
  return {
    artifact: {
      files: prepared.files,
      manifest: manifestSummaryFor(input.manifest, prepared),
    },
    baseline: {
      version,
      tag: null,
      source: "latest-published",
      distTagVersion: null,
      reason: "index-newest-published",
    },
  };
}

export function baselineFromPreviousCratesArtifacts(input: CratesAdapterInput): {
  artifact: AcquiredArtifact | null;
  baseline: BaselineInfo;
} {
  if (!input.previousArtifacts?.length) return emptyCratesBaseline("no-previous-artifacts");
  const prepared = prepareCratesArtifact(input.previousArtifacts[0]);
  const manifest = manifestSummaryFor(input.manifest, prepared);
  return {
    artifact: { files: prepared.files, manifest },
    baseline: {
      version: manifest.version ?? null,
      tag: null,
      source: "latest-published",
      distTagVersion: null,
      reason: "provided-previous-artifacts",
    },
  };
}

/**
 * The sparse index appends entries in publication order, so the newest
 * published version is the last non-yanked entry that is not the candidate
 * itself.
 */
export function pickCratesBaselineVersion(
  entries: CratesIndexEntry[],
  candidateVersion: string,
): string | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.yanked) continue;
    const version = typeof entry.vers === "string" ? entry.vers : "";
    if (!version || version === candidateVersion) continue;
    if (!/^[0-9][A-Za-z0-9.+-]{0,127}$/.test(version)) continue;
    return version;
  }
  return null;
}

function emptyCratesBaseline(reason: string): { artifact: null; baseline: BaselineInfo } {
  return {
    artifact: null,
    baseline: {
      version: null,
      tag: null,
      source: "none",
      distTagVersion: null,
      reason,
    },
  };
}

function assertManifestArtifactSet(
  manifest: CratesReleaseManifest,
  artifacts: CratesArtifactInput[],
): void {
  const manifestPaths = sortedUnique(manifest.artifacts.map((artifact) => artifact.path));
  const artifactPaths = sortedUnique(artifacts.map((artifact) => artifact.path));
  if (
    manifestPaths.length !== manifest.artifacts.length ||
    artifactPaths.length !== artifacts.length ||
    manifestPaths.length !== artifactPaths.length ||
    manifestPaths.some((path, index) => path !== artifactPaths[index])
  ) {
    throw new Error("review artifacts must exactly match manifest artifacts");
  }
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

export function pickCratesPackageIdentity(
  manifest: CratesReleaseManifest,
  artifacts: CratesPreparedArtifact[],
): { name: string | null; version: string | null } {
  const summary = artifacts.find(
    (artifact) => artifact.summary.manifest.name && artifact.summary.manifest.version,
  )?.summary;
  return {
    name: summary?.manifest.name ?? manifest.package ?? null,
    version: summary?.manifest.version ?? manifest.version ?? null,
  };
}

function manifestSummaryFor(
  manifest: CratesReleaseManifest,
  prepared: CratesPreparedArtifact,
): PackageJsonSummary {
  const identity = pickCratesPackageIdentity(manifest, [prepared]);
  return {
    name: identity.name ?? undefined,
    version: identity.version ?? undefined,
  };
}

export function cratesBaselineFiles(baseline: AcquiredArtifact | null): FileRecord[] | null {
  return baseline?.files ?? null;
}
