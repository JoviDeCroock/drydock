// Dependency-artifact review: the npm half.
//
// Given the dependencies a release newly introduces (selected by the
// ecosystem-free `lib/review/dependency-evidence.ts`), resolve each one to a
// concrete published version, fetch its tarball, parse it in the
// credentials-free sandbox, and reduce it to a durable evidence record.
//
// Two rules bound this module, both from issue #595 and AGENTS.md:
//
//   1. Every fetch here is CREDENTIAL-FREE. The organization's npm token is
//      resolved only to learn which registry to talk to; it is never attached
//      to a dependency request. A dependency that only a credential could
//      reach therefore records as `metadata-unavailable` and fails visibly
//      into manual review — private-dependency support is a separate
//      credential and cache-isolation review, not something this path may
//      quietly grow.
//   2. Dependency bytes are hostile evidence exactly like the reviewed
//      release's own bytes: downloaded by the trusted parent, streamed into
//      the sandbox, never installed, never executed.

import {
  assessDependencyArtifact,
  DEPENDENCY_ARTIFACT_MAX_FILES,
  DEPENDENCY_TEXT_SAMPLE_LIMIT,
  EMPTY_DEPENDENCY_REVIEW,
  failedDependencyReview,
  MAX_INSPECTED_DEPENDENCIES,
  MAX_RECORDED_DEPENDENCIES,
  sanitizeDependencyArtifactOrigin,
  selectAddedDependencies,
  selectBundledAddedDependencies,
  type AddedDependency,
  type DependencyDigest,
  type DependencyEvidence,
  type DependencyReview,
  type DependencyUninspectableReason,
  type FileRecord,
  type PackageJsonDiff,
  type PackageJsonSummary,
} from "../../review";
import {
  describeOperationalError,
  durationMsSince,
  emitOperationalEvent,
} from "../../platform/observability";
import { parseSandboxErrorDetail } from "../../sandbox";
import { parsePackageJson, type TarSuspiciousEntry } from "../../tar-parser.js";
import { isValidNpmPackageName, type RegistryMetadata } from "./registry";
import { maxSatisfyingVersion } from "./semver";
import type { NpmBroker } from "./broker";
import type {
  DependencyInspectionArgs,
  EmbeddedDependencyInspectionArgs,
} from "../package-adapter";

/**
 * Wall-clock budget for the whole dependency pass.
 *
 * The pass is additive evidence, never the reason a scan fails: once the budget
 * is spent, remaining dependencies record as `budget-exhausted` (a visible gap)
 * instead of holding the release's own review hostage to a slow registry.
 */
const DEPENDENCY_REVIEW_BUDGET_MS = 20_000;

/**
 * `PackageAdapter.inspectAddedDependencies` for both npm adapters.
 *
 * Shared by the staged-publish adapter and the workflow-gate adapter so a
 * release gets the same dependency review whichever path it arrives on — the
 * gate is the path this evidence matters most on, since it is the one that can
 * hold a publish.
 */
export function inspectAddedNpmDependenciesForAdapter(
  broker: NpmBroker,
  args: DependencyInspectionArgs,
): Promise<DependencyReview> {
  return inspectAddedNpmDependencies({
    manifestDiff: args.manifestDiff,
    baselineManifestUnavailable: args.baselineManifestUnavailable,
    stagedManifest: args.stagedManifest,
    stagedFiles: args.stagedFiles,
    // A thunk, not a value: the overwhelming majority of releases add no
    // dependency, and resolving the registry costs a D1 read. Nothing should
    // happen at all for those scans.
    resolveRegistryUrl: () => broker.registryUrl(),
    broker,
    scanId: args.scanId,
    organizationId: args.organizationId,
  });
}

