/**
 * Staged-tarball byte verification.
 *
 * A scan's most consequential claim is what the staged artifact contains — the
 * diff turns "this file is not in the tarball we downloaded" into "the
 * publisher removed it". Those are only the same statement when the bytes we
 * parsed are the bytes the registry recorded. npm hands us the staged
 * tarball's SHA-1 as `shasum` alongside the stage metadata, and the sandbox
 * hashes the wire bytes it actually received, so the two can be compared.
 *
 * Scope of the guarantee: this proves transport/parse integrity against the
 * registry's own record. It is not publisher authentication — a registry that
 * serves tampered bytes reports the tampered digest with them — and SHA-1 is
 * used because it is the digest npm publishes, not because it is collision
 * resistant. Provenance attestation is a separate concern.
 */

import type { StagedPublishDetails } from "./staged-publishes";

export type StagedTarballIntegrityStatus = "verified" | "mismatch" | "unverified";

export type StagedTarballIntegrityReason =
  /** The registry did not report a digest for this stage. */
  | "declared-digest-missing"
  /** The sandbox could not digest the whole stream (cancelled, errored, or over the cap). */
  | "computed-digest-unavailable";

export interface StagedTarballIntegrity {
  algorithm: "sha1";
  status: StagedTarballIntegrityStatus;
  /** Digest the registry reported for the staged tarball. */
  declared: string | null;
  /** Digest the sandbox computed from the bytes it downloaded and parsed. */
  computed: string | null;
  reason?: StagedTarballIntegrityReason;
}

/**
 * Staged metadata as the npm adapter carries it through a scan: the registry's
 * own stage record plus the byte-verification verdict computed for it. Only
 * the adapter reads this shape — the pipeline treats staged details as opaque.
 */
export interface NpmStagedDetails extends StagedPublishDetails {
  tarballIntegrity: StagedTarballIntegrity;
}

/**
 * Compare npm's declared staged-tarball digest against the digest the sandbox
 * computed from the bytes it parsed.
 *
 * Fails to "unverified", never to "mismatch": a missing digest on either side
 * is an absence of evidence, and accusing a publisher of shipping different
 * bytes than they staged is a claim that must rest on two digests that both
 * exist. Comparison is case-insensitive because registries render hex in
 * either case.
 */
export function evaluateStagedTarballIntegrity(
  declaredShasum: string | null | undefined,
  computedSha1: string | null | undefined,
): StagedTarballIntegrity {
  const declared = normalizeDigest(declaredShasum);
  const computed = normalizeDigest(computedSha1);
  if (!declared) {
    return {
      algorithm: "sha1",
      status: "unverified",
      declared: null,
      computed,
      reason: "declared-digest-missing",
    };
  }
  if (!computed) {
    return {
      algorithm: "sha1",
      status: "unverified",
      declared,
      computed: null,
      reason: "computed-digest-unavailable",
    };
  }
  return {
    algorithm: "sha1",
    status: declared === computed ? "verified" : "mismatch",
    declared,
    computed,
  };
}

function normalizeDigest(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return /^[0-9a-f]{40}$/.test(trimmed) ? trimmed : null;
}
