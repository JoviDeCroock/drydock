/**
 * GitHub artifact-attestation lookup.
 *
 * `actions/attest-build-provenance` stores a Sigstore bundle per attested file,
 * addressed by the file's SHA-256. Drydock already recomputes that digest from
 * the immutable Actions artifact it reviewed, so it can ask the repository's
 * attestation store the exact question that matters: *is there a build
 * attestation for these bytes?*
 *
 * Ecosystem-neutral by construction — the endpoint attests files, not packages,
 * so npm tarballs, wheels, sdists, and VSIXes all resolve through this one path
 * with no per-ecosystem branching.
 *
 * The installation token stays in the control plane: this module is called from
 * the workflow-gate job, and only the parsed bundles (no credentials, no
 * headers) are handed onward to the pure verdict layer.
 */

import { reliableFetch } from "../platform/reliable-fetch";
import { describeOperationalError } from "../platform/observability";
import { uncompress } from "snappyjs";
import { getInstallationAccessToken } from "./api";
import type { GithubAppConfig } from "./config";
import { githubInstallationHeaders } from "./http";
import { parseRepositoryFullName } from "./validation";

// One release candidate is a handful of files, each with at most a couple of
// attestations. These caps bound both the number of requests a gate can make
// and the bytes any one response can contribute.
const MAX_DIGEST_LOOKUPS = 8;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_BUNDLES_PER_DIGEST = 8;
const DIGEST_LOOKUP_CONCURRENCY = 2;
const ADVISORY_TIMEOUT_MS = 5_000;

const SHA256_HEX = /^[0-9a-f]{64}$/;

export interface AttestationFetchResult {
  /** Sigstore bundles, untyped — the pure layer parses and bounds them. */
  bundles: unknown[];
  /** Set when the lookup could not complete; bundles is then empty. */
  failureReason: string | null;
}

/**
 * Fetch a bounded set of build attestations covering the given artifact digests.
 *
 * A 404 means the repository has no attestation for that digest, which is a
 * normal, quiet outcome (`bundles: []`, no failure) — most releases publish no
 * provenance. Only a transport or authorization failure sets `failureReason`,
 * because "we could not look" and "there is nothing there" must not collapse
 * into the same verdict.
 */
export async function fetchBuildAttestations(
  config: GithubAppConfig,
  args: {
    installationExternalId: string;
    repositoryFullName: string;
    artifactDigests: string[];
  },
): Promise<AttestationFetchResult> {
  const digests = [
    ...new Set(
      args.artifactDigests
        .map((digest) => digest.trim().toLowerCase())
        .filter((digest) => SHA256_HEX.test(digest)),
    ),
  ].slice(0, MAX_DIGEST_LOOKUPS);
  if (!digests.length) return { bundles: [], failureReason: null };

  // Shared validator rather than a local split: it already refuses `.`/`..`
  // segments, which would otherwise traverse out of the /repos/ path.
  const repository = parseRepositoryFullName(args.repositoryFullName);
  if (!repository) return { bundles: [], failureReason: "repository is not in owner/repo form" };

  let token: string;
  try {
    token = await getInstallationAccessToken(config, args.installationExternalId, {
      attempts: 1,
      timeoutMs: ADVISORY_TIMEOUT_MS,
    });
  } catch (err) {
    return { bundles: [], failureReason: describeFailure(err) };
  }

  // At most two requests per candidate. Gate packages are already reviewed
  // with concurrency three, so this keeps the whole job within six simultaneous
  // GitHub connections while avoiding one timeout per digest in series.
  const outcomes = await mapWithConcurrency(digests, DIGEST_LOOKUP_CONCURRENCY, (digest) =>
    fetchDigestAttestations(token, repository, digest),
  );
  const failed = outcomes.find((outcome) => outcome.failureReason);
  if (failed?.failureReason) return { bundles: [], failureReason: failed.failureReason };
  return { bundles: outcomes.flatMap((outcome) => outcome.bundles), failureReason: null };
}

