import {
  findZipEndOfCentralDirectory,
  inflateRawBounded,
  normalizeZipPath,
  readStreamBounded,
  readUint16Le,
  readUint32Le,
} from "./tar-parser.js";
import { getInstallationAccessToken, type GithubAppConfig } from "./github-app";
import { inferPyPiArtifactKind, type PyPiArtifactKind } from "./adapters/pypi/index";

// ── Public surface ───────────────────────────────────────────────────────────

export interface WorkflowArtifactSource {
  installationExternalId: string;
  repositoryFullName: string;
  runId: number;
  artifactName?: string;
}

export interface ResolvedReleaseFile {
  path: string;
  bytes: Uint8Array;
  sha256: string;
  kind: PyPiArtifactKind;
}

export interface ResolvedReleaseBundle {
  artifacts: ResolvedReleaseFile[];
  artifactId: number;
  artifactName: string;
  artifactSizeBytes: number;
}

export type WorkflowArtifactErrorCode =
  | "bundle_unavailable"
  | "bundle_too_large"
  | "bundle_empty"
  | "release_target_mismatch"
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

const DEFAULT_ARTIFACT_NAME = "pypi-release-candidate";

const MAX_OUTER_ZIP_BYTES = 25 * 1024 * 1024;
const MAX_OUTER_ZIP_ENTRIES = 256;
const MAX_PER_ENTRY_BYTES = 25 * 1024 * 1024;
const MAX_RELEASE_ARTIFACTS = 20;
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
 * There is no `drydock-manifest.json` contract: the release set is whatever
 * wheel/sdist files the bundle contains. Identity (`package`/`version`) is
 * derived from the artifacts themselves downstream
 * (`server/lib/release-candidate-pypi.ts`) once the bytes have been parsed in
 * the sandbox. This stage only collects the artifact bytes and recomputes their
 * SHA-256; non-artifact files in the bundle are ignored.
 */
export async function fetchReleaseBundleWithToken(
  installationToken: string,
  source: WorkflowArtifactSource,
): Promise<ResolvedReleaseBundle> {
  if (!REPOSITORY_FULL_NAME_RE.test(source.repositoryFullName)) {
    throw new WorkflowArtifactError(
      "bundle_unavailable",
      `repository full name ${source.repositoryFullName} is not owner/repo`,
    );
  }
  if (!Number.isInteger(source.runId) || source.runId <= 0) {
    throw new WorkflowArtifactError("bundle_unavailable", "runId must be a positive integer");
  }
  const artifactName =
    (source.artifactName ?? DEFAULT_ARTIFACT_NAME).trim() || DEFAULT_ARTIFACT_NAME;

  const artifact = await findRunArtifact(
    installationToken,
    source.repositoryFullName,
    source.runId,
    artifactName,
  );
  const zipBytes = await downloadArtifactZip(
    installationToken,
    source.repositoryFullName,
    artifact.id,
  );

  const entries = await extractOuterZipEntries(zipBytes);

  // The release set is every wheel/sdist in the bundle. Non-artifact files
  // (checksums, READMEs, anything else upload-artifact happened to include) are
  // ignored — they are never scanned, so they cannot influence the review.
  const candidateArtifacts: ResolvedReleaseFile[] = [];
  for (const entry of entries) {
    const kind = inferPyPiArtifactKind(entry.path);
    if (!kind) continue;
    const sha256 = await sha256Hex(entry.bytes);
    candidateArtifacts.push({ path: entry.path, bytes: entry.bytes, sha256, kind });
  }
  if (candidateArtifacts.length === 0) {
    throw new WorkflowArtifactError(
      "bundle_empty",
      "artifact bundle contained no wheel or sdist files",
    );
  }
  if (candidateArtifacts.length > MAX_RELEASE_ARTIFACTS) {
    throw new WorkflowArtifactError(
      "bundle_too_large",
      `artifact bundle contains more than ${MAX_RELEASE_ARTIFACTS} wheel/sdist files`,
    );
  }

  return {
    artifacts: candidateArtifacts,
    artifactId: artifact.id,
    artifactName: artifact.name,
    artifactSizeBytes: zipBytes.byteLength,
  };
}

