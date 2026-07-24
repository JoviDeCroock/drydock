import { readStreamBounded } from "../tar-parser.js";
import { reliableFetch } from "../reliable-fetch";
import { getInstallationAccessToken } from "./api";
import type { GithubAppConfig } from "./config";
import { githubInstallationHeaders, nextLink } from "./http";
import { extractOuterZipEntries } from "./artifacts-zip";

// ── Public surface ───────────────────────────────────────────────────────────

export interface WorkflowArtifactSource {
  installationExternalId: string;
  repositoryFullName: string;
  runId: number;
  /** Exact GitHub Actions artifact name selected by a release-target override. */
  artifactName?: string;
  /**
   * Default shard family selected by an ecosystem adapter. Matches the exact
   * name plus `-${shard}` suffixes, so a large release can upload one bounded
   * GitHub artifact per distribution without sweeping unrelated run output.
   */
  artifactNamePrefix?: string;
}

/**
 * Decide whether a bundle entry is a reviewable artifact and which ecosystem it
 * belongs to. The shared fetcher is ecosystem-agnostic: a single-ecosystem
 * workflow-gate adapter (pinned targets) or the registry's combined classifier
 * (auto-detect targets) supplies this. Both `ecosystem` and `kind` are opaque
 * here — PyPI returns `{ ecosystem: "pypi", kind: "wheel" | "sdist" }`; other
 * ecosystems pick their own. Returning `null` drops the entry — it is never
 * collected or scanned. Tagging each kept entry with its ecosystem is what lets
 * one monorepo bundle fan out into per-ecosystem, per-package reviews.
 */
export type ClassifyArtifact = (path: string) => { ecosystem: string; kind: string } | null;

export interface ResolvedReleaseFile {
  path: string;
  bytes: Uint8Array;
  sha256: string;
  ecosystem: string;
  kind: string;
}

export interface ResolvedReleaseBundle<TArtifact = ResolvedReleaseFile> {
  artifacts: TArtifact[];
  /** First downloaded GitHub Actions artifact id; retained for old callers/tests. */
  artifactId: number;
  /** First downloaded GitHub Actions artifact name, or "all" when several were inspected. */
  artifactName: string;
  /** Total downloaded GitHub Actions artifact ZIP bytes. */
  artifactSizeBytes: number;
}

export type WorkflowArtifactErrorCode =
  | "bundle_unavailable"
  | "bundle_too_large"
  | "bundle_empty"
  | "artifact_path_unsafe"
  | "artifact_identity_missing"
  | "artifact_identity_inconsistent";

export class WorkflowArtifactError extends Error {
  constructor(
    public code: WorkflowArtifactErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WorkflowArtifactError";
  }
}

// ── Configuration ────────────────────────────────────────────────────────────

export const MAX_OUTER_ZIP_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_ARTIFACT_ZIP_BYTES = 50 * 1024 * 1024;
// Production consumes large releases one shard at a time. The whole release
// still has a work budget, but it no longer needs to fit in the parent Worker's
// heap the way the legacy raw-byte collector does.
const MAX_STREAMED_TOTAL_ARTIFACT_ZIP_BYTES = 768 * 1024 * 1024;
export const MAX_OUTER_ZIP_ENTRIES = 256;
export const MAX_PER_ENTRY_BYTES = 25 * 1024 * 1024;
const MAX_RELEASE_ARTIFACTS = 20;
const MAX_STREAMED_RELEASE_ARTIFACTS = 128;
const MAX_RUN_ARTIFACTS = 128;
const MAX_LIST_PAGES = 4;
const MAX_DOWNLOAD_REDIRECTS = 4;

const REPOSITORY_FULL_NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

// ── Egress allowlist ─────────────────────────────────────────────────────────

export interface GithubArtifactEgressPolicy {
  allowed: boolean;
  /** Whether the installation token may be attached to this request. */
  credentialed: boolean;
  host: "api.github.com" | "actions.githubusercontent.com" | "blob.core.windows.net" | "blocked";
}

