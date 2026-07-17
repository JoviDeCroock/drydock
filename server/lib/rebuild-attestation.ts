// Rebuild attestation: opt-in verification that a staged npm artifact can be
// reproduced from its declared source repository ("checkout + install + build
// + pack" matches the staged bytes). This is the empirical upgrade of the
// intent envelope's `declared` tier — see `intent-envelope.ts` and
// `docs/rebuild-attestation.md`.
//
// Everything the rebuild consumes is attacker-controlled (repository URL,
// gitHead, repository contents, build scripts, dependency tree), so:
//
//  - The rebuild runs in a disposable Cloudflare container with a
//    deny-by-default egress allowlist and zero credentials (`rebuild-sandbox.ts`).
//  - The container's output (a hash manifest) is treated as hostile input and
//    re-validated here; the comparison itself runs in the Worker against the
//    scan's persisted artifact hashes, never inside the container.
//  - The result is advisory metadata only. A match proves *binding* ("these
//    bytes are what this commit builds"), never benignness; a mismatch or
//    failure is informational and must never change risk levels or findings.
//
// This module is pure (no bindings, no fetch) and shared with the UI.

export type RebuildAttestationStatus =
  | "pending"
  | "byte-identical"
  | "file-identical"
  | "diverged"
  | "inconclusive";

export interface RebuildRef {
  kind: "git-head" | "version-tag";
  /** A full git object id for `git-head`, a tag name for `version-tag`. */
  value: string;
}

export interface RebuildPlan {
  /** Normalized https repository URL from the intent envelope. */
  repository: string;
  /** Checkout candidates in preference order (gitHead first). */
  refs: RebuildRef[];
  /** `repository.directory` for monorepo packages, validated. */
  directory: string | null;
  packageName: string | null;
  version: string | null;
  /** SHA-1 of the staged tarball, for the byte-identical comparison. */
  expectedShasum: string | null;
}

export interface RebuildToolchain {
  packageManager: string | null;
  node: string | null;
}

export interface RebuildComparison {
  /** Null when either side lacks a tarball digest. */
  tarballShasumMatch: boolean | null;
  stagedFileCount: number;
  rebuiltFileCount: number;
  matchedFileCount: number;
  divergentPaths: string[];
  missingFromRebuild: string[];
  extraInRebuild: string[];
}

export interface RebuildSignal {
  kind: string;
  detail: string;
}

export interface RebuildAttestation {
  status: RebuildAttestationStatus;
  /** What the rebuild attempted (or will attempt while `pending`). */
  plan: RebuildPlan | null;
  /** The ref that was actually checked out, once the rebuild ran. */
  ref: RebuildRef | null;
  toolchain: RebuildToolchain | null;
  comparison: RebuildComparison | null;
  signals: RebuildSignal[];
  completedAt: string | null;
}

/** Hash manifest produced inside the rebuild container. Hostile input. */
export interface RebuildOutputManifest {
  tarballSha1: string | null;
  files: Array<{ path: string; sha256: string }>;
}

const STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "byte-identical",
  "file-identical",
  "diverged",
  "inconclusive",
]);
const REF_KINDS: ReadonlySet<string> = new Set(["git-head", "version-tag"]);

const GIT_OBJECT_ID_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
// Conservative tag/directory charset: these values are interpolated into
// container commands (always shell-quoted, but defense in depth is free).
// `@` is allowed (not leading `@{`, which git refnames forbid) so
// changesets-style monorepo tags like `@scope/pkg@2.0.0` validate.
const TAG_RE = /^[A-Za-z0-9@][A-Za-z0-9._/@-]{0,127}$/;
const DIRECTORY_SEGMENT_RE = /^[A-Za-z0-9_.@-]+$/;
const MAX_REFS = 4;
const MAX_PATH_LIST = 50;
const MAX_FILES_IN_MANIFEST = 20_000;
const MAX_SIGNALS = 20;
const MAX_TEXT = 512;

export interface RebuildPlanInput {
  ecosystem: string;
  /** Normalized repository URL from the intent envelope (null when absent). */
  repository: string | null;
  /** `gitHead` from the staged version manifest, when present. */
  gitHead: string | null | undefined;
  packageName: string | null;
  version: string | null;
  /** SHA-1 shasum of the staged tarball from the staged publish details. */
  shasum: string | null | undefined;
  /** Staged package.json text, for `repository.directory`. */
  manifestText: string | null;
}

/**
 * Decide whether a scan is rebuildable and pin down what to attempt. Returns
 * null when there is nothing actionable (wrong ecosystem, no repository
 * binding, or no checkout candidate) — callers then skip the attestation
 * entirely rather than persisting a doomed plan.
 */
