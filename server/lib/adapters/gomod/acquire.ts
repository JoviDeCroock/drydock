import type { FileRecord, PackageJsonSummary } from "../../review";
import type { AcquiredArtifact, AdapterContext, BaselineInfo, StagedDetails } from "../types";
import { goProxyZipUrl, type GoBroker } from "./broker";
import { summarizeGoArtifact } from "./findings";
import { inferGoArtifactKind, isValidGoVersion, parseGoModuleZipRoot } from "./manifest";
import type {
  GoAdapterDetails,
  GoAdapterInput,
  GoArtifactInput,
  GoPreparedArtifact,
  GoReleaseManifest,
} from "./types";

export function prepareGoArtifact(input: GoArtifactInput): GoPreparedArtifact {
  const kind = inferGoArtifactKind(input.path);
  if (!kind) throw new Error("Go artifact must be a module .zip archive");
  // Module zips are rooted at `{module}@{version}/`; strip that root so
  // staged/baseline diffs align across versions. The parsed root feeds the
  // identity rules.
  const root = parseGoModuleZipRoot(input.files);
  const files = root
    ? input.files.map((file) => ({
        ...file,
        path: file.path.slice(`${root.modulePath}@${root.version}/`.length),
      }))
    : input.files;
  return {
    path: input.path,
    kind,
    files,
    summary: summarizeGoArtifact(input.path, files, root),
    ...(input.suspiciousEntries ? { suspiciousEntries: input.suspiciousEntries } : {}),
  };
}

export function acquireStagedGo(input: GoAdapterInput): {
  artifact: AcquiredArtifact;
  details: StagedDetails;
} {
  assertManifestArtifactSet(input.manifest, input.artifacts);
  const preparedArtifacts = input.artifacts.map(prepareGoArtifact);
  if (preparedArtifacts.length !== 1) {
    // A Go module version is exactly one zip; two archives claiming the same
    // release is ambiguous and must not ship.
    throw new Error("a Go release candidate must contain exactly one module zip artifact");
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
    } satisfies GoAdapterDetails,
  };
}

export async function acquireBaselineGo(
  ctx: AdapterContext,
  input: GoAdapterInput,
  broker: GoBroker,
): Promise<{ artifact: AcquiredArtifact | null; baseline: BaselineInfo }> {
  if (input.previousArtifacts?.length) {
    return baselineFromPreviousGoArtifacts(input);
  }

  const versions = input.metadata ?? (await broker.fetchVersionList(input.manifest.package));
  if (!versions) return emptyGoBaseline("proxy-unavailable");

  const version = pickGoBaselineVersion(versions, input.manifest.version);
  if (!version) return emptyGoBaseline("no-published-baseline");

  const url = goProxyZipUrl(input.manifest.package, version);
  const result = await broker.downloadPublicArtifact(url);
  const prepared = prepareGoArtifact({
    path: `${version}.zip`,
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
      reason: "proxy-highest-semver",
    },
  };
}

export function baselineFromPreviousGoArtifacts(input: GoAdapterInput): {
  artifact: AcquiredArtifact | null;
  baseline: BaselineInfo;
} {
  if (!input.previousArtifacts?.length) return emptyGoBaseline("no-previous-artifacts");
  const prepared = prepareGoArtifact(input.previousArtifacts[0]);
  const manifest = manifestSummaryFor(input.manifest, prepared);
  return {
    artifact: { files: prepared.files, manifest },
    baseline: {
      version: prepared.summary.module.rootVersion ?? null,
      tag: null,
      source: "latest-published",
      distTagVersion: null,
      reason: "provided-previous-artifacts",
    },
  };
}

/**
 * Highest canonical semver from the proxy `@v/list` that is not the candidate
 * itself. `@v/list` order is unspecified, so versions are compared, not
 * position-picked.
 */
export function pickGoBaselineVersion(versions: string[], candidateVersion: string): string | null {
  let best: string | null = null;
  for (const version of versions) {
    if (!isValidGoVersion(version) || version === candidateVersion) continue;
    if (best === null || compareGoVersions(version, best) > 0) best = version;
  }
  return best;
}

export function compareGoVersions(a: string, b: string): number {
  const [coreA, preA] = splitPrerelease(a);
  const [coreB, preB] = splitPrerelease(b);
  const partsA = coreA.slice(1).split(".").map(Number);
  const partsB = coreB.slice(1).split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (partsA[index] !== partsB[index]) return partsA[index] - partsB[index];
  }
  if (preA === null && preB === null) return 0;
  if (preA === null) return 1;
  if (preB === null) return -1;
  return comparePrerelease(preA, preB);
}

function splitPrerelease(version: string): [string, string | null] {
  const withoutBuild = version.split("+")[0];
  const dash = withoutBuild.indexOf("-");
  if (dash < 0) return [withoutBuild, null];
  return [withoutBuild.slice(0, dash), withoutBuild.slice(dash + 1)];
}

function comparePrerelease(a: string, b: string): number {
  const idsA = a.split(".");
  const idsB = b.split(".");
  for (let index = 0; index < Math.max(idsA.length, idsB.length); index += 1) {
    const idA = idsA[index];
    const idB = idsB[index];
    if (idA === undefined) return -1;
    if (idB === undefined) return 1;
    const numA = /^\d+$/.test(idA) ? Number(idA) : null;
    const numB = /^\d+$/.test(idB) ? Number(idB) : null;
    if (numA !== null && numB !== null) {
      if (numA !== numB) return numA - numB;
    } else if (numA !== null) {
      return -1;
    } else if (numB !== null) {
      return 1;
    } else if (idA !== idB) {
      return idA < idB ? -1 : 1;
    }
  }
  return 0;
}

function emptyGoBaseline(reason: string): { artifact: null; baseline: BaselineInfo } {
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
  manifest: GoReleaseManifest,
  artifacts: GoArtifactInput[],
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

export function pickGoPackageIdentity(
  manifest: GoReleaseManifest,
  artifacts: GoPreparedArtifact[],
): { name: string | null; version: string | null } {
  const summary = artifacts.find(
    (artifact) => artifact.summary.module.rootModulePath && artifact.summary.module.rootVersion,
  )?.summary;
  return {
    name: summary?.module.modulePath ?? summary?.module.rootModulePath ?? manifest.package ?? null,
    version: summary?.module.rootVersion ?? manifest.version ?? null,
  };
}

function manifestSummaryFor(
  manifest: GoReleaseManifest,
  prepared: GoPreparedArtifact,
): PackageJsonSummary {
  const identity = pickGoPackageIdentity(manifest, [prepared]);
  return {
    name: identity.name ?? undefined,
    version: identity.version ?? undefined,
  };
}

export function goBaselineFiles(baseline: AcquiredArtifact | null): FileRecord[] | null {
  return baseline?.files ?? null;
}
