import { parseAtpmPackageName } from "./identity";
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
 * `atpm:<did>:<rkey>` is that address, flattened to fit the shared `stageId`
 * column and its grammar (alphanumerics, `.`, `_`, `:`, `-`). Both halves are
 * already restricted to that alphabet, so the spelling is reversible: a DID
 * cannot contain the record key's grammar and a TID cannot contain a colon.
 */
const ATPM_STAGE_PREFIX = "atpm:";

export interface AtpmStageRef {
  did: string;
  rkey: string;
  /** Canonical `atpm:<did>:<rkey>` spelling. */
  stageId: string;
}

export function isAtpmStageId(value: string): boolean {
  return value.startsWith(ATPM_STAGE_PREFIX);
}

export function formatAtpmStageId(did: string, rkey: string): string {
  return `${ATPM_STAGE_PREFIX}${did}:${rkey}`;
}

/**
 * Parse a staged reference, or null. The DID is validated through the same
 * parser the public surface uses, so a scan cannot address a DID method with no
 * resolution path or a host this deployment will not talk to.
 */
export function parseAtpmStageId(value: string): AtpmStageRef | null {
  if (!isAtpmStageId(value)) return null;
  const body = value.slice(ATPM_STAGE_PREFIX.length);
  const separator = body.lastIndexOf(":");
  if (separator <= 0) return null;

  const rkey = body.slice(separator + 1);
  if (!isValidAtpmStageRkey(rkey)) return null;

  // `parseAtpmPackageName` is the one place DID syntax and host policy are
  // decided; borrow it with a placeholder record key rather than restating it.
  const did = parseAtpmPackageName(`${body.slice(0, separator)}/x`)?.authority;
  if (did?.kind !== "did") return null;
  return { did: did.did, rkey, stageId: formatAtpmStageId(did.did, rkey) };
}