export function computeRebuildPlan(input: RebuildPlanInput): RebuildPlan | null {
  if (input.ecosystem !== "npm") return null;
  if (!input.repository || !/^https:\/\/[^/]+\/.+/.test(input.repository)) return null;

  const refs: RebuildRef[] = [];
  const gitHead = typeof input.gitHead === "string" ? input.gitHead.trim().toLowerCase() : "";
  if (GIT_OBJECT_ID_RE.test(gitHead)) refs.push({ kind: "git-head", value: gitHead });
  const version = typeof input.version === "string" ? input.version.trim() : "";
  if (version && TAG_RE.test(version)) {
    refs.push({ kind: "version-tag", value: `v${version}` });
    // Changesets-style monorepo release tags (`@scope/pkg@2.0.0`).
    const packageTag = input.packageName ? `${input.packageName}@${version}` : null;
    if (packageTag && TAG_RE.test(packageTag)) {
      refs.push({ kind: "version-tag", value: packageTag });
    }
    refs.push({ kind: "version-tag", value: version });
  }
  if (!refs.length) return null;

  return {
    repository: input.repository,
    refs: refs.slice(0, MAX_REFS),
    directory: extractRepositoryDirectory(input.manifestText),
    packageName: input.packageName,
    version: version || null,
    expectedShasum: normalizeSha1(input.shasum),
  };
}

/**
 * `repository.directory` from the staged manifest, accepted only when it is a
 * plain relative path (no traversal, no absolute paths, bounded depth).
 */
export function extractRepositoryDirectory(manifestText: string | null): string | null {
  if (!manifestText) return null;
  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    return null;
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return null;
  const repository = (manifest as { repository?: unknown }).repository;
  if (!repository || typeof repository !== "object" || Array.isArray(repository)) return null;
  const raw = (repository as { directory?: unknown }).directory;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().replace(/^\.\//, "").replace(/\/+$/, "");
  if (!trimmed || trimmed.length > 200) return null;
  const segments = trimmed.split("/");
  if (segments.length > 8) return null;
  if (!segments.every((segment) => DIRECTORY_SEGMENT_RE.test(segment) && segment !== "..")) {
    return null;
  }
  return segments.join("/");
}

export interface RebuildComparisonInput {
  expectedShasum: string | null;
  /** Staged artifact file hashes from the scan's persisted artifacts. */
  stagedFiles: Array<{ path: string; sha256: string | null }>;
  /** Hash manifest the rebuild container produced. Hostile input. */
  output: RebuildOutputManifest;
}

export interface RebuildComparisonOutcome {
  status: Extract<RebuildAttestationStatus, "byte-identical" | "file-identical" | "diverged">;
  comparison: RebuildComparison;
}

/**
 * Compare the rebuilt package against the staged artifact. Ladder:
 * byte-identical (tarball SHA-1 matches the staged shasum) > file-identical
 * (every packed file's sha256 matches) > diverged. Returns null when the
 * staged side is missing hashes — the caller reports `inconclusive` instead of
 * guessing.
 */
export function compareRebuildOutput(
  input: RebuildComparisonInput,
): RebuildComparisonOutcome | null {
  const staged = new Map<string, string>();
  for (const file of input.stagedFiles) {
    if (typeof file.sha256 !== "string" || !file.sha256) return null;
    staged.set(normalizePath(file.path), file.sha256.toLowerCase());
  }
  if (!staged.size) return null;

  const rebuilt = new Map<string, string>();
  for (const file of input.output.files.slice(0, MAX_FILES_IN_MANIFEST)) {
    rebuilt.set(normalizePath(file.path), file.sha256.toLowerCase());
  }

  const divergentPaths: string[] = [];
  const missingFromRebuild: string[] = [];
  let matchedFileCount = 0;
  for (const [path, sha256] of staged) {
    const other = rebuilt.get(path);
    if (other === undefined) missingFromRebuild.push(path);
    else if (other === sha256) matchedFileCount += 1;
    else divergentPaths.push(path);
  }
  const extraInRebuild = [...rebuilt.keys()].filter((path) => !staged.has(path));
  divergentPaths.sort();
  missingFromRebuild.sort();
  extraInRebuild.sort();

  const expected = normalizeSha1(input.expectedShasum);
  const actual = normalizeSha1(input.output.tarballSha1);
  const tarballShasumMatch = expected && actual ? expected === actual : null;
  const filesIdentical =
    !divergentPaths.length && !missingFromRebuild.length && !extraInRebuild.length;

  const comparison: RebuildComparison = {
    tarballShasumMatch,
    stagedFileCount: staged.size,
    rebuiltFileCount: rebuilt.size,
    matchedFileCount,
    divergentPaths: divergentPaths.slice(0, MAX_PATH_LIST),
    missingFromRebuild: missingFromRebuild.slice(0, MAX_PATH_LIST),
    extraInRebuild: extraInRebuild.slice(0, MAX_PATH_LIST),
  };

  if (tarballShasumMatch === true && filesIdentical) {
    return { status: "byte-identical", comparison };
  }
  if (filesIdentical) return { status: "file-identical", comparison };
  return { status: "diverged", comparison };
}

function normalizePath(path: string): string {
  let value = path.trim().replace(/\\/g, "/");
  while (value.startsWith("./")) value = value.slice(2);
  if (value.startsWith("package/")) value = value.slice("package/".length);
  return value;
}

function normalizeSha1(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return /^[0-9a-f]{40}$/.test(trimmed) ? trimmed : null;
}

/**
 * Re-validate a persisted attestation from an untyped summary blob. Malformed
 * or internally inconsistent data reads as null rather than a partial result —
 * a verdict must not outlive the evidence that justified it. Follows the
 * `normalizeIntentEnvelope` pattern.
 */
export function normalizeRebuildAttestation(value: unknown): RebuildAttestation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Partial<Record<keyof RebuildAttestation, unknown>>;
  if (typeof item.status !== "string" || !STATUSES.has(item.status)) return null;
  const status = item.status as RebuildAttestationStatus;

  const plan = normalizePlan(item.plan);
  const ref = normalizeRef(item.ref);
  const toolchain = normalizeToolchain(item.toolchain);
  const comparison = normalizeComparison(item.comparison);
  const signals = normalizeSignals(item.signals);
  const completedAt =
    typeof item.completedAt === "string" && item.completedAt.trim()
      ? item.completedAt.slice(0, 64)
      : null;

  // Verdicts require the evidence backing them; a pending record requires an
  // actionable plan.
  if (status === "pending" && !plan) return null;
  if (
    (status === "byte-identical" || status === "file-identical" || status === "diverged") &&
    (!comparison || !plan)
  ) {
    return null;
  }
  if (status === "byte-identical" && comparison?.tarballShasumMatch !== true) return null;

  return { status, plan, ref, toolchain, comparison, signals, completedAt };
}