/** Review direct bundled children from the exact subtree consumers receive. */
export function inspectBundledNpmDependenciesForAdapter(
  args: EmbeddedDependencyInspectionArgs,
): DependencyReview {
  const selectionOptions = {
    includeWithoutBaseline: args.baselineManifestUnavailable,
    stagedManifest: args.stagedManifest,
    stagedFiles: args.stagedFiles,
  };
  const selected = selectBundledAddedDependencies(args.manifestDiff, selectionOptions);
  if (!selected.length) return EMPTY_DEPENDENCY_REVIEW;

  const recorded = selected.slice(0, MAX_RECORDED_DEPENDENCIES);
  const dependencies = recorded.map((dependency) =>
    inspectBundledDependency(dependency, args.stagedFiles, args.stagedSuspiciousEntries),
  );
  const inspectedCount = dependencies.filter((entry) => entry.status === "inspected").length;
  const omittedCount = selected.length - recorded.length;
  return {
    status: omittedCount || inspectedCount !== selected.length ? "partial" : "complete",
    selectedCount: selected.length,
    inspectedCount,
    uninspectableCount: selected.length - inspectedCount,
    omittedCount,
    dependencies,
  };
}

function inspectBundledDependency(
  dependency: AddedDependency,
  stagedFiles: EmbeddedDependencyInspectionArgs["stagedFiles"],
  stagedSuspiciousEntries: EmbeddedDependencyInspectionArgs["stagedSuspiciousEntries"],
): DependencyEvidence {
  const prefix = `node_modules/${dependency.name}/`;
  const files = stagedFiles
    .filter((file) => file.path.startsWith(prefix))
    .map((file) => ({ ...file, path: file.path.slice(prefix.length) }));
  const suspiciousEntries = (stagedSuspiciousEntries ?? [])
    .filter((entry) => entry.path.startsWith(prefix))
    .map((entry) => ({ ...entry, path: entry.path.slice(prefix.length) }));
  const manifest = parsePackageJson(files);
  const version = typeof manifest?.version === "string" ? manifest.version : null;
  return inspectAcquiredDependency(dependency, {
    files,
    manifest: manifest as PackageJsonSummary | null,
    suspiciousEntries,
    resolvedVersion: version,
    registryHost: null,
    artifactUrl: null,
    declaredDigest: null,
    reviewedDigest: null,
    reviewedSha1: null,
  });
}

export interface InspectDependenciesArgs {
  manifestDiff: PackageJsonDiff;
  baselineManifestUnavailable?: boolean;
  stagedManifest?: DependencyInspectionArgs["stagedManifest"];
  stagedFiles?: DependencyInspectionArgs["stagedFiles"];
  /** Registry the organization's connection points at; used origin-only, never with its token. */
  resolveRegistryUrl: () => Promise<string>;
  broker: NpmBroker;
  scanId: string;
  organizationId: string;
  /** Injectable clock so the budget is testable without real time. */
  now?: () => number;
  /** Injectable wall-clock budget for deadline tests. */
  budgetMs?: number;
}

/**
 * Resolve, fetch, and assess every dependency this release newly introduces.
 *
 * Never throws: each dependency independently reaches a terminal evidence
 * record, and an unexpected pass-wide failure becomes bounded `review-failed`
 * evidence rather than an exception that would cost the release its own review.
 */
export async function inspectAddedNpmDependencies(
  args: InspectDependenciesArgs,
): Promise<DependencyReview> {
  try {
    return await inspectAddedNpmDependenciesInternal(args);
  } catch (err) {
    emitOperationalEvent("warn", "scan.dependency_review.failed", {
      scanId: args.scanId,
      organizationId: args.organizationId,
      error: describeOperationalError(err),
    });
    return failedDependencyReview(args.manifestDiff, selectionOptions(args));
  }
}

