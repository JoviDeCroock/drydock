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

const SHA256_HEX = /^[0-9a-f]{64}$/;

export interface AttestationFetchResult {
  /** Sigstore bundles, untyped — the pure layer parses and bounds them. */
  bundles: unknown[];
  /** Set when the lookup could not complete; bundles is then empty. */
  failureReason: string | null;
}

/**
 * Fetch every build attestation covering the given artifact digests.
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
    token = await getInstallationAccessToken(config, args.installationExternalId);
  } catch (err) {
    return { bundles: [], failureReason: describeFailure(err) };
  }

  const bundles: unknown[] = [];
  for (const digest of digests) {
    const outcome = await fetchDigestAttestations(token, repository, digest);
    if (outcome.failureReason) return { bundles: [], failureReason: outcome.failureReason };
    bundles.push(...outcome.bundles);
  }
  return { bundles, failureReason: null };
}

async function fetchDigestAttestations(
  token: string,
  repository: { owner: string; name: string },
  digest: string,
): Promise<AttestationFetchResult> {
  const url =
    `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/` +
    `${encodeURIComponent(repository.name)}/attestations/sha256:${digest}`;

  let response: Response;
  try {
    response = await reliableFetch(url, {
      headers: githubInstallationHeaders(token),
      // A credentialed request must not chase a redirect off api.github.com.
      redirect: "manual",
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

  const text = await response.text().catch(() => null);
  if (text === null) return { bundles: [], failureReason: "attestation response unreadable" };
  if (text.length > MAX_RESPONSE_BYTES) {
    return { bundles: [], failureReason: "attestation response exceeded the size cap" };
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { bundles: [], failureReason: "attestation response was not JSON" };
  }
  if (!isRecord(body) || !Array.isArray(body.attestations)) {
    return { bundles: [], failureReason: null };
  }

  const bundles: unknown[] = [];
  for (const entry of body.attestations.slice(0, MAX_BUNDLES_PER_DIGEST)) {
    if (isRecord(entry) && entry.bundle !== undefined) bundles.push(entry.bundle);
  }
  return { bundles, failureReason: null };
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
