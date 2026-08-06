/**
 * Bounded reader for Sigstore bundles and the DSSE envelopes inside them.
 *
 * Attestation bundles are hostile evidence in exactly the way package bytes
 * are: they arrive from a registry or from a repository's own attestation
 * store, and a malicious release controls their contents. Everything here
 * parses and compares; nothing evaluates, and every structure is size-bounded
 * before it is walked.
 *
 * Signature verification here is deliberately *narrow*: it checks the DSSE
 * signature against the public key carried in the bundle's own certificate. It
 * does not validate the certificate chain to a Fulcio root, check SCTs, or
 * verify Rekor inclusion proofs — see `docs/build-attestation.md` for why that
 * ceiling is where it is, and why the binding cross-checks rather than the PKI
 * carry the weight of the verdict.
 */

// Bundles are small by construction: a DSSE payload is a JSON statement naming
// a handful of digests, and a Fulcio leaf certificate is ~1-2 KB. These caps
// are far above every legitimate value and exist so a hostile bundle cannot
// make the parser do unbounded work.
const MAX_PAYLOAD_BYTES = 256 * 1024;
const MAX_CERTIFICATE_BYTES = 16 * 1024;
const MAX_SIGNATURE_BYTES = 1024;
const MAX_SIGNATURES = 8;
const MAX_BASE64_INPUT = 512 * 1024;
// A certificate nests a handful of levels; anything deeper is malformed or
// hostile and is refused rather than walked.
const MAX_DER_DEPTH = 16;

export interface ParsedDsseEnvelope {
  /** Decoded payload bytes — the in-toto statement JSON. */
  payload: Uint8Array;
  /** DSSE payload type, e.g. `application/vnd.in-toto+json`. */
  payloadType: string;
  signatures: Uint8Array[];
  /** Leaf certificate DER, when the bundle carries verification material. */
  certificate: Uint8Array | null;
}

export type SignatureOutcome =
  | { verified: true; algorithm: string }
  | { verified: false; reason: string };

/**
 * Pull the DSSE envelope and leaf certificate out of a Sigstore bundle.
 *
 * Accepts both bundle layouts in circulation: `verificationMaterial.certificate`
 * (bundle v0.3+) and `verificationMaterial.x509CertificateChain.certificates[0]`
 * (v0.1/v0.2). A bundle with a bare public key and no certificate parses fine
 * and yields `certificate: null` — the envelope is still readable, it just
 * cannot be signature-checked here.
 */
export function parseSigstoreBundle(value: unknown): ParsedDsseEnvelope | null {
  if (!isRecord(value)) return null;
  const envelope = value.dsseEnvelope;
  if (!isRecord(envelope)) return null;

  const payloadType = envelope.payloadType;
  if (typeof payloadType !== "string" || !payloadType || payloadType.length > 256) return null;

  const payload = decodeBase64(envelope.payload, MAX_PAYLOAD_BYTES);
  if (!payload) return null;

  const signatures: Uint8Array[] = [];
  if (Array.isArray(envelope.signatures)) {
    for (const entry of envelope.signatures.slice(0, MAX_SIGNATURES)) {
      if (!isRecord(entry)) continue;
      const sig = decodeBase64(entry.sig, MAX_SIGNATURE_BYTES);
      if (sig && sig.length) signatures.push(sig);
    }
  }

  return {
    payload,
    payloadType,
    signatures,
    certificate: extractCertificate(value.verificationMaterial),
  };
}

function extractCertificate(material: unknown): Uint8Array | null {
  if (!isRecord(material)) return null;
  const direct = material.certificate;
  if (isRecord(direct)) {
    const bytes = decodeBase64(direct.rawBytes, MAX_CERTIFICATE_BYTES);
    if (bytes) return bytes;
  }
  const chain = material.x509CertificateChain;
  if (isRecord(chain) && Array.isArray(chain.certificates)) {
    // The leaf is first by specification; intermediates and roots are ignored
    // because no chain validation happens here.
    const leaf = chain.certificates[0];
    if (isRecord(leaf)) return decodeBase64(leaf.rawBytes, MAX_CERTIFICATE_BYTES);
  }
  return null;
}