async function inspectAddedNpmDependenciesInternal(
  args: InspectDependenciesArgs,
): Promise<DependencyReview> {
  const selected = selectAddedDependencies(args.manifestDiff, selectionOptions(args));
  if (!selected.length) {
    return failedDependencyReview(args.manifestDiff, selectionOptions(args));
  }

  const now = args.now ?? Date.now;
  const budgetMs = args.budgetMs ?? DEPENDENCY_REVIEW_BUDGET_MS;
  const startedAt = now();
  const dependencies: DependencyEvidence[] = [];
  const recorded = selected.slice(0, MAX_RECORDED_DEPENDENCIES);
  const registry = await settleWithin(args.resolveRegistryUrl(), budgetMs);
  if (registry.timedOut) {
    for (const dependency of recorded) {
      dependencies.push(uninspectable(dependency, null, "budget-exhausted"));
    }
    return completeReview(args, selected, recorded, dependencies, null, startedAt, now);
  }
  const registryHost = hostOf(registry.value);
  let deadlineSpent = false;

  for (const [index, dependency] of recorded.entries()) {
    const remainingMs = budgetMs - durationMsSince(startedAt, now());
    const overBudget = deadlineSpent || index >= MAX_INSPECTED_DEPENDENCIES || remainingMs <= 0;
    if (overBudget) {
      dependencies.push(uninspectable(dependency, registryHost, "budget-exhausted"));
      continue;
    }
    let cancelled = false;
    const operationStartedAt = Date.now();
    const deadline: DependencyInspectionDeadline = {
      cancelled: () => cancelled,
      remainingMs: () => Math.max(0, remainingMs - (Date.now() - operationStartedAt)),
    };
    const inspected = await settleWithin(
      inspectOne(args, dependency, registryHost, deadline),
      remainingMs,
      () => {
        cancelled = true;
      },
    );
    if (inspected.timedOut) {
      deadlineSpent = true;
      dependencies.push(uninspectable(dependency, registryHost, "budget-exhausted"));
    } else {
      dependencies.push(inspected.value);
    }
  }

  return completeReview(args, selected, recorded, dependencies, registryHost, startedAt, now);
}

function completeReview(
  args: InspectDependenciesArgs,
  selected: AddedDependency[],
  recorded: AddedDependency[],
  dependencies: DependencyEvidence[],
  registryHost: string | null,
  startedAt: number,
  now: () => number,
): DependencyReview {
  const inspectedCount = dependencies.filter((entry) => entry.status === "inspected").length;
  const uninspectableCount = selected.length - inspectedCount;
  const omittedCount = selected.length - recorded.length;
  const skipped =
    dependencies.filter((entry) => entry.reason === "budget-exhausted").length + omittedCount;

  emitOperationalEvent("info", "scan.dependency_review.completed", {
    scanId: args.scanId,
    organizationId: args.organizationId,
    registryHost,
    durationMs: durationMsSince(startedAt, now()),
    selectedCount: selected.length,
    inspectedCount,
    uninspectableCount,
    omittedCount,
    skippedCount: skipped,
    riskCount: dependencies.filter(
      (entry) => entry.status === "inspected" && entry.observation.risk !== "not-observed",
    ).length,
  });

  return {
    status: skipped || uninspectableCount ? "partial" : "complete",
    selectedCount: selected.length,
    inspectedCount,
    uninspectableCount,
    omittedCount,
    dependencies,
  };
}

function selectionOptions(args: InspectDependenciesArgs) {
  return {
    includeWithoutBaseline: args.baselineManifestUnavailable,
    stagedManifest: args.stagedManifest,
    stagedFiles: args.stagedFiles,
  };
}

