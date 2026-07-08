import { base64Encode, base64UrlEncode } from "./platform/crypto-utils";

// Signed attestations for publicly shared scan reports.
//
// The attested subject is the canonical report export (`serializeReportExport`)
// — the same stable-ordered bytes served at /public/reports/:token — so any
// consumer can independently re-hash the report they fetched and verify the
// signature against the published key. The envelope is DSSE
// (https://github.com/secure-systems-lab/dsse) around an in-toto v1 Statement,
// the format sigstore/SLSA tooling already understands.

export const ATTESTATION_PAYLOAD_TYPE = "application/vnd.in-toto+json";
export const ATTESTATION_PREDICATE_TYPE = "https://drydock.org/attestation/scan-report/v1";
const ATTESTATION_KEY_ALGORITHM = "Ed25519";

export interface AttestationSubject {
  /** `name@version` when known, otherwise the scan id. */
  name: string;
  /** Hex sha256 of the canonical report export bytes. */
  reportSha256: string;
}

export interface AttestationPredicate {
  scanId: string;
  packageName: string | null;
  stagedVersion: string | null;
  previousVersion: string | null;
  risk: string;
  decision: string | null;
  findingCount: number;
  reportSchema: string;
  reportDigest: string | null;
  completedAt: string | null;
}

export interface DsseEnvelope {
  payloadType: string;
  payload: string;
  signatures: Array<{ keyid: string; sig: string }>;
}

export interface AttestationKey {
  privateKey: CryptoKey;
  publicJwk: JsonWebKey;
  keyId: string;
}

/**
 * Load the Ed25519 signing key from the `ATTESTATION_SIGNING_KEY_JWK` secret
 * (a private OKP JWK). Returns null when the secret is absent or malformed —
 * callers degrade to "attestations unavailable" rather than failing the share.
 */
export async function loadAttestationKey(env: {
  ATTESTATION_SIGNING_KEY_JWK?: string;
}): Promise<AttestationKey | null> {
  const raw = env.ATTESTATION_SIGNING_KEY_JWK;
  if (!raw) return null;
  let jwk: JsonWebKey;
  try {
    jwk = JSON.parse(raw) as JsonWebKey;
  } catch {
    return null;
  }
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.d !== "string") return null;
  try {
    const privateKey = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: ATTESTATION_KEY_ALGORITHM },
      false,
      ["sign"],
    );
    const publicJwk = publicJwkFromPrivate(jwk);
    return { privateKey, publicJwk, keyId: await jwkThumbprint(publicJwk) };
  } catch {
    return null;
  }
}

export function publicJwkFromPrivate(jwk: JsonWebKey): JsonWebKey {
  return { kty: jwk.kty, crv: jwk.crv, x: jwk.x };
}

/** RFC 7638 JWK thumbprint (OKP members, lexicographic order), base64url. */
export async function jwkThumbprint(publicJwk: JsonWebKey): Promise<string> {
  const canonical = JSON.stringify({ crv: publicJwk.crv, kty: publicJwk.kty, x: publicJwk.x });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return base64UrlEncode(new Uint8Array(digest));
}

export function buildAttestationStatement(
  subject: AttestationSubject,
  predicate: AttestationPredicate,
) {
  return {
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name: subject.name, digest: { sha256: subject.reportSha256 } }],
    predicateType: ATTESTATION_PREDICATE_TYPE,
    predicate,
  };
}

/**
 * DSSE Pre-Authentication Encoding: the signature covers the payload type and
 * body with length framing, so an envelope's payload cannot be reinterpreted
 * under a different type.
 */
export function preAuthenticationEncoding(
  payloadType: string,
  payload: Uint8Array,
): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const typeBytes = encoder.encode(payloadType);
  const header = encoder.encode(`DSSEv1 ${typeBytes.length} ${payloadType} ${payload.length} `);
  const out = new Uint8Array(header.length + payload.length);
  out.set(header, 0);
  out.set(payload, header.length);
  return out;
}

export async function signAttestation(
  key: AttestationKey,
  statement: ReturnType<typeof buildAttestationStatement>,
): Promise<DsseEnvelope> {
  const payload = new TextEncoder().encode(JSON.stringify(statement));
  const signature = await crypto.subtle.sign(
    ATTESTATION_KEY_ALGORITHM,
    key.privateKey,
    preAuthenticationEncoding(ATTESTATION_PAYLOAD_TYPE, payload),
  );
  // DSSE permits either base64 alphabet, but sigstore/in-toto tooling emits and
  // expects standard base64 — match it so strict verifiers accept our envelopes.
  return {
    payloadType: ATTESTATION_PAYLOAD_TYPE,
    payload: base64Encode(payload),
    signatures: [{ keyid: key.keyId, sig: base64Encode(new Uint8Array(signature)) }],
  };
}

export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  return hex;
}
