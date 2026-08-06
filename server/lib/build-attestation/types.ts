/**
 * Build attestation: the evidence that a reviewed artifact was produced by a
 * specific build, and Drydock's verdict on whether that evidence agrees with
 * what Drydock independently knows about the release.
 *
 * Naming note — `provenance` is already taken in this codebase. `ReleaseProvenance`
 * (`server/lib/ecosystems/package-adapter.ts`, surfaced as `summary.stagedPublish.provenance`
 * and the report's Provenance section) is the *byte-continuity* record: the
 * artifacts Drydock reviewed and the SHA-256s it recomputed from them. That
 * answers "are these the bytes that were reviewed?".
 *
 * This module answers a different question — "where did these bytes come from?"
 * — from SLSA/in-toto build attestations. The two are complementary and are
 * deliberately kept as separate persisted blobs.
 */

/**
 * Verdict on the build attestation evidence for one reviewed release.
 *
 * The lattice is ordered by what it lets a reader conclude, and every level
 * except `mismatch` is an absence-of-evidence state rather than an accusation:
 *
 *  - `verified` — an attestation exists whose subject digest is one of the
 *    digests Drydock recomputed from the reviewed bytes, whose DSSE signature
 *    verified against the key in its own certificate, and which agrees with at
 *    least one binding Drydock independently holds (repository or workflow run)
 *    while contradicting none.
 *  - `partial` — an attestation covers the reviewed bytes and contradicts
 *    nothing, but the evidence is weaker than `verified`: either no signature
 *    could be verified, or the predicate names no repository/run for Drydock to
 *    compare against (the npm publish attestation, for instance, attests the
 *    publish event and carries no source binding).
 *  - `mismatch` — an attestation exists and *contradicts* Drydock's own
 *    binding: it attests different bytes, a different repository, or a
 *    different workflow run. The only level that asserts something is wrong.
 *  - `absent` — the lookup succeeded and no attestation covers these bytes.
 *    Normal for releases that do not publish provenance.
 *  - `unavailable` — the lookup or parse failed. Evidence is missing, which is
 *    not evidence of wrongdoing.
 */
export type BuildAttestationStatus = "verified" | "partial" | "mismatch" | "absent" | "unavailable";

/** Which independently-held fact a cross-check compared the claim against. */
export type BuildAttestationCheckKind =
  /** Subject digest vs the SHA-256 Drydock recomputed from the reviewed bytes. */
  | "subject-digest"
  /** Claimed source repository vs the repository the signed webhook bound. */
  | "repository"
  /** Claimed workflow run vs the run id the signed webhook bound. */
  | "workflow-run"
  /** Claimed source commit vs the head commit of that run. */
  | "source-commit"
  /** DSSE signature over the payload, using the key in the bundle's certificate. */
  | "signature";

export type BuildAttestationCheckResult = "pass" | "fail" | "skipped";

export interface BuildAttestationCheck {
  kind: BuildAttestationCheckKind;
  result: BuildAttestationCheckResult;
  /** Human-readable evidence. Never contains credential material. */
  detail: string;
}

/**
 * The build claims projected out of an in-toto statement, normalized across
 * predicate versions. Every field is what the attestation *says*; whether to
 * believe it is the verdict's job.
 */
export interface BuildClaim {
  /** Predicate type URI, e.g. `https://slsa.dev/provenance/v1`. */
  predicateType: string;
  /** Normalized `https://github.com/owner/repo` when the claim names one. */
  repository: string | null;
  /** Workflow file path within the repository, when claimed. */
  workflowPath: string | null;
  /** Git ref the build ran against, e.g. `refs/heads/main`. */
  ref: string | null;
  /** 40-hex source commit the build resolved, when claimed. */
  commit: string | null;
  /** Workflow run id parsed out of the invocation id, when claimed. */
  runId: string | null;
  /** Run attempt parsed out of the invocation id, when claimed. */
  runAttempt: string | null;
  /** Builder identity URI, e.g. `https://github.com/actions/runner/github-hosted`. */
  builderId: string | null;
  /** Lowercase hex SHA-256 subject digests this statement covers. */
  subjectDigests: string[];
}

/**
 * The persisted, display-ready verdict. Advisory: like the intent envelope, it
 * never feeds risk or findings.
 */
export interface BuildAttestation {
  status: BuildAttestationStatus;
  /** Null unless an attestation was found and parsed. */
  claim: BuildClaim | null;
  /** Every cross-check that ran, in stable order. */
  checks: BuildAttestationCheck[];
  /**
   * What this verdict does *not* establish, carried with the verdict so no
   * reader has to remember the caveat. See `docs/build-attestation.md`.
   */
  trustCeiling: BuildAttestationTrustCeiling;
}

/**
 * The honest ceiling on what a `verified` verdict means here.
 *
 * `self-consistent` — the DSSE signature verified against the public key in the
 * bundle's own certificate, and the claims agree with Drydock's independently
 * authenticated binding. Drydock does **not** validate the certificate chain to
 * a Fulcio root, check SCTs, or verify Rekor transparency-log inclusion, so the
 * signature alone proves only that the bundle is internally consistent. The
 * load-bearing trust comes from the binding cross-checks, not the PKI.
 */
export type BuildAttestationTrustCeiling = "self-consistent" | "none";

/**
 * Facts Drydock holds independently of the attestation, used as the comparison
 * basis. For a workflow gate these come from the signed
 * `deployment_protection_rule` webhook and the digests the control plane
 * recomputed from the immutable Actions artifact — none of it is claimed by the
 * package.
 */
export interface AttestationBinding {
  /** `owner/repo` bound by the signed webhook. */
  repositoryFullName: string;
  /** Workflow run id bound by the signed webhook. */
  runId: number | string;
  /** Head commit of that run, when the control plane resolved it. */
  headSha?: string | null;
  /** Lowercase hex SHA-256 of every artifact in this review candidate. */
  artifactDigests: string[];
}