async function settleWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout?: () => void,
): Promise<{ timedOut: false; value: T } | { timedOut: true }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(
      () => {
        onTimeout?.();
        resolve({ timedOut: true });
      },
      Math.max(1, timeoutMs),
    );
  });
  try {
    return await Promise.race([
      promise.then((value) => ({ timedOut: false as const, value })),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

interface DependencyInspectionDeadline {
  cancelled: () => boolean;
  remainingMs: () => number;
}

async function inspectOne(
  args: InspectDependenciesArgs,
  dependency: AddedDependency,
  registryHost: string | null,
  deadline: DependencyInspectionDeadline,
): Promise<DependencyEvidence> {
  // A spec that does not name a registry package cannot be resolved to bytes
  // at all: git/URL/workspace specs, and names npm itself would reject. Both
  // are already flagged on the manifest side (`dependency.unusual-spec`); here
  // they are recorded as a coverage gap so the report cannot imply the
  // dependency was reviewed.
  if (dependency.declarationKind === "unusual" || !isValidNpmPackageName(dependency.name)) {
    return uninspectable(dependency, registryHost, "unresolvable-spec");
  }

  if (deadline.cancelled() || deadline.remainingMs() <= 0) {
    return uninspectable(dependency, registryHost, "budget-exhausted");
  }
  const metadata = await args.broker.fetchAnonymousPackageMetadata(dependency.name, {
    timeoutMs: deadline.remainingMs(),
  });
  // `Promise.race` cannot cancel an arbitrary broker stub. This fence ensures
  // a metadata request that settles after the pass deadline cannot start the
  // much more expensive tarball download. The production broker also applies
  // the same remaining deadline to the underlying network request.
  if (deadline.cancelled() || deadline.remainingMs() <= 0) {
    return uninspectable(dependency, registryHost, "budget-exhausted");
  }
  if (!metadata) return uninspectable(dependency, registryHost, "metadata-unavailable");

  const resolved = resolveDependencyVersion(metadata, dependency.spec);
  if (!resolved) {
    return uninspectable(
      dependency,
      registryHost,
      Object.keys(metadata.versions ?? {}).length ? "no-matching-version" : "metadata-unavailable",
    );
  }

  const dist = metadata.versions?.[resolved]?.dist;
  const tarballUrl = dist?.tarball;
  if (!tarballUrl) {
    return uninspectable(dependency, registryHost, "artifact-unavailable", resolved);
  }

  let download;
  try {
    download = await args.broker.downloadAnonymousTarball(tarballUrl, {
      maxFiles: DEPENDENCY_ARTIFACT_MAX_FILES,
      maxTextSampleChars: DEPENDENCY_TEXT_SAMPLE_LIMIT,
      timeoutMs: deadline.remainingMs(),
    });
  } catch (err) {
    const detail = parseSandboxErrorDetail(err);
    emitOperationalEvent("info", "scan.dependency_review.artifact_unavailable", {
      scanId: args.scanId,
      organizationId: args.organizationId,
      dependency: dependency.name,
      resolvedVersion: resolved,
      status: detail?.status ?? null,
      error: describeOperationalError(err),
    });
    return uninspectable(
      dependency,
      registryHost,
      downloadFailureReason(detail),
      resolved,
      tarballUrl,
      declaredDigest(dist),
    );
  }

  if (deadline.cancelled() || deadline.remainingMs() <= 0) {
    return uninspectable(dependency, registryHost, "budget-exhausted");
  }

  const reviewedDigest: DependencyDigest | null = download.archiveSha512
    ? { algorithm: "sha512", value: download.archiveSha512.toLowerCase() }
    : download.archiveSha1
      ? { algorithm: "sha1", value: download.archiveSha1.toLowerCase() }
      : null;
  const declared = declaredDigest(dist, reviewedDigest);

  return inspectAcquiredDependency(dependency, {
    files: download.files,
    manifest: download.packageJson ?? null,
    suspiciousEntries: download.suspiciousEntries ?? [],
    resolvedVersion: resolved,
    registryHost,
    artifactUrl: tarballUrl,
    declaredDigest: declared,
    reviewedDigest,
    reviewedSha1: download.archiveSha1,
  });
}

interface AcquiredDependencyArtifact {
  files: FileRecord[];
  manifest: PackageJsonSummary | null;
  suspiciousEntries: TarSuspiciousEntry[];
  resolvedVersion: string | null;
  registryHost: string | null;
  artifactUrl: string | null;
  declaredDigest: DependencyDigest | null;
  reviewedDigest: DependencyDigest | null;
  reviewedSha1: string | null | undefined;
}

/** Apply one completeness contract to embedded and registry-backed bytes. */
function inspectAcquiredDependency(
  dependency: AddedDependency,
  artifact: AcquiredDependencyArtifact,
): DependencyEvidence {
  if (
    artifact.files.some(
      (file) => file.flags.includes("baseline-truncated") || file.flags.includes("content-skipped"),
    )
  ) {
    return uninspectableAcquired(dependency, "artifact-truncated", artifact);
  }
  if (artifact.suspiciousEntries.some(isAmbiguousDependencyArchiveEntry)) {
    return uninspectableAcquired(dependency, "artifact-ambiguous", artifact);
  }
  if (!artifact.manifest) {
    return uninspectableAcquired(dependency, "manifest-unavailable", artifact);
  }

  const assessment = assessDependencyArtifact(artifact.files, artifact.manifest, {
    codePatternSet: "javascript",
    entrypointResolution: "npm",
  });
  if (assessment.installReachableUninspectedFiles.length) {
    return uninspectableAcquired(dependency, "artifact-truncated", artifact);
  }

  return {
    name: boundedText(dependency.name, 256),
    section: dependency.section,
    declaredSpec: boundedText(dependency.spec, 512),
    declarationKind: dependency.declarationKind,
    status: "inspected",
    reason: null,
    resolvedVersion: artifact.resolvedVersion ? boundedText(artifact.resolvedVersion, 256) : null,
    registryHost: artifact.registryHost,
    artifactOrigin: sanitizeDependencyArtifactOrigin(artifact.artifactUrl),
    declaredDigest: artifact.declaredDigest,
    reviewedDigest: artifact.reviewedDigest,
    digestVerified: compareDigests(
      artifact.declaredDigest,
      artifact.reviewedDigest,
      artifact.reviewedSha1,
    ),
    fileCount: artifact.files.length,
    automaticExecution: assessment.automaticExecution,
    capabilities: assessment.capabilities,
    installReachableCapabilities: assessment.installReachableCapabilities,
    observation: assessment.observation,
  };
}

function uninspectableAcquired(
  dependency: AddedDependency,
  reason: DependencyUninspectableReason,
  artifact: AcquiredDependencyArtifact,
): DependencyEvidence {
  return uninspectable(
    dependency,
    artifact.registryHost,
    reason,
    artifact.resolvedVersion,
    artifact.artifactUrl,
    artifact.declaredDigest,
    artifact.reviewedDigest,
    artifact.reviewedSha1,
    artifact.files.length,
  );
}

function isAmbiguousDependencyArchiveEntry(entry: TarSuspiciousEntry): boolean {
  if (entry.kind === "duplicate" || entry.kind === "unicode-confusable") return true;
  return entry.kind === "non-regular" && !entry.detail.includes("(directory)");
}

/**
 * Which version a consumer install would resolve right now.
 *
 * Dist-tags resolve through the packument's own tag map — `latest` is a moving
 * pointer, and pretending it is a range would silently pick a different
 * version than npm would. For ranges, npm prefers a non-deprecated default
 * `latest` when it satisfies the range, then the highest non-deprecated match,
 * and only falls back to a deprecated match when every satisfying version is
 * deprecated. Unsupported grammar returns null so the caller records a gap
 * instead of guessing.
 */
export function resolveDependencyVersion(metadata: RegistryMetadata, spec: string): string | null {
  const versions = Object.keys(metadata.versions ?? {});
  if (!versions.length) return null;
  const trimmed = spec.trim();
  const tagged = trimmed && metadata["dist-tags"]?.[trimmed];
  if (tagged && versions.includes(tagged)) return tagged;
  const latest = metadata["dist-tags"]?.latest;
  if (
    latest &&
    versions.includes(latest) &&
    !metadata.versions?.[latest]?.deprecated &&
    maxSatisfyingVersion([latest], trimmed)
  ) {
    return latest;
  }
  const nonDeprecated = versions.filter((version) => !metadata.versions?.[version]?.deprecated);
  const preferred = maxSatisfyingVersion(nonDeprecated, trimmed);
  if (preferred) return preferred;
  return maxSatisfyingVersion(versions, trimmed);
}

/**
 * The digest the registry advertised for a version, normalized to lowercase
 * hex.
 *
 * npm publishes `dist.integrity` as base64 SRI and the sandbox returns hex, so
 * one side has to be converted or every healthy dependency would compare as a
 * mismatch. Hex is the stored form because it is what `reviewedDigest` and
 * every other digest in a Drydock report already use, so the two rows in the UI
 * are directly comparable by eye.
 *
 * SHA-512 only: it is the SRI algorithm npm actually emits and the only strong
 * digest the dependency download recomputes. When an integrity field exists but
 * names another algorithm (or is malformed), the review stays unverified rather
 * than falling back to `shasum`: npm consumers prefer `dist.integrity`, so a
 * matching legacy SHA-1 must not hide a mismatch in the authoritative SRI.
 */
function declaredDigest(
  dist: { integrity?: string; integrityPresent?: true; shasum?: string } | undefined,
  reviewed: DependencyDigest | null = null,
) {
  if (!dist) return null;
  const sri = sha512FromIntegrity(dist.integrity);
  if (sri.length) {
    const matching =
      reviewed?.algorithm === "sha512"
        ? sri.find((value) => value === reviewed.value.toLowerCase())
        : null;
    return { algorithm: "sha512", value: matching ?? sri[0] };
  }
  if (dist.integrity !== undefined || dist.integrityPresent) return null;
  return dist.shasum && /^[0-9a-f]{40}$/i.test(dist.shasum)
    ? { algorithm: "sha1", value: dist.shasum.toLowerCase() }
    : null;
}

function sha512FromIntegrity(integrity: string | undefined): string[] {
  if (!integrity || integrity.length > 4_096) return [];
  const digests: string[] = [];
  // An SRI header may list several digests, each optionally carrying `?opts`.
  for (const token of integrity.trim().split(/\s+/)) {
    const metadata = token.split("?", 1)[0];
    if (!metadata.startsWith("sha512-")) continue;
    try {
      const bytes = Uint8Array.from(atob(metadata.slice("sha512-".length)), (char) =>
        char.charCodeAt(0),
      );
      if (bytes.length !== 64) continue;
      digests.push([...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join(""));
    } catch {
      continue;
    }
  }
  return digests;
}

/**
 * Compare what the registry claimed against what Drydock hashed.
 *
 * Returns null — unverified, never "match" and never "mismatch" — whenever the
 * two digests are not directly comparable. A digest nobody recomputed is
 * absence of evidence, and reporting it as a mismatch would accuse a healthy
 * package.
 */
function compareDigests(
  declared: DependencyDigest | null,
  reviewed: DependencyDigest | null,
  reviewedSha1: string | null | undefined,
): boolean | null {
  if (!declared) return null;
  if (declared.algorithm === "sha1") {
    return reviewedSha1 ? declared.value === reviewedSha1.toLowerCase() : null;
  }
  if (!reviewed || reviewed.algorithm !== declared.algorithm) return null;
  return declared.value === reviewed.value.toLowerCase();
}

function downloadFailureReason(
  detail: { error: string | null; status: number | null } | null,
): DependencyUninspectableReason {
  if (detail?.status === 413) return "artifact-too-large";
  if (detail?.status === 400) return "artifact-unparseable";
  return "artifact-unavailable";
}

function uninspectable(
  dependency: AddedDependency,
  registryHost: string | null,
  reason: DependencyUninspectableReason,
  resolvedVersion: string | null = null,
  artifactUrl: string | null = null,
  declared: DependencyDigest | null = null,
  reviewed: DependencyDigest | null = null,
  reviewedSha1: string | null | undefined = null,
  fileCount: number | null = null,
): DependencyEvidence {
  return {
    name: boundedText(dependency.name, 256),
    section: dependency.section,
    declaredSpec: boundedText(dependency.spec, 512),
    declarationKind: dependency.declarationKind,
    status: "uninspectable",
    reason,
    resolvedVersion: resolvedVersion ? boundedText(resolvedVersion, 256) : null,
    registryHost,
    artifactOrigin: sanitizeDependencyArtifactOrigin(artifactUrl),
    declaredDigest: declared,
    reviewedDigest: reviewed,
    digestVerified: compareDigests(declared, reviewed, reviewedSha1),
    fileCount,
    automaticExecution: [],
    capabilities: [],
    installReachableCapabilities: [],
    observation: { execution: "unknown", risk: "unknown" },
  };
}

function boundedText(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function hostOf(registryUrl: string): string | null {
  try {
    return new URL(registryUrl).host;
  } catch {
    return null;
  }
}
