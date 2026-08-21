/**
 * A bounded DER reader and the slice of X.509 needed to check a signing
 * certificate against a pinned issuer.
 *
 * This is deliberately not a general X.509 library. Everything here reads
 * attacker-supplied bytes — a certificate embedded in a package record written
 * by the party under review — so it parses only the fields a signature check
 * needs, never recurses on untrusted structure, refuses indefinite-length and
 * over-long encodings outright, and has no notion of a certificate store, a
 * chain builder, or name constraints. Callers pin the issuer they will accept.
 *
 * DER is a definite-length TLV encoding, so a single non-recursive reader over
 * a byte range is enough: every navigation step below is a fixed-depth walk
 * through `Certificate` and `TBSCertificate` rather than a search.
 */

/** Certificates are a few kilobytes; anything near this is not one. */
const MAX_CERTIFICATE_BYTES = 64 * 1024;

/** DER long-form lengths beyond four octets exceed any real certificate. */
const MAX_LENGTH_OCTETS = 4;

const TAG_BOOLEAN = 0x01;
const TAG_BIT_STRING = 0x03;
const TAG_OCTET_STRING = 0x04;
const TAG_OID = 0x06;
const TAG_UTF8_STRING = 0x0c;
const TAG_UTC_TIME = 0x17;
const TAG_GENERALIZED_TIME = 0x18;
const TAG_IA5_STRING = 0x16;
const TAG_SEQUENCE = 0x30;

/** Context-specific constructed `[3] EXPLICIT extensions` in a TBSCertificate. */
const TAG_EXTENSIONS = 0xa3;

interface DerNode {
  tag: number;
  /** Offset of the identifier octet. */
  start: number;
  /** Offset one past the final content octet. */
  end: number;
  contentStart: number;
  contentEnd: number;
}

class DerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DerError";
  }
}

/** Read one TLV at `offset`, bounded by `limit`. */
function readDer(bytes: Uint8Array, offset: number, limit = bytes.length): DerNode {
  if (offset >= limit) throw new DerError("truncated DER value");
  const tag = bytes[offset];
  // Multi-byte tags (low five bits all set) do not appear anywhere in the
  // certificate structure this module reads.
  if ((tag & 0x1f) === 0x1f) throw new DerError("unsupported multi-byte DER tag");

  let cursor = offset + 1;
  if (cursor >= limit) throw new DerError("truncated DER length");
  const first = bytes[cursor++];
  let length: number;
  if ((first & 0x80) === 0) {
    length = first;
  } else {
    const octets = first & 0x7f;
    // Indefinite length is BER, not DER, and would make the end of this value
    // depend on scanning its contents.
    if (octets === 0) throw new DerError("indefinite DER length is not valid DER");
    if (octets > MAX_LENGTH_OCTETS) throw new DerError("DER length is too large");
    if (cursor + octets > limit) throw new DerError("truncated DER length");
    length = 0;
    for (let i = 0; i < octets; i++) length = length * 256 + bytes[cursor++];
  }

  const contentStart = cursor;
  const contentEnd = contentStart + length;
  if (contentEnd > limit) throw new DerError("DER value overruns its container");
  return { tag, start: offset, end: contentEnd, contentStart, contentEnd };
}

/** Every direct child of a constructed value, in order. */
function derChildren(bytes: Uint8Array, node: DerNode): DerNode[] {
  const children: DerNode[] = [];
  let offset = node.contentStart;
  while (offset < node.contentEnd) {
    const child = readDer(bytes, offset, node.contentEnd);
    children.push(child);
    offset = child.end;
  }
  return children;
}

function content(bytes: Uint8Array, node: DerNode): Uint8Array {
  return bytes.subarray(node.contentStart, node.contentEnd);
}

/** Decode an OBJECT IDENTIFIER to its dotted form. */
function decodeOid(bytes: Uint8Array, node: DerNode): string {
  if (node.tag !== TAG_OID) throw new DerError("expected an OBJECT IDENTIFIER");
  const value = content(bytes, node);
  if (!value.length) throw new DerError("empty OBJECT IDENTIFIER");

  const parts: number[] = [];
  const first = value[0];
  parts.push(Math.floor(first / 40), first % 40);
  let accumulator = 0;
  let started = false;
  for (let i = 1; i < value.length; i++) {
    const byte = value[i];
    // Arc values past 2^32 do not appear in certificate OIDs, and unbounded
    // accumulation would silently lose precision instead of failing.
    if (accumulator > 0x0fffffff) throw new DerError("OBJECT IDENTIFIER arc is too large");
    accumulator = accumulator * 128 + (byte & 0x7f);
    started = true;
    if ((byte & 0x80) === 0) {
      parts.push(accumulator);
      accumulator = 0;
      started = false;
    }
  }
  if (started) throw new DerError("truncated OBJECT IDENTIFIER");
  return parts.join(".");
}