function normalizePlan(value: unknown): RebuildPlan | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Partial<Record<keyof RebuildPlan, unknown>>;
  if (typeof item.repository !== "string" || !/^https:\/\/[^/]+\/.+/.test(item.repository)) {
    return null;
  }
  const refs: RebuildRef[] = [];
  if (Array.isArray(item.refs)) {
    for (const raw of item.refs.slice(0, MAX_REFS)) {
      const ref = normalizeRef(raw);
      if (ref) refs.push(ref);
    }
  }
  if (!refs.length) return null;
  const directory =
    typeof item.directory === "string" && item.directory ? item.directory.slice(0, 200) : null;
  return {
    repository: item.repository.slice(0, MAX_TEXT),
    refs,
    directory,
    packageName: readBoundedString(item.packageName),
    version: readBoundedString(item.version),
    expectedShasum: normalizeSha1(item.expectedShasum as string | null | undefined),
  };
}

function normalizeRef(value: unknown): RebuildRef | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { kind, value: refValue } = value as { kind?: unknown; value?: unknown };
  if (typeof kind !== "string" || !REF_KINDS.has(kind)) return null;
  if (typeof refValue !== "string" || !refValue.trim()) return null;
  if (kind === "git-head" && !GIT_OBJECT_ID_RE.test(refValue.trim().toLowerCase())) return null;
  if (kind === "version-tag" && !TAG_RE.test(refValue.trim())) return null;
  return { kind: kind as RebuildRef["kind"], value: refValue.trim().slice(0, 128) };
}

function normalizeToolchain(value: unknown): RebuildToolchain | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as { packageManager?: unknown; node?: unknown };
  const packageManager = readBoundedString(item.packageManager);
  const node = readBoundedString(item.node);
  if (!packageManager && !node) return null;
  return { packageManager, node };
}

function normalizeComparison(value: unknown): RebuildComparison | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Partial<Record<keyof RebuildComparison, unknown>>;
  const stagedFileCount = readCount(item.stagedFileCount);
  const rebuiltFileCount = readCount(item.rebuiltFileCount);
  const matchedFileCount = readCount(item.matchedFileCount);
  if (stagedFileCount === null || rebuiltFileCount === null || matchedFileCount === null) {
    return null;
  }
  return {
    tarballShasumMatch:
      typeof item.tarballShasumMatch === "boolean" ? item.tarballShasumMatch : null,
    stagedFileCount,
    rebuiltFileCount,
    matchedFileCount,
    divergentPaths: readPathList(item.divergentPaths),
    missingFromRebuild: readPathList(item.missingFromRebuild),
    extraInRebuild: readPathList(item.extraInRebuild),
  };
}

function normalizeSignals(value: unknown): RebuildSignal[] {
  const signals: RebuildSignal[] = [];
  if (!Array.isArray(value)) return signals;
  for (const signal of value.slice(0, MAX_SIGNALS)) {
    if (!signal || typeof signal !== "object" || Array.isArray(signal)) continue;
    const { kind, detail } = signal as { kind?: unknown; detail?: unknown };
    if (typeof kind !== "string" || typeof detail !== "string") continue;
    signals.push({ kind: kind.slice(0, MAX_TEXT), detail: detail.slice(0, MAX_TEXT) });
  }
  return signals;
}

function readPathList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, MAX_PATH_LIST)
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.slice(0, MAX_TEXT));
}

function readCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function readBoundedString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, MAX_TEXT) : null;
}