/**
 * DSSE Pre-Authentication Encoding (PAE), the exact byte string a DSSE
 * signature covers:
 *
 *   "DSSEv1" SP len(payloadType) SP payloadType SP len(payload) SP payload
 *
 * Lengths are ASCII decimal byte counts, not character counts. Getting this
 * wrong makes every signature fail to verify, so it is exercised directly in
 * the tests against a known-good bundle.
 */
export function dssePae(payloadType: string, payload: Uint8Array): Uint8Array {
  const encoder = new TextEncoder();
  const typeBytes = encoder.encode(payloadType);
  const prefix = encoder.encode(`DSSEv1 ${typeBytes.length} ${payloadType} ${payload.length} `);
  const out = new Uint8Array(prefix.length + payload.length);
  out.set(prefix, 0);
  out.set(payload, prefix.length);
  return out;
}

/**
 * Verify the envelope's DSSE signature against the public key in its own
 * certificate. Any signature in the envelope verifying is enough — DSSE allows
 * multiple signers and the bundles in circulation carry one.
 *
 * Returns a structured non-verified outcome rather than throwing: an
 * unsupported key type or a malformed signature must degrade the verdict to
 * `partial`, never fail the scan.
 */
export async function verifyDsseSignature(envelope: ParsedDsseEnvelope): Promise<SignatureOutcome> {
  if (!envelope.signatures.length) return { verified: false, reason: "no signature in envelope" };
  if (!envelope.certificate) {
    return { verified: false, reason: "no certificate in verification material" };
  }

  const publicKey = extractSubjectPublicKeyInfo(envelope.certificate);
  if (!publicKey) return { verified: false, reason: "certificate public key not readable" };

  const imported = await importVerificationKey(publicKey);
  if (!imported) {
    return { verified: false, reason: `unsupported key algorithm (${publicKey.algorithm})` };
  }

  const message = dssePae(envelope.payloadType, envelope.payload);
  for (const signature of envelope.signatures) {
    const raw =
      imported.kind === "ecdsa"
        ? derEcdsaSignatureToRaw(signature, imported.coordinateBytes)
        : signature;
    if (!raw) continue;
    let ok = false;
    try {
      ok = await crypto.subtle.verify(
        imported.verifyParams,
        imported.key,
        toArrayBuffer(raw),
        toArrayBuffer(message),
      );
    } catch {
      ok = false;
    }
    if (ok) return { verified: true, algorithm: publicKey.algorithm };
  }
  return { verified: false, reason: "signature did not verify against certificate key" };
}

interface SubjectPublicKeyInfo {
  /** The complete SubjectPublicKeyInfo TLV, ready for WebCrypto `importKey`. */
  der: Uint8Array;
  algorithm: "ecdsa-p256" | "ecdsa-p384" | "ecdsa-p521" | "ed25519" | "unknown";
}

type ImportedKey =
  | {
      kind: "ecdsa";
      key: CryptoKey;
      verifyParams: EcdsaParams;
      coordinateBytes: number;
    }
  | { kind: "eddsa"; key: CryptoKey; verifyParams: AlgorithmIdentifier };