/**
 * Decode the DER string an X.509 extension carries. Fulcio's Sigstore
 * extensions (1.3.6.1.4.1.57264.1.8 and above) wrap their value in a
 * UTF8String; the older extensions in the same arc store raw bytes.
 */
export function decodeDerString(value: Uint8Array): string {
  if (value.length >= 2 && (value[0] === TAG_UTF8_STRING || value[0] === TAG_IA5_STRING)) {
    try {
      const node = readDer(value, 0);
      if (node.end === value.length) {
        return new TextDecoder().decode(value.subarray(node.contentStart, node.contentEnd));
      }
    } catch {
      // Fall through to the raw reading below.
    }
  }
  return new TextDecoder().decode(value);
}

export interface X509Certificate {
  /** Exact `tbsCertificate` DER bytes — what the issuer's signature covers. */
  tbs: Uint8Array;
  /** Signature algorithm OID from the outer `Certificate`. */
  signatureAlgorithm: string;
  /** Raw `signatureValue` BIT STRING contents (a DER ECDSA signature). */
  signature: Uint8Array;
  notBefore: Date;
  notAfter: Date;
  /** DER `SubjectPublicKeyInfo`, importable by WebCrypto as `spki`. */
  spki: Uint8Array;
  /** WebCrypto curve name for `spki`, when it is an EC key. */
  namedCurve: EcCurve | null;
  /** Extension values keyed by dotted OID. */
  extensions: Map<string, Uint8Array>;
}

type EcCurve = "P-256" | "P-384" | "P-521";

const EC_PUBLIC_KEY_OID = "1.2.840.10045.2.1";
const CURVE_OIDS: Record<string, EcCurve> = {
  "1.2.840.10045.3.1.7": "P-256",
  "1.3.132.0.34": "P-384",
  "1.3.132.0.35": "P-521",
};
const ECDSA_SIGNATURE_HASHES: Record<string, "SHA-256" | "SHA-384" | "SHA-512"> = {
  "1.2.840.10045.4.3.2": "SHA-256",
  "1.2.840.10045.4.3.3": "SHA-384",
  "1.2.840.10045.4.3.4": "SHA-512",
};
/** Coordinate width in bytes, which fixes the raw (r‖s) signature length. */
const CURVE_COORDINATE_BYTES: Record<EcCurve, number> = {
  "P-256": 32,
  "P-384": 48,
  "P-521": 66,
};

/**
 * Parse the fields of an X.509 certificate a signature check needs.
 *
 * Fields this does not read (serial number, names, key usage, basic
 * constraints) are not consulted anywhere, so they are not parsed: the caller's
 * trust decision is "was this signed by the pinned issuer", not "does this
 * chain validate under a policy".
 */