/**
 * Mirrors the `NpmStageGateway` credential policy for the GitHub artifact path.
 * The installation token is only ever attached to `api.github.com`. The
 * artifact-download endpoint answers with a 302 to a short-lived signed URL on
 * GitHub's artifact storage hosts; that hop carries its own auth in the URL, so
 * the token is dropped before the request is issued. Every other host is blocked
 * outright, so a spoofed `Location` cannot exfiltrate the token to an
 * attacker-controlled origin.
 */
export function evaluateGithubArtifactEgress(requestUrl: string): GithubArtifactEgressPolicy {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return { allowed: false, credentialed: false, host: "blocked" };
  }
  if (url.protocol !== "https:") {
    return { allowed: false, credentialed: false, host: "blocked" };
  }
  const host = url.hostname.toLowerCase();
  if (host === "api.github.com") {
    return { allowed: true, credentialed: true, host: "api.github.com" };
  }
  if (host === "actions.githubusercontent.com" || host.endsWith(".actions.githubusercontent.com")) {
    return { allowed: true, credentialed: false, host: "actions.githubusercontent.com" };
  }
  if (host.endsWith(".blob.core.windows.net") && url.pathname.startsWith("/actions-results/")) {
    return { allowed: true, credentialed: false, host: "blob.core.windows.net" };
  }
  return { allowed: false, credentialed: false, host: "blocked" };
}

// ── Entry points ─────────────────────────────────────────────────────────────

/**
 * Resolve a release bundle from a pre-fetched installation access token. The
 * gate-aware caller is responsible for swapping the GitHub App JWT for a fresh
 * installation token; isolating that step lets us test artifact ingestion
 * without supplying a real RSA private key.
 *
 * Identity (`package`/`version`) is derived from the artifacts themselves
 * downstream by the ecosystem's `WorkflowGateAdapter`
 * (`server/lib/workflow-gates`) once the bytes have been parsed in the sandbox.
 * This stage enumerates the workflow run's non-expired GitHub Actions artifacts
 * unless `source.artifactName` narrows it to one named upload or
 * `source.artifactNamePrefix` narrows it to one shard family. It then collects
 * only the inner files the supplied `classifyArtifact` keeps and recomputes
 * their SHA-256; every other file in every upload is ignored.
 *
 * This raw-byte collector retains every distribution's bytes at once, so it
 * keeps the tighter 20-file/50-MiB budget and is exercised only by the artifact
 * ingestion invariant tests. Production goes through
 * `processReleaseBundleForGate`.
 */
export async function fetchReleaseBundleWithToken(
  installationToken: string,
  source: WorkflowArtifactSource,
  classifyArtifact: ClassifyArtifact,
): Promise<ResolvedReleaseBundle> {
  return processReleaseBundle(
    installationToken,
    source,
    classifyArtifact,
    {
      maxReleaseArtifacts: MAX_RELEASE_ARTIFACTS,
      maxTotalZipBytes: MAX_TOTAL_ARTIFACT_ZIP_BYTES,
    },
    async (artifact) => artifact,
  );
}

/**
 * Resolve a large release without retaining its raw distribution bytes.
 *
 * Each GitHub Actions artifact ZIP remains capped at 25 MiB, while the caller
 * consumes every classified wheel/sdist before the next shard is downloaded.
 * Production uses this to parse a distribution in the credentials-free sandbox
 * and retain only compact evidence. The raw-byte collector above deliberately
 * keeps its tighter 20-file/50-MiB limits.
 *
 * The larger budget is only granted when an exact name or shard-family prefix
 * narrows the run to the release upload. An unnarrowed source matches every
 * non-expired artifact on the run — including unrelated logs, coverage, and
 * build output — so it keeps the tighter budget rather than spending a Worker
 * invocation downloading up to 768 MiB of files that were never release
 * candidates.
 */
