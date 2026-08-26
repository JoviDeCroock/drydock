import { parseAtpmPackageName, type AtpmPackageRef } from "./identity";

const TID_RE = /^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/;

export function isValidAtpmStageRkey(rkey: string): boolean {
  return TID_RE.test(rkey);
}

// Pin mutable staged records by CID so a rewrite cannot reuse stale cached evidence.
export const ATPM_STAGED_VERSION_PREFIX = "staged.";

export const ATPM_NO_BASELINE_VERSION = "staged.none";

export interface AtpmStagedVersionRef {
  rkey: string;
  recordCid: string;
}

export function formatAtpmStagedVersion(rkey: string, recordCid: string): string {
  return `${ATPM_STAGED_VERSION_PREFIX}${rkey}.${recordCid}`;
}

export function isAtpmStagedVersion(value: string): boolean {
  return parseAtpmStagedVersion(value) !== null;
}

export function parseAtpmStagedVersion(value: string): AtpmStagedVersionRef | null {
  if (!value.startsWith(ATPM_STAGED_VERSION_PREFIX) || value === ATPM_NO_BASELINE_VERSION) {
    return null;
  }
  const body = value.slice(ATPM_STAGED_VERSION_PREFIX.length);
  const separator = body.indexOf(".");
  if (separator <= 0) return null;
  const rkey = body.slice(0, separator);
  const recordCid = body.slice(separator + 1);
  if (!isValidAtpmStageRkey(rkey) || !/^[a-z0-9]{16,128}$/.test(recordCid)) return null;
  return { rkey, recordCid };
}

export function parseAtpmPublisherRef(publisherRef: string): AtpmPackageRef | null {
  const trimmed = publisherRef.trim();
  if (!trimmed) return null;
  return parseAtpmPackageName(`${trimmed}/x`);
}
