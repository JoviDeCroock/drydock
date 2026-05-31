import { readStreamBounded } from "../tar-parser.js";
import { inferPyPiArtifactKind, type PyPiArtifactKind } from "../adapters/pypi/index";
import { getInstallationAccessToken } from "./api";
import { GithubAppValidationError, type GithubAppConfig } from "./config";
import { githubInstallationHeaders, nextLink } from "./http";
import { extractOuterZipEntries } from "./artifacts-zip";

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

export const MAX_OUTER_ZIP_BYTES = 25 * 1024 * 1024;
export const MAX_OUTER_ZIP_ENTRIES = 256;
export const MAX_PER_ENTRY_BYTES = 25 * 1024 * 1024;
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
    if (response.status === 401 || response.status === 403 || response.status === 404) {
      throw new GithubAppValidationError(
        "repository_not_accessible",
        `GitHub App installation can no longer list artifacts for ${repositoryFullName} (${response.status})`,
        response.status,
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
      if (policy.credentialed && (response.status === 401 || response.status === 403)) {
        throw new GithubAppValidationError(
          "repository_not_accessible",
          `GitHub App installation can no longer download artifacts for ${repositoryFullName} (${response.status})`,
          response.status,
        );
      }
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