export function parseX509(der: Uint8Array): X509Certificate {
  if (!der.length) throw new DerError("empty certificate");
  if (der.length > MAX_CERTIFICATE_BYTES) throw new DerError("certificate is too large");

  const certificate = readDer(der, 0);
  if (certificate.tag !== TAG_SEQUENCE) throw new DerError("certificate is not a SEQUENCE");
  // Trailing bytes after the outer SEQUENCE mean this is not one certificate.
  if (certificate.end !== der.length) throw new DerError("trailing bytes after certificate");

  const [tbsNode, algorithmNode, signatureNode] = derChildren(der, certificate);
  if (!tbsNode || !algorithmNode || !signatureNode) {
    throw new DerError("certificate is missing required fields");
  }

  const signatureAlgorithm = algorithmIdentifierOid(der, algorithmNode);
  if (signatureNode.tag !== TAG_BIT_STRING)
    throw new DerError("signatureValue is not a BIT STRING");
  const signatureBits = content(der, signatureNode);
  // The first BIT STRING octet counts unused trailing bits; a signature is
  // whole octets, so anything but zero is malformed.
  if (!signatureBits.length || signatureBits[0] !== 0) {
    throw new DerError("signatureValue has unused bits");
  }

  const tbsChildren = derChildren(der, tbsNode);
  // `version` is `[0] EXPLICIT` and optional; everything after it shifts.
  let index = tbsChildren[0]?.tag === 0xa0 ? 1 : 0;
  index += 1; // serialNumber
  const innerAlgorithmNode = tbsChildren[index++];
  index += 1; // issuer
  const validityNode = tbsChildren[index++];
  index += 1; // subject
  const spkiNode = tbsChildren[index++];
  if (!innerAlgorithmNode || !validityNode || !spkiNode) {
    throw new DerError("tbsCertificate is missing required fields");
  }
  // A certificate that names one algorithm inside the signed body and another
  // outside it is malformed; accepting it would let the unsigned copy choose
  // which hash the signature is checked with.
  if (algorithmIdentifierOid(der, innerAlgorithmNode) !== signatureAlgorithm) {
    throw new DerError("certificate signature algorithm mismatch");
  }

  const validity = derChildren(der, validityNode);
  if (validity.length !== 2) throw new DerError("validity is malformed");

  return {
    tbs: der.subarray(tbsNode.start, tbsNode.end),
    signatureAlgorithm,
    signature: signatureBits.subarray(1),
    notBefore: parseX509Time(der, validity[0]),
    notAfter: parseX509Time(der, validity[1]),
    spki: der.subarray(spkiNode.start, spkiNode.end),
    namedCurve: readNamedCurve(der, spkiNode),
    extensions: readExtensions(der, tbsChildren),
  };
}

function algorithmIdentifierOid(bytes: Uint8Array, node: DerNode): string {
  if (node.tag !== TAG_SEQUENCE) throw new DerError("AlgorithmIdentifier is not a SEQUENCE");
  const [oid] = derChildren(bytes, node);
  if (!oid) throw new DerError("AlgorithmIdentifier has no OID");
  return decodeOid(bytes, oid);
}

function readNamedCurve(bytes: Uint8Array, spkiNode: DerNode): EcCurve | null {
  const [algorithmNode] = derChildren(bytes, spkiNode);
  if (!algorithmNode || algorithmNode.tag !== TAG_SEQUENCE) return null;
  const parts = derChildren(bytes, algorithmNode);
  if (parts.length !== 2) return null;
  if (decodeOid(bytes, parts[0]) !== EC_PUBLIC_KEY_OID) return null;
  if (parts[1].tag !== TAG_OID) return null;
  return CURVE_OIDS[decodeOid(bytes, parts[1])] ?? null;
}

function readExtensions(bytes: Uint8Array, tbsChildren: DerNode[]): Map<string, Uint8Array> {
  const extensions = new Map<string, Uint8Array>();
  const container = tbsChildren.find((child) => child.tag === TAG_EXTENSIONS);
  if (!container) return extensions;
  const [sequence] = derChildren(bytes, container);
  if (!sequence || sequence.tag !== TAG_SEQUENCE) return extensions;

  for (const extension of derChildren(bytes, sequence)) {
    if (extension.tag !== TAG_SEQUENCE) continue;
    const parts = derChildren(bytes, extension);
    if (parts.length < 2 || parts[0].tag !== TAG_OID) continue;
    const valueNode = parts[parts.length - 1];
    if (valueNode.tag !== TAG_OCTET_STRING) continue;
    if (parts.length === 3 && parts[1].tag !== TAG_BOOLEAN) continue;
    const oid = decodeOid(bytes, parts[0]);
    // A repeated extension OID is prohibited; keep the first so a duplicate
    // appended by a rewriter cannot override the signed original.
    if (!extensions.has(oid)) extensions.set(oid, content(bytes, valueNode));
  }
  return extensions;
}

function parseX509Time(bytes: Uint8Array, node: DerNode): Date {
  const text = new TextDecoder().decode(content(bytes, node));
  let iso: string | null = null;
  if (node.tag === TAG_UTC_TIME && /^\d{12}Z$/.test(text)) {
    const year = Number(text.slice(0, 2));
    // RFC 5280: two-digit years 50-99 are 19xx, 00-49 are 20xx.
    const century = year >= 50 ? "19" : "20";
    iso = `${century}${text.slice(0, 2)}-${text.slice(2, 4)}-${text.slice(4, 6)}T${text.slice(6, 8)}:${text.slice(8, 10)}:${text.slice(10, 12)}Z`;
  } else if (node.tag === TAG_GENERALIZED_TIME && /^\d{14}Z$/.test(text)) {
    iso = `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}T${text.slice(8, 10)}:${text.slice(10, 12)}:${text.slice(12, 14)}Z`;
  }
  const parsed = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(parsed)) throw new DerError("certificate validity time is malformed");
  return new Date(parsed);
}

