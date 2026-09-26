/**
 * Staged-artifact byte verification — the verdict binding a review to the
 * bytes it reviewed.
 *
 * A scan's most consequential claim is what the staged artifact contains — the
 * diff turns "this file is not in the archive we downloaded" into "the
 * publisher removed it". Those are only the same statement when the bytes we
 * parsed are the bytes the registry recorded. Registries publish a digest for
 * the artifact they hold (npm hands us `shasum` alongside the stage record),
 * and the sandbox hashes the wire bytes it actually received, so the two can
 * be compared.
 *
 * Scope of the guarantee: this proves transport/parse integrity against the
 * registry's own record. It is not publisher authentication — a registry that
 * serves tampered bytes reports the tampered digest with them — and the digest
 * algorithm is whichever one the registry publishes, not one chosen for
 * collision resistance. Provenance attestation is a separate concern.
 *
 * Ecosystem-free on purpose: the verdict is persisted with the report and read
 * back by the report export and the UI, neither of which may reach into an
 * ecosystem directory. An adapter produces it with
 * `evaluateStagedArtifactIntegrity` and exposes it from `summarizeDetails`.
 */

type StagedArtifactIntegrityStatus = "verified" | "mismatch" | "unverified";

type StagedArtifactIntegrityReason =
  /** The registry did not report a digest for this staged artifact. */
  | "declared-digest-missing"
  /** The sandbox could not digest the whole stream (cancelled, errored, or over the cap). */
  | "computed-digest-unavailable"
  /** A mismatch could not be confirmed against a fresh stage record. */
  | "stage-record-confirmation-unavailable";

export interface StagedArtifactIntegrity {
  algorithm: "sha1";
  status: StagedArtifactIntegrityStatus;
  /** Digest the registry reported for the staged artifact. */
  declared: string | null;
  /** Digest the sandbox computed from the bytes it downloaded and parsed. */
  computed: string | null;
  reason?: StagedArtifactIntegrityReason;
}

/**
 * Compare the registry's declared staged-artifact digest against the digest the
 * sandbox computed from the bytes it parsed.
 *
 * Fails to "unverified", never to "mismatch": a missing digest on either side
 * is an absence of evidence, and accusing a publisher of shipping different
 * bytes than they staged is a claim that must rest on two digests that both
 * exist. Comparison is case-insensitive because registries render hex in
 * either case.
 */
export function evaluateStagedArtifactIntegrity(
  declaredDigest: string | null | undefined,
  computedDigest: string | null | undefined,
): StagedArtifactIntegrity {
  const declared = normalizeDigest(declaredDigest);
  const computed = normalizeDigest(computedDigest);
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

/**
 * Re-validate a persisted verdict before displaying or exporting it. Old scans
 * omit the field, and persisted JSON must not be trusted to claim verification
 * unless its status agrees with two well-formed digests.
 */
export function parseStagedArtifactIntegrity(value: unknown): StagedArtifactIntegrity | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.algorithm !== "sha1") return null;

  const declared = normalizePersistedDigest(record.declared);
  const computed = normalizePersistedDigest(record.computed);
  if (declared === undefined || computed === undefined) return null;

  if (record.status === "verified" && declared && computed && declared === computed) {
    return { algorithm: "sha1", status: "verified", declared, computed };
  }
  if (record.status === "mismatch" && declared && computed && declared !== computed) {
    return { algorithm: "sha1", status: "mismatch", declared, computed };
  }
  if (
    record.status === "unverified" &&
    record.reason === "declared-digest-missing" &&
    declared === null
  ) {
    return {
      algorithm: "sha1",
      status: "unverified",
      declared: null,
      computed,
      reason: "declared-digest-missing",
    };
  }
  if (
    record.status === "unverified" &&
    record.reason === "computed-digest-unavailable" &&
    declared &&
    computed === null
  ) {
    return {
      algorithm: "sha1",
      status: "unverified",
      declared,
      computed: null,
      reason: "computed-digest-unavailable",
    };
  }
  if (
    record.status === "unverified" &&
    record.reason === "stage-record-confirmation-unavailable" &&
    declared &&
    computed &&
    declared !== computed
  ) {
    return {
      algorithm: "sha1",
      status: "unverified",
      declared,
      computed,
      reason: "stage-record-confirmation-unavailable",
    };
  }
  return null;
}

function normalizeDigest(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return /^[0-9a-f]{40}$/.test(trimmed) ? trimmed : null;
}

function normalizePersistedDigest(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  return normalizeDigest(value) ?? undefined;
}

/** Digests of one archive's wire bytes; either may be absent. */
export interface ArchiveDigests {
  sha1: string | null;
  sha256: string | null;
}

const SHA1_HEX = /^[0-9a-f]{40}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Lowercase, well-formed hex only; null when neither digest is usable. */
export function normalizeArchiveDigests(
  digests: { sha1?: unknown; sha256?: unknown } | null | undefined,
): ArchiveDigests | null {
  const sha1 = typeof digests?.sha1 === "string" ? digests.sha1.toLowerCase() : null;
  const sha256 = typeof digests?.sha256 === "string" ? digests.sha256.toLowerCase() : null;
  const normalized = {
    sha1: sha1 && SHA1_HEX.test(sha1) ? sha1 : null,
    sha256: sha256 && SHA256_HEX.test(sha256) ? sha256 : null,
  };
  return normalized.sha1 || normalized.sha256 ? normalized : null;
}

/**
 * The digests a published-pair review persisted for the release it reviewed,
 * re-validated from its summary. Null for any other scan, and for a review
 * whose sandbox could not observe the whole archive.
 */
export function publishedPairArtifactDigest(summaryJson: unknown): ArchiveDigests | null {
  if (!summaryJson || typeof summaryJson !== "object" || Array.isArray(summaryJson)) return null;
  const stagedPublish = (summaryJson as { stagedPublish?: unknown }).stagedPublish;
  if (!stagedPublish || typeof stagedPublish !== "object" || Array.isArray(stagedPublish)) {
    return null;
  }
  const details = stagedPublish as { mode?: unknown; artifactDigest?: unknown };
  if (details.mode !== "published_pair") return null;
  const digest = details.artifactDigest;
  if (!digest || typeof digest !== "object" || Array.isArray(digest)) return null;
  return normalizeArchiveDigests(digest as { sha1?: unknown; sha256?: unknown });
}

/**
 * Whether two sets of digests identify the same bytes. `match` needs at least
 * one algorithm both carry, and every shared one to agree; any shared one
 * disagreeing is `differ`. A digest only one side has is no evidence either
 * way, so with nothing shared the answer is `incomparable`, never a match.
 */
export function compareArchiveDigests(
  a: ArchiveDigests | null,
  b: ArchiveDigests | null,
): "match" | "differ" | "incomparable" {
  if (!a || !b) return "incomparable";
  let compared = 0;
  for (const algorithm of ["sha1", "sha256"] as const) {
    const left = a[algorithm];
    const right = b[algorithm];
    if (!left || !right) continue;
    if (left !== right) return "differ";
    compared++;
  }
  return compared > 0 ? "match" : "incomparable";
}
