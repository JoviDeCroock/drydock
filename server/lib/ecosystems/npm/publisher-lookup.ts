import { normalizeRegistryUrl, type NormalizeRegistryUrlOptions } from "./connection";
import { reliableFetch } from "../../platform/reliable-fetch";
import { readBoundedJson } from "../../platform/bounded-json";
import {
  parseNpmBuildIdentity,
  parseNpmTrustConfigs,
  type NpmBuildIdentity,
  type NpmTrustConfig,
  type NpmTrustConfigsState,
} from "./publisher-identity";

/**
 * Worker-side control-plane lookups for a staged release's publisher
 * identity. Same posture as `version-status.ts`: the org token is attached
 * only here, only to the registry the connection names, and every failure
 * collapses to "unknown" — a config list we could not read is never a
 * finding about the release.
 */

const PUBLIC_NPM_REGISTRY = "https://registry.npmjs.org";
const LOOKUP_TIMEOUT_MS = 5_000;
// Ten configs of a few hundred bytes each; an attestation body carries
// base64 DSSE payloads and Sigstore material, so it gets more room.
const MAX_TRUST_RESPONSE_BYTES = 64 * 1024;
const MAX_ATTESTATIONS_RESPONSE_BYTES = 512 * 1024;

const PACKAGE_NAME_RE = /^(?:@[A-Za-z0-9][A-Za-z0-9._~-]*\/)?[A-Za-z0-9][A-Za-z0-9._~-]*$/;
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;

export interface NpmPublisherLookupOptions extends NormalizeRegistryUrlOptions {
  timeoutMs?: number;
}

export type NpmTrustConfigsLookup =
  | { state: "checked"; configs: NpmTrustConfig[] }
  | { state: Exclude<NpmTrustConfigsState, "checked">; httpStatus: number | null };

/**
 * `GET /-/package/{escapedName}/trust` — what `npm trust list` calls. Needs
 * the org token; npm answers 404 both for a package the token cannot see and
 * for one that does not exist, so a non-2xx from the public registry is
 * `unavailable`. A custom registry answering 404/405/501 has no such
 * endpoint and is reported as `unsupported` so the UI can say why.
 */
export async function fetchNpmTrustConfigs(
  registryUrl: string,
  token: string,
  packageName: string | null | undefined,
  options: NpmPublisherLookupOptions = {},
): Promise<NpmTrustConfigsLookup> {
  if (!packageName || packageName.length > 214 || !PACKAGE_NAME_RE.test(packageName)) {
    return { state: "unavailable", httpStatus: null };
  }
  let registry: string;
  try {
    registry = normalizeRegistryUrl(registryUrl, options);
  } catch {
    return { state: "unavailable", httpStatus: null };
  }
  const url = `${registry}/-/package/${encodeURIComponent(packageName)}/trust`;
  const timeoutMs = options.timeoutMs ?? LOOKUP_TIMEOUT_MS;
  const deadlineMs = Date.now() + timeoutMs;
  let response: Response;
  try {
    response = await reliableFetch(url, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
        "user-agent": "staged-publish-review/trust-configs",
      },
      timeoutMs,
      attempts: 1,
    });
  } catch {
    return { state: "unavailable", httpStatus: null };
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    const unsupported =
      registry !== PUBLIC_NPM_REGISTRY &&
      (response.status === 404 || response.status === 405 || response.status === 501);
    return { state: unsupported ? "unsupported" : "unavailable", httpStatus: response.status };
  }
  const configs = parseNpmTrustConfigs(
    await readBoundedJson(response, MAX_TRUST_RESPONSE_BYTES, deadlineMs),
  );
  if (!configs) return { state: "unavailable", httpStatus: response.status };
  return { state: "checked", configs };
}

/**
 * `GET /-/npm/v1/attestations/{name}@{version}` — public, so no token is
 * attached. Returns the SLSA build identity npm recorded for that version or
 * null; a staged version is expected to 404 until it is published.
 */
export async function fetchNpmBuildIdentity(
  registryUrl: string,
  packageName: string | null | undefined,
  version: string | null | undefined,
  options: NpmPublisherLookupOptions = {},
): Promise<NpmBuildIdentity | null> {
  if (!packageName || !version) return null;
  if (packageName.length > 214 || !PACKAGE_NAME_RE.test(packageName) || !VERSION_RE.test(version)) {
    return null;
  }
  let registry: string;
  try {
    registry = normalizeRegistryUrl(registryUrl, options);
  } catch {
    return null;
  }
  // npm accepts the escaped scoped name here as well as the bare one; the
  // escaped form keeps every npm control-plane route on one convention.
  const url = `${registry}/-/npm/v1/attestations/${encodeURIComponent(packageName)}@${encodeURIComponent(version)}`;
  const timeoutMs = options.timeoutMs ?? LOOKUP_TIMEOUT_MS;
  const deadlineMs = Date.now() + timeoutMs;
  let response: Response;
  try {
    response = await reliableFetch(url, {
      headers: {
        accept: "application/json",
        "user-agent": "staged-publish-review/build-identity",
      },
      timeoutMs,
      attempts: 1,
    });
  } catch {
    return null;
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  return parseNpmBuildIdentity(
    await readBoundedJson(response, MAX_ATTESTATIONS_RESPONSE_BYTES, deadlineMs),
  );
}