export async function processReleaseBundleWithToken<TArtifact>(
  installationToken: string,
  source: WorkflowArtifactSource,
  classifyArtifact: ClassifyArtifact,
  processArtifact: (artifact: ResolvedReleaseFile) => Promise<TArtifact>,
): Promise<ResolvedReleaseBundle<TArtifact>> {
  const narrowed = Boolean(source.artifactName?.trim() || source.artifactNamePrefix?.trim());
  return processReleaseBundle(
    installationToken,
    source,
    classifyArtifact,
    narrowed
      ? {
          maxReleaseArtifacts: MAX_STREAMED_RELEASE_ARTIFACTS,
          maxTotalZipBytes: MAX_STREAMED_TOTAL_ARTIFACT_ZIP_BYTES,
        }
      : {
          maxReleaseArtifacts: MAX_RELEASE_ARTIFACTS,
          maxTotalZipBytes: MAX_TOTAL_ARTIFACT_ZIP_BYTES,
        },
    processArtifact,
  );
}

interface ReleaseBundleLimits {
  maxReleaseArtifacts: number;
  maxTotalZipBytes: number;
}

async function processReleaseBundle<TArtifact>(
  installationToken: string,
  source: WorkflowArtifactSource,
  classifyArtifact: ClassifyArtifact,
  limits: ReleaseBundleLimits,
  processArtifact: (artifact: ResolvedReleaseFile) => Promise<TArtifact>,
): Promise<ResolvedReleaseBundle<TArtifact>> {
  if (!REPOSITORY_FULL_NAME_RE.test(source.repositoryFullName)) {
    throw new WorkflowArtifactError(
      "bundle_unavailable",
      `repository full name ${source.repositoryFullName} is not owner/repo`,
    );
  }
  if (!Number.isInteger(source.runId) || source.runId <= 0) {
    throw new WorkflowArtifactError("bundle_unavailable", "runId must be a positive integer");
  }
  const artifactName = typeof source.artifactName === "string" ? source.artifactName.trim() : "";
  const artifactNamePrefix =
    typeof source.artifactNamePrefix === "string" ? source.artifactNamePrefix.trim() : "";
  const runArtifacts = await listRunArtifacts(
    installationToken,
    source.repositoryFullName,
    source.runId,
    artifactName || undefined,
    artifactNamePrefix || undefined,
  );

  // The release set is every entry the adapter classifies as an artifact.
  // Non-artifact files (checksums, READMEs, anything else upload-artifact
  // happened to include) are ignored — they are never scanned, so they cannot
  // influence the review.
  const candidateArtifacts: TArtifact[] = [];
  // Shard families let the same distribution filename arrive from more than one
  // upload (a matrix leg that runs a full `python -m build` ships the sdist
  // alongside its wheel). Identical bytes are the same already-reviewed
  // distribution, but the same path with different bytes is a genuine
  // ambiguity: the manifest and provenance record one path per distribution, so
  // fail closed rather than bind two digests to it.
  const releaseFileDigests = new Map<string, string>();
  let releaseArtifactCount = 0;
  let totalZipBytes = 0;
  for (const artifact of runArtifacts) {
    const zipBytes = await downloadArtifactZip(
      installationToken,
      source.repositoryFullName,
      artifact.id,
    );
    totalZipBytes += zipBytes.byteLength;
    if (totalZipBytes > limits.maxTotalZipBytes) {
      throw new WorkflowArtifactError(
        "bundle_too_large",
        `artifact downloads exceed ${limits.maxTotalZipBytes} bytes`,
      );
    }

    const entries = await extractOuterZipEntries(zipBytes);
    for (const entry of entries) {
      const classified = classifyArtifact(entry.path);
      if (!classified) continue;
      const sha256 = await sha256Hex(entry.bytes);
      const seenDigest = releaseFileDigests.get(entry.path);
      if (seenDigest !== undefined) {
        if (seenDigest !== sha256) {
          throw new WorkflowArtifactError(
            "artifact_identity_inconsistent",
            `${entry.path} appears in more than one artifact upload with different bytes`,
          );
        }
        continue;
      }
      releaseFileDigests.set(entry.path, sha256);
      releaseArtifactCount += 1;
      if (releaseArtifactCount > limits.maxReleaseArtifacts) {
        throw new WorkflowArtifactError(
          "bundle_too_large",
          `artifact bundle contains more than ${limits.maxReleaseArtifacts} release files`,
        );
      }
      candidateArtifacts.push(
        await processArtifact({
          path: entry.path,
          bytes: entry.bytes,
          sha256,
          ecosystem: classified.ecosystem,
          kind: classified.kind,
        }),
      );
    }
  }
  if (candidateArtifacts.length === 0) {
    throw new WorkflowArtifactError(
      "bundle_empty",
      "artifact bundle contained no reviewable artifacts",
    );
  }

  return {
    artifacts: candidateArtifacts,
    artifactId: runArtifacts[0]?.id ?? 0,
    artifactName: runArtifacts.length === 1 ? (runArtifacts[0]?.name ?? "") : "all",
    artifactSizeBytes: totalZipBytes,
  };
}