async function fetchDigestAttestations(
  token: string,
  repository: { owner: string; name: string },
  digest: string,
): Promise<AttestationFetchResult> {
  const url = new URL(
    `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/` +
      `${encodeURIComponent(repository.name)}/attestations/sha256:${digest}`,
  );
  // This endpoint also returns SBOM, release and custom predicates. Filter at
  // the source so those records cannot consume the bounded result allowance
  // before the build-provenance statement we are looking for.
  url.searchParams.set("predicate_type", "provenance");
  url.searchParams.set("per_page", String(MAX_BUNDLES_PER_DIGEST));

  let response: Response;
  try {
    response = await reliableFetch(url, {
      headers: githubInstallationHeaders(token),
      // A credentialed request must not chase a redirect off api.github.com.
      redirect: "manual",
      attempts: 1,
      timeoutMs: ADVISORY_TIMEOUT_MS,
    });
  } catch (err) {
    return { bundles: [], failureReason: describeFailure(err) };
  }

  // No attestation for these bytes. Not a failure — the common case.
  if (response.status === 404) return { bundles: [], failureReason: null };
  if (response.status >= 300 && response.status < 400) {
    return { bundles: [], failureReason: `attestation lookup redirected (${response.status})` };
  }
  if (!response.ok) {
    return { bundles: [], failureReason: `attestation lookup failed (${response.status})` };
  }

  const decoded = await readJsonResponse(response, MAX_RESPONSE_BYTES, "attestation response");
  if (!decoded.ok) return { bundles: [], failureReason: decoded.reason };
  const body = decoded.value;
  if (!isRecord(body) || !Array.isArray(body.attestations)) {
    return { bundles: [], failureReason: "attestation response had an unexpected shape" };
  }

  const bundles: unknown[] = [];
  for (const entry of body.attestations.slice(0, MAX_BUNDLES_PER_DIGEST)) {
    if (!isRecord(entry)) continue;
    if (isRecord(entry.bundle)) {
      bundles.push(entry.bundle);
      continue;
    }
    // GitHub may return historical/migrated records with a null embedded bundle
    // and a short-lived URL to a Snappy-compressed bundle. The URL is fetched
    // without the installation token and under the same advisory deadline.
    if (typeof entry.bundle_url === "string") {
      const fetched = await fetchUrlBackedBundle(entry.bundle_url);
      if (!fetched.ok) return { bundles: [], failureReason: fetched.reason };
      bundles.push(fetched.bundle);
      continue;
    }
    return { bundles: [], failureReason: "attestation record contained no readable bundle" };
  }
  return { bundles, failureReason: null };
}

async function fetchUrlBackedBundle(
  rawUrl: string,
): Promise<{ ok: true; bundle: unknown } | { ok: false; reason: string }> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "attestation bundle URL was invalid" };
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    return { ok: false, reason: "attestation bundle URL was not safe" };
  }

  let response: Response;
  try {
    response = await reliableFetch(url, {
      redirect: "manual",
      attempts: 1,
      timeoutMs: ADVISORY_TIMEOUT_MS,
      headers: { Accept: "application/json, application/x-snappy", "User-Agent": "drydock-app" },
    });
  } catch (err) {
    return { ok: false, reason: describeFailure(err) };
  }
  if (response.status >= 300 && response.status < 400) {
    return { ok: false, reason: `attestation bundle redirected (${response.status})` };
  }
  if (!response.ok) {
    return { ok: false, reason: `attestation bundle lookup failed (${response.status})` };
  }

  const read = await readResponseBytes(response, MAX_RESPONSE_BYTES, "attestation bundle");
  if (!read.ok) return read;

  let bytes = read.bytes;
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType === "application/x-snappy" || url.pathname.endsWith(".sn")) {
    try {
      bytes = uncompress(bytes, MAX_RESPONSE_BYTES);
    } catch {
      return { ok: false, reason: "attestation bundle was not valid bounded Snappy data" };
    }
  }

  const parsed = parseJsonBytes(bytes);
  return parsed.ok
    ? { ok: true, bundle: parsed.value }
    : { ok: false, reason: "attestation bundle was not JSON" };
}

async function readJsonResponse(
  response: Response,
  maxBytes: number,
  label: string,
): Promise<{ ok: true; value: unknown } | { ok: false; reason: string }> {
  const read = await readResponseBytes(response, maxBytes, label);
  if (!read.ok) return read;
  const parsed = parseJsonBytes(read.bytes);
  return parsed.ok ? parsed : { ok: false, reason: `${label} was not JSON` };
}

async function readResponseBytes(
  response: Response,
  maxBytes: number,
  label: string,
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; reason: string }> {
  const declared = parseContentLength(response.headers.get("content-length"));
  if (declared !== null && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    return { ok: false, reason: `${label} exceeded the size cap` };
  }
  if (!response.body) return { ok: false, reason: `${label} was unreadable` };

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: `${label} exceeded the size cap` };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: `${label} was unreadable` };
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}

function parseJsonBytes(
  bytes: Uint8Array,
): { ok: true; value: unknown } | { ok: false; reason: string } {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, reason: "invalid JSON" };
  }
}

function parseContentLength(value: string | null): number | null {
  if (!value || !/^\d+$/.test(value.trim())) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

async function mapWithConcurrency<T, U>(
  values: readonly T[],
  concurrency: number,
  fn: (value: T) => Promise<U>,
): Promise<U[]> {
  const results: U[] = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(values[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Collapse an error into a single short, redacted string. The reason is
 * persisted with the verdict and rendered to maintainers, so it goes through
 * the shared redaction path rather than stringifying the error directly.
 */
function describeFailure(err: unknown): string {
  const summary = describeOperationalError(err);
  const message = summary.message ? `: ${summary.message}` : "";
  return `${summary.name}${message}`.slice(0, 200);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
