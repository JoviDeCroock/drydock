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