/**
 * Convert a DER `SEQUENCE { r INTEGER, s INTEGER }` ECDSA signature to the raw
 * fixed-width `r‖s` form WebCrypto requires. Returns null when the value is not
 * a well-formed signature for `curve`.
 */
function derEcdsaSignatureToRaw(signature: Uint8Array, curve: EcCurve): Uint8Array | null {
  const width = CURVE_COORDINATE_BYTES[curve];
  let node: DerNode;
  try {
    node = readDer(signature, 0);
    if (node.tag !== TAG_SEQUENCE || node.end !== signature.length) return null;
  } catch {
    return null;
  }
  let parts: DerNode[];
  try {
    parts = derChildren(signature, node);
  } catch {
    return null;
  }
  if (parts.length !== 2) return null;

  const raw = new Uint8Array(width * 2);
  for (let i = 0; i < 2; i++) {
    if (parts[i].tag !== 0x02) return null;
    let value = signature.subarray(parts[i].contentStart, parts[i].contentEnd);
    if (!value.length) return null;
    // DER integers are signed, so a coordinate with the high bit set carries a
    // leading zero octet. Strip it; reject a genuinely negative value.
    if (value[0] & 0x80) return null;
    while (value.length > 1 && value[0] === 0) value = value.subarray(1);
    if (value.length > width) return null;
    raw.set(value, width * (i + 1) - value.length);
  }
  return raw;
}

/**
 * Verify that `certificate` was signed by `issuer`. Returns false rather than
 * throwing for every malformed or unsupported input, so a caller can report one
 * "does not verify" outcome instead of distinguishing failure modes an attacker
 * chooses between.
 */
export async function verifyCertificateSignature(
  certificate: X509Certificate,
  issuer: X509Certificate,
): Promise<boolean> {
  const hash = ECDSA_SIGNATURE_HASHES[certificate.signatureAlgorithm];
  if (!hash || !issuer.namedCurve) return false;
  const raw = derEcdsaSignatureToRaw(certificate.signature, issuer.namedCurve);
  if (!raw) return false;
  try {
    const key = await crypto.subtle.importKey(
      "spki",
      bufferSource(issuer.spki),
      { name: "ECDSA", namedCurve: issuer.namedCurve },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      { name: "ECDSA", hash },
      key,
      bufferSource(raw),
      bufferSource(certificate.tbs),
    );
  } catch {
    return false;
  }
}

/** Verify a detached ECDSA signature made by a certificate's subject key. */
export async function verifyWithCertificateKey(
  certificate: X509Certificate,
  signature: Uint8Array,
  data: Uint8Array,
  hash: "SHA-256" | "SHA-384" | "SHA-512" = "SHA-256",
): Promise<boolean> {
  if (!certificate.namedCurve) return false;
  // Signers may emit either encoding; DER is what Node's `crypto.sign`
  // produces and is what npm's Sigstore signer attaches.
  const raw =
    derEcdsaSignatureToRaw(signature, certificate.namedCurve) ??
    (signature.length === CURVE_COORDINATE_BYTES[certificate.namedCurve] * 2 ? signature : null);
  if (!raw) return false;
  try {
    const key = await crypto.subtle.importKey(
      "spki",
      bufferSource(certificate.spki),
      { name: "ECDSA", namedCurve: certificate.namedCurve },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      { name: "ECDSA", hash },
      key,
      bufferSource(raw),
      bufferSource(data),
    );
  } catch {
    return false;
  }
}

/**
 * Copy a view into a standalone buffer for WebCrypto. Views produced here are
 * subarrays of a larger certificate, and `SubtleCrypto` will not accept a view
 * whose backing buffer might be shared.
 */
function bufferSource(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

/** Decode a single PEM block to DER. */
export function pemToDer(pem: string): Uint8Array {
  const base64 = pem
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s+/g, "");
  return decodeBase64(base64);
}

/** Strict base64 decode that rejects anything outside the alphabet. */
export function decodeBase64(value: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new DerError("value is not base64");
  }
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
