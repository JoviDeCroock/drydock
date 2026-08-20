import { parseAtpmPackageName, type AtpmPackageRef } from "./identity";
import { isValidAtpmStageRkey } from "./stage-record";

/**
 * How a staged atpm candidate is named inside Drydock.
 *
 * A staged candidate is `at://<did>/dev.atpm.alpha.stage/<rkey>`, and atpm's own
 * identifier for it — the uuid `npm stage approve` takes — is derived from that
 * URI plus the record's CID. The uuid is not usable as an address: resolving it
 * means listing the repository and hashing every entry, so it cannot be the
 * thing a scan is created from.
 *
 * `atpm:<did>:<rkey>` is the mutable address a maintainer may enter manually.
 * Discovery and workflow gates append atpm's approval UUID as
 * `atpm:<did>:<rkey>:<approveId>` so a record rewritten under the same key is a
 * new review identity. Every part fits the shared `stageId` grammar, and a TID
 * cannot be mistaken for the UUID suffix.
 */
const ATPM_STAGE_PREFIX = "atpm:";

export interface AtpmStageRef {
  did: string;
  rkey: string;
  /** Approval UUID that binds a discovered/gated scan to one record CID. */
  approveId: string | null;
  /** Canonical mutable or approval-bound spelling. */
  stageId: string;
}

const ATPM_APPROVE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isAtpmStageId(value: string): boolean {
  return value.startsWith(ATPM_STAGE_PREFIX);
}

export function formatAtpmStageId(did: string, rkey: string, approveId?: string): string {
  return `${ATPM_STAGE_PREFIX}${did}:${rkey}${approveId ? `:${approveId.toLowerCase()}` : ""}`;
}

/**
 * Parse a staged reference, or null. The DID is validated through the same
 * parser the public surface uses, so a scan cannot address a DID method with no
 * resolution path or a host this deployment will not talk to.
 */
export function parseAtpmStageId(value: string): AtpmStageRef | null {
  if (!isAtpmStageId(value)) return null;
  let body = value.slice(ATPM_STAGE_PREFIX.length);
  let separator = body.lastIndexOf(":");
  if (separator <= 0) return null;

  const tail = body.slice(separator + 1);
  const approveId = ATPM_APPROVE_ID_RE.test(tail) ? tail.toLowerCase() : null;
  if (approveId) {
    body = body.slice(0, separator);
    separator = body.lastIndexOf(":");
    if (separator <= 0) return null;
  }

  const rkey = body.slice(separator + 1);
  if (!isValidAtpmStageRkey(rkey)) return null;

  // `parseAtpmPackageName` is the one place DID syntax and host policy are
  // decided; borrow it with a placeholder record key rather than restating it.
  const did = parseAtpmPackageName(`${body.slice(0, separator)}/x`)?.authority;
  if (did?.kind !== "did") return null;
  return {
    did: did.did,
    rkey,
    approveId,
    stageId: formatAtpmStageId(did.did, rkey, approveId ?? undefined),
  };
}

/**
 * Parse a publishing account as a release target spells it — `@handle` or a
 * DID — into the reference the identity resolver takes.
 *
 * The resolver is package-shaped because every other caller has a package in
 * hand; a publisher does not, so a placeholder record key stands in. Doing it
 * here rather than at each call site keeps DID syntax and host policy decided
 * in exactly one place.
 */
export function parseAtpmPublisherRef(publisherRef: string): AtpmPackageRef | null {
  const trimmed = publisherRef.trim();
  if (!trimmed) return null;
  return parseAtpmPackageName(`${trimmed}/x`);
}

/**
 * How a staged candidate is named in a *public* URL.
 *
 * The authenticated form above addresses a candidate for a scan: it carries the
 * publisher DID because a scan has nothing else to resolve from. A public review
 * URL already names the publisher in the package portion — `/diff/atpm/<did>/
 * <name>/…` — so the version slot only has to identify which staged record, and
 * which revision of it.
 *
 * That makes a staged candidate just another thing a version pair can point at,
 * which is the whole trick: the anonymous review reuses `/diff` end to end —
 * caching, redaction, risk, per-file fetches, share cards — instead of being a
 * second review surface that would drift from the first.
 *
 * The record CID is in the token because a staged record is mutable. Without it
 * a rewritten candidate would be served from the cache entry of the bytes it
 * replaced, which on a page whose entire claim is "these are the bytes" would be
 * the worst possible kind of stale.
 *
 * The spelling stays inside the shared version grammar (leading alphanumeric,
 * then alphanumerics/`.`/`_`/`+`/`-`) so nothing downstream needs widening.
 */
const ATPM_STAGED_VERSION_PREFIX = "staged.";

/**
 * Stands in for "there is no published release to compare against" in the
 * `from` slot of a first release.
 *
 * A reserved version string rather than an optional path segment: every public
 * diff URL, cache key, and share card is built from a version *pair*, and making
 * one half optional would ripple through all of them to express something that
 * happens once per package. A published version would have to be named exactly
 * this to collide, and the sentinel is checked before the record is consulted.
 */
export const ATPM_NO_BASELINE_VERSION = "staged.none";

export interface AtpmStagedVersionRef {
  rkey: string;
  recordCid: string;
}

export function formatAtpmStagedVersion(rkey: string, recordCid: string): string {
  return `${ATPM_STAGED_VERSION_PREFIX}${rkey}.${recordCid}`;
}

export function isAtpmStagedVersion(value: string): boolean {
  return value.startsWith(ATPM_STAGED_VERSION_PREFIX) && value !== ATPM_NO_BASELINE_VERSION;
}

/** Parse a staged version token, or null when it is not one. */
export function parseAtpmStagedVersion(value: string): AtpmStagedVersionRef | null {
  if (!isAtpmStagedVersion(value)) return null;
  const body = value.slice(ATPM_STAGED_VERSION_PREFIX.length);
  const separator = body.indexOf(".");
  if (separator <= 0) return null;
  const rkey = body.slice(0, separator);
  const recordCid = body.slice(separator + 1);
  // The CID is compared against the record the PDS returns, so this only has to
  // reject shapes that could not be one — the authoritative check is the match.
  if (!isValidAtpmStageRkey(rkey) || !/^[a-z0-9]{16,128}$/.test(recordCid)) return null;
  return { rkey, recordCid };
}