/**
 * Convenience wrapper that swaps the App JWT for an installation token before
 * calling `fetchReleaseBundleWithToken`. Production callers should use this so
 * the access token's lifetime is scoped to a single bundle resolution.
 */
export async function fetchReleaseBundleForGate(
  config: GithubAppConfig,
  source: WorkflowArtifactSource,
): Promise<ResolvedReleaseBundle> {
  const token = await getInstallationAccessToken(config, source.installationExternalId);
  return fetchReleaseBundleWithToken(token, source);
}

// ── GitHub API: list + download ──────────────────────────────────────────────

interface RunArtifactRef {
  id: number;
  name: string;
  sizeInBytes: number | null;
  expired: boolean;
}

async function findRunArtifact(
  token: string,
  repositoryFullName: string,
  runId: number,
  artifactName: string,
): Promise<RunArtifactRef> {
  const [owner, repo] = repositoryFullName.split("/");
  let url: string | null =
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}` +
    `/actions/runs/${runId}/artifacts?per_page=100`;
  for (let page = 0; page < MAX_LIST_PAGES && url; page += 1) {
    const response = await fetch(url, { headers: githubInstallationHeaders(token) });
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
        candidate.name === artifactName &&
        candidate.expired !== true
      ) {
        return {
          id: candidate.id,
          name: candidate.name,
          sizeInBytes: typeof candidate.size_in_bytes === "number" ? candidate.size_in_bytes : null,
          expired: false,
        };
      }
    }
    const next = nextLink(response.headers.get("link"));
    // Only follow pagination that stays on the credentialed GitHub API host so
    // a forged `Link` header cannot redirect the token-bearing listing call.
    url = next && evaluateGithubArtifactEgress(next).host === "api.github.com" ? next : null;
  }
  throw new WorkflowArtifactError(
    "bundle_unavailable",
    `no non-expired artifact named ${artifactName} on run ${runId}`,
  );
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
    const hopResponse = await fetch(target, { headers, redirect: "manual" });
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

// ── Outer ZIP extraction ─────────────────────────────────────────────────────

interface ExtractedEntry {
  path: string;
  bytes: Uint8Array;
}

async function extractOuterZipEntries(zip: Uint8Array): Promise<ExtractedEntry[]> {
  const eocd = findZipEndOfCentralDirectory(zip);
  if (eocd < 0) {
    throw new WorkflowArtifactError(
      "bundle_unavailable",
      "artifact zip central directory not found",
    );
  }
  const entryCount = readUint16Le(zip, eocd + 10);
  const centralDirectorySize = readUint32Le(zip, eocd + 12);
  const centralDirectoryOffset = readUint32Le(zip, eocd + 16);
  if (
    entryCount === 0xffff ||
    centralDirectorySize === 0xffffffff ||
    centralDirectoryOffset === 0xffffffff
  ) {
    throw new WorkflowArtifactError("bundle_unavailable", "zip64 archives are not supported");
  }
  if (entryCount > MAX_OUTER_ZIP_ENTRIES) {
    throw new WorkflowArtifactError("bundle_too_large", "artifact zip contains too many entries");
  }
  if (centralDirectoryOffset + centralDirectorySize > zip.byteLength) {
    throw new WorkflowArtifactError("bundle_unavailable", "truncated zip central directory");
  }

  const entries: ExtractedEntry[] = [];
  let totalExpanded = 0;
  let offset = centralDirectoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > zip.byteLength || readUint32Le(zip, offset) !== 0x02014b50) {
      throw new WorkflowArtifactError("bundle_unavailable", "invalid zip central directory entry");
    }
    const compressionMethod = readUint16Le(zip, offset + 10);
    const compressedSize = readUint32Le(zip, offset + 20);
    const uncompressedSize = readUint32Le(zip, offset + 24);
    const fileNameLength = readUint16Le(zip, offset + 28);
    const extraLength = readUint16Le(zip, offset + 30);
    const commentLength = readUint16Le(zip, offset + 32);
    const localHeaderOffset = readUint32Le(zip, offset + 42);
    const fileNameStart = offset + 46;
    const fileNameEnd = fileNameStart + fileNameLength;
    if (fileNameEnd > zip.byteLength) {
      throw new WorkflowArtifactError("bundle_unavailable", "truncated zip filename");
    }
    const rawPath = new TextDecoder("utf-8", { fatal: false }).decode(
      zip.subarray(fileNameStart, fileNameEnd),
    );
    offset = fileNameEnd + extraLength + commentLength;

    // Directory entries / paths that fail normalization → reject hard. Path
    // traversal in artifact entries is `artifact_path_unsafe`. Directory
    // markers (trailing slash) are silently skipped because GitHub's
    // upload-artifact action always packs files only — this matches the
    // existing readZipArchive semantics.
    if (!rawPath || rawPath.endsWith("/")) continue;
    if (containsPathTraversal(rawPath)) {
      throw new WorkflowArtifactError(
        "artifact_path_unsafe",
        `zip entry ${rawPath} has an unsafe path`,
      );
    }
    const path = normalizeZipPath(rawPath);
    if (!path) {
      throw new WorkflowArtifactError(
        "artifact_path_unsafe",
        `zip entry ${rawPath} has an unsafe path`,
      );
    }
    if (uncompressedSize > MAX_PER_ENTRY_BYTES) {
      throw new WorkflowArtifactError("bundle_too_large", `zip entry ${path} is too large`);
    }
    if (totalExpanded + uncompressedSize > MAX_OUTER_ZIP_BYTES) {
      throw new WorkflowArtifactError("bundle_too_large", "zip expands beyond safety limit");
    }
    if (
      localHeaderOffset + 30 > zip.byteLength ||
      readUint32Le(zip, localHeaderOffset) !== 0x04034b50
    ) {
      throw new WorkflowArtifactError("bundle_unavailable", "invalid zip local header");
    }
    const localFileNameLength = readUint16Le(zip, localHeaderOffset + 26);
    const localExtraLength = readUint16Le(zip, localHeaderOffset + 28);
    const dataOffset = localHeaderOffset + 30 + localFileNameLength + localExtraLength;
    if (dataOffset + compressedSize > zip.byteLength) {
      throw new WorkflowArtifactError("bundle_unavailable", "truncated zip entry");
    }
    let body: Uint8Array;
    if (compressionMethod === 0) {
      body = zip.subarray(dataOffset, dataOffset + compressedSize).slice();
    } else if (compressionMethod === 8) {
      body = await inflateRawBounded(
        zip.subarray(dataOffset, dataOffset + compressedSize),
        MAX_OUTER_ZIP_BYTES,
      );
    } else {
      throw new WorkflowArtifactError(
        "bundle_unavailable",
        `unsupported zip compression method ${compressionMethod}`,
      );
    }
    if (body.byteLength !== uncompressedSize) {
      throw new WorkflowArtifactError("bundle_unavailable", "zip entry size mismatch");
    }
    totalExpanded += body.byteLength;
    entries.push({ path, bytes: body });
  }
  return entries;
}

function containsPathTraversal(rawPath: string): boolean {
  if (rawPath.includes("\0") || rawPath.includes("\\")) return true;
  if (rawPath.startsWith("/")) return true;
  if (rawPath.startsWith("../") || rawPath.includes("/../") || rawPath.endsWith("/..")) return true;
  if (/^[A-Za-z]:/.test(rawPath)) return true;
  return false;
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

function githubInstallationHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "drydock-app",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function nextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/);
    if (match?.[1]) return match[1];
  }
  return null;
}
