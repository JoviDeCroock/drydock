/**
 * Build attestation verification — public entry.
 *
 * Answers "where did these bytes come from?" from SLSA/in-toto attestations,
 * and grades the answer against bindings Drydock holds independently of the
 * package. Advisory only: like the intent envelope, it never feeds risk or
 * findings.
 *
 * See `docs/build-attestation.md` for the trust model, including what a
 * `verified` verdict does and does not establish.
 */

export { evaluateBuildAttestation, type AttestationLookup } from "./verdict";
export { normalizeBuildAttestation } from "./normalize";
export { parseInTotoStatement } from "./statement";
export { parseSigstoreBundle, verifyDsseSignature, dssePae, derEcdsaSignatureToRaw } from "./dsse";
export type {
  AttestationBinding,
  BuildAttestation,
  BuildAttestationCheck,
  BuildAttestationCheckKind,
  BuildAttestationCheckResult,
  BuildAttestationStatus,
  BuildAttestationTrustCeiling,
  BuildClaim,
} from "./types";