async function importVerificationKey(info: SubjectPublicKeyInfo): Promise<ImportedKey | null> {
  const curves = {
    "ecdsa-p256": { namedCurve: "P-256", hash: "SHA-256", coordinateBytes: 32 },
    "ecdsa-p384": { namedCurve: "P-384", hash: "SHA-384", coordinateBytes: 48 },
    "ecdsa-p521": { namedCurve: "P-521", hash: "SHA-512", coordinateBytes: 66 },
  } as const;

  try {
    if (info.algorithm === "ed25519") {
      const key = await crypto.subtle.importKey(
        "spki",
        toArrayBuffer(info.der),
        { name: "Ed25519" },
        false,
        ["verify"],
      );
      return { kind: "eddsa", key, verifyParams: { name: "Ed25519" } };
    }
    const curve = curves[info.algorithm as keyof typeof curves];
    if (!curve) return null;
    const key = await crypto.subtle.importKey(
      "spki",
      toArrayBuffer(info.der),
      { name: "ECDSA", namedCurve: curve.namedCurve },
      false,
      ["verify"],
    );
    return {
      kind: "ecdsa",
      key,
      verifyParams: { name: "ECDSA", hash: curve.hash },
      coordinateBytes: curve.coordinateBytes,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Minimal DER reader
//
// Only what is needed to walk an X.509 certificate to its SubjectPublicKeyInfo
// and to unpack an ECDSA signature. It reads structure and never interprets
// semantics beyond the OIDs it recognizes.
// ---------------------------------------------------------------------------

interface DerNode {
  tag: number;
  /** Offset of the first content byte. */
  start: number;
  /** Offset one past the last content byte. */
  end: number;
  /** Offset of the tag byte — the start of the complete TLV. */
  tlvStart: number;
}

function readDerNode(bytes: Uint8Array, offset: number): DerNode | null {
  if (offset + 2 > bytes.length) return null;
  const tag = bytes[offset];
  // High-tag-number form (tag byte's low 5 bits all set) never appears in the
  // structures read here; refusing it keeps the reader simple and total.
  if ((tag & 0x1f) === 0x1f) return null;

  let cursor = offset + 1;
  const first = bytes[cursor];
  cursor += 1;
  let length: number;
  if (first < 0x80) {
    length = first;
  } else {
    const lengthBytes = first & 0x7f;
    // Indefinite length (0x80) is not valid DER, and a length needing more than
    // 4 bytes exceeds every cap this module enforces anyway.
    if (lengthBytes === 0 || lengthBytes > 4) return null;
    if (cursor + lengthBytes > bytes.length) return null;
    length = 0;
    for (let i = 0; i < lengthBytes; i += 1) {
      length = length * 256 + bytes[cursor + i];
    }
    cursor += lengthBytes;
  }
  const end = cursor + length;
  if (end > bytes.length) return null;
  return { tag, start: cursor, end, tlvStart: offset };
}

/** Read every immediate child TLV of a constructed node. */
function readDerChildren(bytes: Uint8Array, node: DerNode, depth: number): DerNode[] | null {
  if (depth > MAX_DER_DEPTH) return null;
  const children: DerNode[] = [];
  let cursor = node.start;
  while (cursor < node.end) {
    const child = readDerNode(bytes, cursor);
    if (!child || child.end > node.end) return null;
    children.push(child);
    cursor = child.end;
  }
  return children;
}

const DER_SEQUENCE = 0x30;
const DER_INTEGER = 0x02;
const DER_OID = 0x06;
// Context-specific constructed [0] — the EXPLICIT tag wrapping X.509 `version`.
const DER_CONTEXT_0 = 0xa0;

const OID_EC_PUBLIC_KEY = "2a8648ce3d0201";
const OID_ED25519 = "2b6570";
const OID_CURVES: Record<string, SubjectPublicKeyInfo["algorithm"]> = {
  "2a8648ce3d030107": "ecdsa-p256",
  "2b81040022": "ecdsa-p384",
  "2b81040023": "ecdsa-p521",
};

/**
 * Walk an X.509 certificate to its SubjectPublicKeyInfo and identify the key
 * algorithm.
 *
 * Structure (RFC 5280): Certificate is a SEQUENCE whose first element is
 * tbsCertificate, itself a SEQUENCE of `[0] version` (optional), serialNumber,
 * signature, issuer, validity, subject, subjectPublicKeyInfo, … — so the SPKI
 * is the seventh element once the optional version tag is accounted for.
 */
export function extractSubjectPublicKeyInfo(certificate: Uint8Array): SubjectPublicKeyInfo | null {
  const root = readDerNode(certificate, 0);
  if (!root || root.tag !== DER_SEQUENCE) return null;
  const certChildren = readDerChildren(certificate, root, 0);
  if (!certChildren?.length) return null;

  const tbs = certChildren[0];
  if (tbs.tag !== DER_SEQUENCE) return null;
  const tbsChildren = readDerChildren(certificate, tbs, 1);
  if (!tbsChildren) return null;

  // `version` is EXPLICIT [0] and optional (absent means v1).
  const fields = tbsChildren[0]?.tag === DER_CONTEXT_0 ? tbsChildren.slice(1) : tbsChildren;
  const spki = fields[5];
  if (!spki || spki.tag !== DER_SEQUENCE) return null;

  const spkiChildren = readDerChildren(certificate, spki, 2);
  const algorithmId = spkiChildren?.[0];
  if (!algorithmId || algorithmId.tag !== DER_SEQUENCE) return null;
  const algorithmParts = readDerChildren(certificate, algorithmId, 3);
  const algorithmOid = algorithmParts?.[0];
  if (!algorithmOid || algorithmOid.tag !== DER_OID) return null;

  const der = certificate.slice(spki.tlvStart, spki.end);
  const oid = toHex(certificate.subarray(algorithmOid.start, algorithmOid.end));
  if (oid === OID_ED25519) return { der, algorithm: "ed25519" };
  if (oid !== OID_EC_PUBLIC_KEY) return { der, algorithm: "unknown" };

  const curveOid = algorithmParts?.[1];
  if (!curveOid || curveOid.tag !== DER_OID) return { der, algorithm: "unknown" };
  const curve = OID_CURVES[toHex(certificate.subarray(curveOid.start, curveOid.end))];
  return { der, algorithm: curve ?? "unknown" };
}

/**
 * Convert an ASN.1 DER ECDSA signature (`SEQUENCE { INTEGER r, INTEGER s }`) to
 * the fixed-width `r || s` form WebCrypto expects.
 *
 * Sigstore signs with DER-encoded ECDSA; WebCrypto's ECDSA verify takes IEEE
 * P1363. Without this conversion every signature check fails, which would
 * silently downgrade every real attestation to `unsigned`.
 */
export function derEcdsaSignatureToRaw(
  signature: Uint8Array,
  coordinateBytes: number,
): Uint8Array | null {
  const root = readDerNode(signature, 0);
  if (!root || root.tag !== DER_SEQUENCE || root.end !== signature.length) return null;
  const parts = readDerChildren(signature, root, 0);
  if (!parts || parts.length !== 2) return null;
  const [r, s] = parts;
  if (r.tag !== DER_INTEGER || s.tag !== DER_INTEGER) return null;

  const out = new Uint8Array(coordinateBytes * 2);
  if (!writeFixedWidth(signature.subarray(r.start, r.end), out, 0, coordinateBytes)) return null;
  if (!writeFixedWidth(signature.subarray(s.start, s.end), out, coordinateBytes, coordinateBytes)) {
    return null;
  }
  return out;
}

/**
 * Right-align a DER INTEGER's magnitude into a fixed-width slot, dropping the
 * leading zero byte DER adds to keep values positive. A value that still does
 * not fit is not a coordinate for this curve.
 */
function writeFixedWidth(
  value: Uint8Array,
  out: Uint8Array,
  offset: number,
  width: number,
): boolean {
  let start = 0;
  while (start < value.length - 1 && value[start] === 0x00) start += 1;
  const magnitude = value.subarray(start);
  if (magnitude.length > width) return false;
  out.set(magnitude, offset + width - magnitude.length);
  return true;
}

// ---------------------------------------------------------------------------

function decodeBase64(value: unknown, maxBytes: number): Uint8Array | null {
  if (typeof value !== "string" || !value || value.length > MAX_BASE64_INPUT) return null;
  // Bundles use standard base64. Reject anything outside the alphabet before
  // handing it to `atob`, which is lenient about some malformed input.
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    return null;
  }
  if (binary.length > maxBytes) return null;
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