/**
 * Convenience wrapper that swaps the App JWT for an installation token before
 * calling `processReleaseBundleWithToken`. Production callers should use this so
 * the access token's lifetime is scoped to a single bundle resolution.
 */
export async function processReleaseBundleForGate<TArtifact>(
  config: GithubAppConfig,
  source: WorkflowArtifactSource,
  classifyArtifact: ClassifyArtifact,
  processArtifact: (artifact: ResolvedReleaseFile) => Promise<TArtifact>,
): Promise<ResolvedReleaseBundle<TArtifact>> {
  const token = await getInstallationAccessToken(config, source.installationExternalId);
  return processReleaseBundleWithToken(token, source, classifyArtifact, processArtifact);
}

// ── GitHub API: list + download ──────────────────────────────────────────────

interface RunArtifactRef {
  id: number;
  name: string;
  sizeInBytes: number | null;
  expired: boolean;
}

async function listRunArtifacts(
  token: string,
  repositoryFullName: string,
  runId: number,
  artifactName?: string,
  artifactNamePrefix?: string,
): Promise<RunArtifactRef[]> {
  const [owner, repo] = repositoryFullName.split("/");
  let url: string | null =
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}` +
    `/actions/runs/${runId}/artifacts?per_page=100`;
  const found: RunArtifactRef[] = [];
  for (let page = 0; page < MAX_LIST_PAGES && url; page += 1) {
    const response = await reliableFetch(url, { headers: githubInstallationHeaders(token) });
    if (response.status === 404) {
      throw new WorkflowArtifactError(
        "bundle_unavailable",
        `workflow run ${runId} not found in ${repositoryFullName}`,
      );
    }
    if (!response.ok) {
      throw new WorkflowArtifactError(
        "bundle_unavailable",
        `list artifacts failed (${response.status})`,
      );
    }
    const data = (await response.json()) as {
      artifacts?: Array<{
        id?: number;
        name?: string;
        size_in_bytes?: number;
        expired?: boolean;
      }>;
    };
    for (const candidate of data.artifacts ?? []) {
      if (
        typeof candidate.id === "number" &&
        candidate.id > 0 &&
        typeof candidate.name === "string" &&
        matchesArtifactName(candidate.name, artifactName, artifactNamePrefix) &&
        candidate.expired !== true
      ) {
        found.push({
          id: candidate.id,
          name: candidate.name,
          sizeInBytes: typeof candidate.size_in_bytes === "number" ? candidate.size_in_bytes : null,
          expired: false,
        });
        if (found.length > MAX_RUN_ARTIFACTS) {
          throw new WorkflowArtifactError(
            "bundle_too_large",
            `workflow run has more than ${MAX_RUN_ARTIFACTS} matching artifacts`,
          );
        }
      }
    }
    const next = nextLink(response.headers.get("link"));
    // Only follow pagination that stays on the credentialed GitHub API host so
    // a forged `Link` header cannot redirect the token-bearing listing call.
    url = next && evaluateGithubArtifactEgress(next).host === "api.github.com" ? next : null;
  }
  if (found.length > 0) {
    return found.sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);
  }
  const detail = artifactName
    ? `no non-expired artifact named ${artifactName} on run ${runId}`
    : artifactNamePrefix
      ? `no non-expired artifact in the ${artifactNamePrefix} shard family on run ${runId}`
      : `no non-expired artifacts on run ${runId}`;
  throw new WorkflowArtifactError("bundle_unavailable", detail);
}

function matchesArtifactName(
  candidate: string,
  artifactName?: string,
  artifactNamePrefix?: string,
): boolean {
  if (artifactName) return candidate === artifactName;
  if (!artifactNamePrefix) return true;
  return candidate === artifactNamePrefix || candidate.startsWith(`${artifactNamePrefix}-`);
}

async function downloadArtifactZip(
  token: string,
  repositoryFullName: string,
  artifactId: number,
): Promise<Uint8Array> {
  const [owner, repo] = repositoryFullName.split("/");
  let target =
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}` +
    `/actions/artifacts/${artifactId}/zip`;

  // GitHub answers `/zip` with a 302 to a signed URL on
  // `*.actions.githubusercontent.com`. We follow redirects by hand
  // (`redirect: "manual"`) so the installation token is attached only when the
  // egress policy says the host is credentialed (`api.github.com`) and is
  // dropped on the hop to the storage host. A redirect to any other host fails
  // closed before the request is issued, so the token cannot leak.
  let response: Response | null = null;
  for (let hop = 0; hop <= MAX_DOWNLOAD_REDIRECTS; hop += 1) {
    const policy = evaluateGithubArtifactEgress(target);
    if (!policy.allowed) {
      throw new WorkflowArtifactError(
        "bundle_unavailable",
        "artifact download target is not on the egress allowlist",
      );
    }
    const headers: Record<string, string> = { "User-Agent": "drydock-app" };
    if (policy.credentialed) {
      headers.Authorization = `Bearer ${token}`;
      headers.Accept = "application/vnd.github+json";
      headers["X-GitHub-Api-Version"] = "2022-11-28";
    }
    const hopResponse = await reliableFetch(target, {
      headers,
      redirect: "manual",
      timeoutMs: 60_000,
    });
    if (hopResponse.status < 300 || hopResponse.status >= 400) {
      response = hopResponse;
      break;
    }
    const location = hopResponse.headers.get("location");
    if (!location) {
      throw new WorkflowArtifactError(
        "bundle_unavailable",
        "artifact download redirect had no Location header",
      );
    }
    try {
      target = new URL(location, target).toString();
    } catch {
      throw new WorkflowArtifactError(
        "bundle_unavailable",
        "artifact download redirect Location is not a valid URL",
      );
    }
  }
  if (!response) {
    throw new WorkflowArtifactError(
      "bundle_unavailable",
      "artifact download exceeded the redirect limit",
    );
  }
  if (!response.ok) {
    throw new WorkflowArtifactError(
      "bundle_unavailable",
      `artifact download failed (${response.status})`,
    );
  }
  const declared = parseContentLength(response.headers.get("content-length"));
  if (declared !== null && declared > MAX_OUTER_ZIP_BYTES) {
    throw new WorkflowArtifactError(
      "bundle_too_large",
      `artifact content-length ${declared} exceeds ${MAX_OUTER_ZIP_BYTES} bytes`,
    );
  }
  try {
    return await readStreamBounded(response.body, MAX_OUTER_ZIP_BYTES);
  } catch (err) {
    if (err instanceof Error && err.message === "archive too large") {
      throw new WorkflowArtifactError(
        "bundle_too_large",
        `artifact body exceeds ${MAX_OUTER_ZIP_BYTES} bytes`,
      );
    }
    throw err;
  }
}

// ── Shared helpers ───────────────────────────────────────────────────────────

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function parseContentLength(value: string | null): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}
