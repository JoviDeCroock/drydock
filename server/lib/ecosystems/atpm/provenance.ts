import {
  decodeBase64,
  decodeDerString,
  parseX509,
  pemToDer,
  verifyCertificateSignature,
  verifyWithCertificateKey,
  verifyWithSpkiKey,
  type X509Certificate,
} from "../../platform/x509";

/**
 * Build provenance for an atpm release, verified here rather than taken from
 * the record.
 *
 * atpm supports npm-style trusted publishing: a GitHub Actions workflow proves
 * its identity with an OIDC token, atpm mints a short-lived scoped credential,
 * and `npm stage publish --provenance` attaches a Sigstore bundle to the
 * version. atpm verifies that bundle when the version is staged. What it stores
 * afterwards is a copy of the bundle inside a record the publisher can rewrite,
 * so "atpm accepted this" is not something a reader of the record can check.
 *
 * The bundle itself is checkable, and that is the whole point of it. A Fulcio
 * certificate binds an ephemeral signing key to the GitHub Actions identity
 * that requested it — repository, workflow ref, commit, run — and the DSSE
 * envelope binds that key to a statement naming one artifact and its SHA-512.
 * Re-verifying both here means the claim on a `/diff` page rests on Sigstore's
 * root, not on atpm.dev, the publisher's PDS, or the record's own honesty. It is
 * the same argument as resolving identity over the protocol instead of through
 * the App View (see `./identity.ts`).
 *
 * Scope, stated plainly because it bounds what the page may claim:
 *
 *  - The certificate chain is checked against a *pinned* Fulcio root and
 *    intermediate. There is no chain building and no certificate store, so a
 *    Fulcio intermediate rotation is a code change here, and fails closed
 *    (bundles read as unverifiable) until it happens.
 *  - A Rekor signed-entry timestamp is verified against a pinned transparency-
 *    log key before its integrated time may evaluate the short-lived leaf's
 *    validity window. The Merkle inclusion proof is not independently checked;
 *    this verifies the log's signed promise that it accepted the entry.
 *  - Nothing here is bound to the reviewed bytes. Verification is intrinsic to
 *    the bundle; `./findings.ts` compares the attested subject and digest
 *    against the artifact the sandbox actually parsed.
 */

/**
 * Cache-identity segment for provenance verification. Bump when a bundle
 * accepted by an older deployment would be rejected now, so a cached verdict
 * cannot outlive the rules that produced it.
 */
export const ATPM_PROVENANCE_RULES_VERSION = "4";

/** Fulcio's public-good root (https://fulcio.sigstore.dev/api/v1/rootCert). */
const FULCIO_ROOT_PEM = `-----BEGIN CERTIFICATE-----
MIIB9zCCAXygAwIBAgIUALZNAPFdxHPwjeDloDwyYChAO/4wCgYIKoZIzj0EAwMw
KjEVMBMGA1UEChMMc2lnc3RvcmUuZGV2MREwDwYDVQQDEwhzaWdzdG9yZTAeFw0y
MTEwMDcxMzU2NTlaFw0zMTEwMDUxMzU2NThaMCoxFTATBgNVBAoTDHNpZ3N0b3Jl
LmRldjERMA8GA1UEAxMIc2lnc3RvcmUwdjAQBgcqhkjOPQIBBgUrgQQAIgNiAAT7
XeFT4rb3PQGwS4IajtLk3/OlnpgangaBclYpsYBr5i+4ynB07ceb3LP0OIOZdxex
X69c5iVuyJRQ+Hz05yi+UF3uBWAlHpiS5sh0+H2GHE7SXrk1EC5m1Tr19L9gg92j
YzBhMA4GA1UdDwEB/wQEAwIBBjAPBgNVHRMBAf8EBTADAQH/MB0GA1UdDgQWBBRY
wB5fkUWlZql6zJChkyLQKsXF+jAfBgNVHSMEGDAWgBRYwB5fkUWlZql6zJChkyLQ
KsXF+jAKBggqhkjOPQQDAwNpADBmAjEAj1nHeXZp+13NWBNa+EDsDP8G1WWg1tCM
WP/WHPqpaVo0jhsweNFZgSs0eE7wYI4qAjEA2WB9ot98sIkoF3vZYdd3/VtWB5b9
TNMea7Ix/stJ5TfcLLeABLE4BNJOsQ4vnBHJ
-----END CERTIFICATE-----`;

/**
 * Fulcio intermediates that may issue a signing certificate. A list rather than
 * a constant so a Sigstore rotation is one appended PEM: certificates issued
 * under a retired intermediate must keep verifying.
 */
const FULCIO_INTERMEDIATE_PEMS = [
  `-----BEGIN CERTIFICATE-----
MIICGjCCAaGgAwIBAgIUALnViVfnU0brJasmRkHrn/UnfaQwCgYIKoZIzj0EAwMw
KjEVMBMGA1UEChMMc2lnc3RvcmUuZGV2MREwDwYDVQQDEwhzaWdzdG9yZTAeFw0y
MjA0MTMyMDA2MTVaFw0zMTEwMDUxMzU2NThaMDcxFTATBgNVBAoTDHNpZ3N0b3Jl
LmRldjEeMBwGA1UEAxMVc2lnc3RvcmUtaW50ZXJtZWRpYXRlMHYwEAYHKoZIzj0C
AQYFK4EEACIDYgAE8RVS/ysH+NOvuDZyPIZtilgUF9NlarYpAd9HP1vBBH1U5CV7
7LSS7s0ZiH4nE7Hv7ptS6LvvR/STk798LVgMzLlJ4HeIfF3tHSaexLcYpSASr1kS
0N/RgBJz/9jWCiXno3sweTAOBgNVHQ8BAf8EBAMCAQYwEwYDVR0lBAwwCgYIKwYB
BQUHAwMwEgYDVR0TAQH/BAgwBgEB/wIBADAdBgNVHQ4EFgQU39Ppz1YkEZb5qNjp
KFWixi4YZD8wHwYDVR0jBBgwFoAUWMAeX5FFpWapesyQoZMi0CrFxfowCgYIKoZI
zj0EAwMDZwAwZAIwPCsQK4DYiZYDPIaDi5HFKnfxXx6ASSVmERfsynYBiX2X6SJR
nZU84/9DZdnFvvxmAjBOt6QpBlc4J/0DxvkTCqpclvziL6BCCPnjdlIB3Pu3BxsP
mygUY7Ii2zbdCdliiow=
-----END CERTIFICATE-----`,
];

/**
 * Sigstore's public-good Rekor keys, copied from its signed trusted root.
 * Like the Fulcio anchors above, rotations are explicit code changes so a
 * publisher-controlled bundle cannot nominate its own timestamp authority.
 */
const REKOR_LOG_KEYS = [
  {
    keyId: "wNI9atQGlz+VWfO6LRygH4QUfY/8W4RFwiT5i5WRgB0=",
    spki: "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE2G2Y+2tabdTV5BcGiBIx0a9fAFwrkBbmLSGtks4L3qX6yYY0zufBnhC8Ur/iy55GhWP/9A/bY2LhC30M9+RYtw==",
    validFrom: Date.parse("2021-01-12T11:53:27Z"),
    algorithm: { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" } as const,
  },
  {
    keyId: "zxGZFVvd0FEmjR8WrFwMdcAJ9vtaY/QXf44Y1wUeP6A=",
    spki: "MCowBQYDK2VwAyEAt8rlp1knGwjfbcXAYPYAkn0XiLz1x8O4t0YkEhie244=",
    validFrom: Date.parse("2025-09-23T00:00:00Z"),
    algorithm: { name: "Ed25519" } as const,
  },
] as const;

// Fulcio extension OIDs (https://github.com/sigstore/fulcio/blob/main/docs/oid-info.md)
const OID_ISSUER = "1.3.6.1.4.1.57264.1.8";
const OID_RUNNER_ENVIRONMENT = "1.3.6.1.4.1.57264.1.11";
const OID_SOURCE_REPO_URI = "1.3.6.1.4.1.57264.1.12";
const OID_SOURCE_REPO_DIGEST = "1.3.6.1.4.1.57264.1.13";
const OID_SOURCE_REPO_REF = "1.3.6.1.4.1.57264.1.14";
const OID_BUILD_CONFIG_URI = "1.3.6.1.4.1.57264.1.18";
const OID_RUN_INVOCATION_URI = "1.3.6.1.4.1.57264.1.21";
const OID_SOURCE_REPO_VISIBILITY = "1.3.6.1.4.1.57264.1.22";

const GITHUB_ACTIONS_ISSUER = "https://token.actions.githubusercontent.com";

const SUPPORTED_BUNDLE_MEDIA_TYPES = new Set([
  "application/vnd.dev.sigstore.bundle.v0.1+json",
  "application/vnd.dev.sigstore.bundle.v0.2+json",
  "application/vnd.dev.sigstore.bundle.v0.3+json",
  "application/vnd.dev.sigstore.bundle+json;version=0.1",
  "application/vnd.dev.sigstore.bundle+json;version=0.2",
  "application/vnd.dev.sigstore.bundle+json;version=0.3",
]);

const IN_TOTO_PAYLOAD_TYPE = "application/vnd.in-toto+json";
const IN_TOTO_STATEMENT_TYPES = new Set([
  "https://in-toto.io/Statement/v0.1",
  "https://in-toto.io/Statement/v1",
]);

/**
 * A DSSE payload is an in-toto statement — a few kilobytes of JSON. This bounds
 * how much a record can make the parent Worker decode and parse per version.
 */
const MAX_PAYLOAD_BASE64_LENGTH = 512 * 1024;
const MAX_TLOG_BODY_BASE64_LENGTH = 1024 * 1024;

/** Verified build facts, small enough to cache alongside the pruned record. */
export interface AtpmProvenance {
  /** Source repository from the Fulcio certificate, e.g. `https://github.com/owner/repo`. */
  sourceRepository: string;
  /** Ref the build ran from, e.g. `refs/tags/v1.2.3`. */
  sourceRef: string | null;
  /** Commit the build ran from. */
  sourceCommit: string | null;
  /** Workflow file the certificate was issued for, e.g. `.github/workflows/publish.yml`. */
  workflowPath: string | null;
  /** GitHub Actions run the certificate was issued to. */
  runInvocation: string | null;
  /** `github-hosted` or `self-hosted`, as Fulcio recorded it. */
  runnerEnvironment: string | null;
  /** Repository visibility at signing time, as Fulcio recorded it. */
  repositoryVisibility: string | null;
  /** in-toto subject name — an npm purl, `pkg:npm/%40handle/name@version`. */
  subjectName: string;
  /** SHA-512 the statement binds as the artifact's digest, lowercase hex. */
  subjectSha512: string;
  /** Rekor log index authenticated by the log's signed-entry timestamp. */
  logIndex: string | null;
  /** Signing time authenticated by the log's signed-entry timestamp. */
  signedAt: string | null;
}

export type AtpmProvenanceState =
  /** The version carries no attestation at all. */
  | { status: "absent" }
  /** A bundle is present and verified against the pinned Sigstore root. */
  | { status: "verified"; provenance: AtpmProvenance }
  /** A bundle is present and does not verify; `reason` is safe to display. */
  | { status: "invalid"; reason: string }
  /** Verification was not attempted (see the per-record cap in `./record.ts`). */
  | { status: "not-evaluated" };

const NOT_EVALUATED: AtpmProvenanceState = { status: "not-evaluated" };
export const ATPM_PROVENANCE_ABSENT: AtpmProvenanceState = { status: "absent" };
export const ATPM_PROVENANCE_NOT_EVALUATED = NOT_EVALUATED;

function invalid(reason: string): AtpmProvenanceState {
  return { status: "invalid", reason };
}

/** npm-package-arg's `toPurl`, which is what npm's provenance subject uses. */
export function atpmPurl(name: string, version: string): string {
  return `pkg:npm/${name.replace(/^@/, "%40")}@${version}`;
}

/**
 * Read the Sigstore bundle a version's record entry carries, if any.
 *
 * `meta.dist.attestations` is npm's shape, and atpm stores exactly what npm
 * handed it. Anything else in `meta` is publisher-written data we do not read.
 */
export function readAtpmAttestation(meta: unknown): unknown {
  if (!meta || typeof meta !== "object") return null;
  const dist = (meta as Record<string, unknown>).dist;
  if (!dist || typeof dist !== "object") return null;
  const attestations = (dist as Record<string, unknown>).attestations;
  if (!attestations || typeof attestations !== "object") return null;
  const provenance = (attestations as Record<string, unknown>).provenance;
  return provenance && typeof provenance === "object" ? provenance : null;
}

let pinnedAnchors: Promise<X509Certificate[]> | null = null;

/**
 * The Fulcio intermediates that may issue a leaf, each proven against the
 * pinned root before it is used. Resolved once per isolate: the inputs are
 * compile-time constants, so re-deriving them per bundle would only repeat the
 * same two signature checks.
 */
function trustedIssuers(): Promise<X509Certificate[]> {
  pinnedAnchors ??= (async () => {
    const root = parseX509(pemToDer(FULCIO_ROOT_PEM));
    const issuers: X509Certificate[] = [];
    for (const pem of FULCIO_INTERMEDIATE_PEMS) {
      const intermediate = parseX509(pemToDer(pem));
      if (await verifyCertificateSignature(intermediate, root)) issuers.push(intermediate);
    }
    return issuers;
  })();
  return pinnedAnchors;
}

/**
 * Verify a Sigstore bundle on its own terms: chain, signature, and statement
 * shape. Never throws — every malformed input becomes an `invalid` verdict with
 * a reason, because the input is publisher-written and a thrown error would
 * turn one bad record into a failed page.
 */
export async function verifyAtpmProvenance(raw: unknown): Promise<AtpmProvenanceState> {
  if (raw === null || raw === undefined) return ATPM_PROVENANCE_ABSENT;
  if (typeof raw !== "object") return invalid("attestation is not an object");
  const bundle = raw as Record<string, unknown>;

  try {
    return await verifyBundle(bundle);
  } catch {
    return invalid("attestation could not be read");
  }
}

async function verifyBundle(bundle: Record<string, unknown>): Promise<AtpmProvenanceState> {
  const mediaType = typeof bundle.mediaType === "string" ? bundle.mediaType : "";
  if (!SUPPORTED_BUNDLE_MEDIA_TYPES.has(mediaType)) {
    return invalid(`unsupported bundle media type ${mediaType || "(absent)"}`);
  }

  const material = asObject(bundle.verificationMaterial);
  const envelope = asObject(bundle.dsseEnvelope);
  if (!material || !envelope) return invalid("bundle is missing its signature material");

  const certificateBase64 = readLeafCertificate(material);
  if (!certificateBase64) return invalid("bundle carries no signing certificate");

  let leaf: X509Certificate;
  try {
    leaf = parseX509(decodeBase64(certificateBase64));
  } catch {
    return invalid("signing certificate is not a readable X.509 certificate");
  }

  // Only the pinned issuers are consulted. A bundle also ships its own chain,
  // and trusting that would make the record self-certifying.
  const issuers = await trustedIssuers();
  let issued = false;
  for (const issuer of issuers) {
    if (await verifyCertificateSignature(leaf, issuer)) {
      issued = true;
      break;
    }
  }
  if (!issued) {
    return invalid("signing certificate does not chain to the pinned Sigstore root");
  }

  const payloadBase64 = typeof envelope.payload === "string" ? envelope.payload : "";
  if (!payloadBase64 || payloadBase64.length > MAX_PAYLOAD_BASE64_LENGTH) {
    return invalid("bundle payload is missing or too large");
  }
  const payloadType = typeof envelope.payloadType === "string" ? envelope.payloadType : "";
  if (payloadType !== IN_TOTO_PAYLOAD_TYPE) {
    return invalid(`unsupported payload type ${payloadType || "(absent)"}`);
  }
  const signatures = Array.isArray(envelope.signatures) ? envelope.signatures : [];
  const signatureBase64 = asObject(signatures[0])?.sig;
  if (typeof signatureBase64 !== "string" || !signatureBase64) {
    return invalid("bundle carries no signature");
  }

  let payload: Uint8Array;
  let signature: Uint8Array;
  try {
    payload = decodeBase64(payloadBase64);
    signature = decodeBase64(signatureBase64);
  } catch {
    return invalid("bundle payload or signature is not base64");
  }

  const verified = await verifyWithCertificateKey(
    leaf,
    signature,
    preAuthenticationEncoding(payloadType, payload),
  );
  if (!verified) return invalid("bundle signature does not verify");

  const transparencyLog = await verifiedTransparencyLogEntry(material, envelope, certificateBase64);
  if (transparencyLog === false) {
    return invalid("transparency-log inclusion promise does not verify");
  }
  const signedAt = transparencyLog.signedAt;
  // Fulcio leaves live about ten minutes, so a release staged and approved days
  // apart is normally verified long after its certificate expired. The window
  // is therefore evaluated only at the timestamp authenticated by the
  // transparency log. A bundle with no authenticated entry is not verified.
  const reference = signedAt;
  if (reference < leaf.notBefore || reference > leaf.notAfter) {
    return invalid("signing certificate was not valid when the signature was made");
  }

  const statement = parseStatement(payload);
  if (!statement) return invalid("attested statement is not a readable in-toto statement");

  const issuer = extensionString(leaf, OID_ISSUER);
  if (issuer !== GITHUB_ACTIONS_ISSUER) {
    // atpm only mints credentials for GitHub Actions today. Another issuer is
    // not a forgery, but nothing here knows how to read its identity claims,
    // and presenting it as verified provenance would overstate what was checked.
    return invalid(`unsupported provenance issuer ${issuer ?? "(absent)"}`);
  }
  const sourceRepository = extensionString(leaf, OID_SOURCE_REPO_URI);
  if (!sourceRepository) {
    return invalid("signing certificate names no source repository");
  }

  return {
    status: "verified",
    provenance: {
      sourceRepository,
      sourceRef: extensionString(leaf, OID_SOURCE_REPO_REF),
      sourceCommit: extensionString(leaf, OID_SOURCE_REPO_DIGEST),
      workflowPath: workflowPath(leaf, sourceRepository),
      runInvocation: extensionString(leaf, OID_RUN_INVOCATION_URI),
      runnerEnvironment: extensionString(leaf, OID_RUNNER_ENVIRONMENT),
      repositoryVisibility: extensionString(leaf, OID_SOURCE_REPO_VISIBILITY),
      subjectName: statement.subjectName,
      subjectSha512: statement.subjectSha512,
      logIndex: transparencyLog.logIndex,
      signedAt: signedAt.toISOString(),
    },
  };
}

/** DSSE PAE: `DSSEv1 <len(type)> <type> <len(payload)> <payload>`. */
function preAuthenticationEncoding(payloadType: string, payload: Uint8Array): Uint8Array {
  const prefix = new TextEncoder().encode(
    `DSSEv1 ${payloadType.length} ${payloadType} ${payload.length} `,
  );
  const encoded = new Uint8Array(prefix.length + payload.length);
  encoded.set(prefix, 0);
  encoded.set(payload, prefix.length);
  return encoded;
}

function readLeafCertificate(material: Record<string, unknown>): string | null {
  const content = asObject(material.content);
  const candidates = [
    asObject(material.certificate)?.rawBytes,
    asObject(content?.certificate)?.rawBytes,
    firstChainCertificate(material.x509CertificateChain),
    firstChainCertificate(content?.x509CertificateChain),
    firstChainCertificate(material.certificateChain),
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate) return candidate;
  }
  return null;
}

function firstChainCertificate(chain: unknown): unknown {
  const certificates = asObject(chain)?.certificates;
  if (!Array.isArray(certificates)) return null;
  return asObject(certificates[0])?.rawBytes ?? null;
}

interface ParsedStatement {
  subjectName: string;
  subjectSha512: string;
}

function parseStatement(payload: Uint8Array): ParsedStatement | null {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return null;
  }
  const statement = asObject(value);
  if (!statement) return null;
  if (typeof statement._type !== "string" || !IN_TOTO_STATEMENT_TYPES.has(statement._type)) {
    return null;
  }
  // npm's publish attestation names exactly one subject. Several would make
  // "which of these is this release" a choice, and the choice would be the
  // attacker's.
  const subjects = Array.isArray(statement.subject) ? statement.subject : [];
  if (subjects.length !== 1) return null;
  const subject = asObject(subjects[0]);
  const subjectName = typeof subject?.name === "string" ? subject.name : null;
  const digest = asObject(subject?.digest);
  const sha512 = typeof digest?.sha512 === "string" ? digest.sha512.toLowerCase() : null;
  if (!subjectName || !sha512 || !/^[0-9a-f]{128}$/.test(sha512)) return null;
  return { subjectName, subjectSha512: sha512 };
}

/**
 * The workflow file the build ran, authenticated by Fulcio's build-config
 * certificate extension. The signed SLSA predicate is intentionally not a
 * fallback: the ephemeral signing key controls that payload, while the
 * certificate is the identity assertion Fulcio made after checking GitHub's
 * OIDC token.
 */
function workflowPath(leaf: X509Certificate, sourceRepository: string): string | null {
  const buildConfig = extensionString(leaf, OID_BUILD_CONFIG_URI);
  if (buildConfig?.startsWith(`${sourceRepository}/`)) {
    const rest = buildConfig.slice(sourceRepository.length + 1);
    const path = rest.split("@")[0];
    if (path.startsWith(".github/workflows/")) return path;
  }
  return null;
}

function extensionString(certificate: X509Certificate, oid: string): string | null {
  const value = certificate.extensions.get(oid);
  if (!value || !value.length) return null;
  const decoded = decodeDerString(value).trim();
  if (!decoded || decoded.length > 512 || hasControlCharacter(decoded)) return null;
  return decoded;
}

/**
 * Control characters would let a certificate inject line breaks into the
 * resolution trail and the finding evidence rendered from these values.
 * Checked by code point rather than by regex, which cannot spell a control
 * character class without tripping the lint rule that exists to catch the
 * accidental version of exactly this.
 */
function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function transparencyLogEntry(material: Record<string, unknown>): Record<string, unknown> | null {
  const entries = Array.isArray(material.tlogEntries) ? material.tlogEntries : [];
  return asObject(entries[0]);
}

function protobufUint64(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value !== "string" || !/^\d{1,19}$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function transparencyLogIndex(entry: Record<string, unknown>): number | null {
  return protobufUint64(entry.logIndex);
}

function transparencyLogTime(entry: Record<string, unknown>): Date | null {
  const seconds = protobufUint64(entry.integratedTime);
  if (seconds === null || seconds === 0) return null;
  const milliseconds = seconds * 1000;
  if (!Number.isSafeInteger(milliseconds)) return null;
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) ? date : null;
}

interface VerifiedTransparencyLogEntry {
  signedAt: Date;
  logIndex: string;
}

/**
 * Verify Rekor's Signed Entry Timestamp (SET), also called an inclusion
 * promise. Every verified bundle needs an authenticated entry: without one,
 * there is no trustworthy timestamp at which to evaluate the short-lived leaf.
 */
async function verifiedTransparencyLogEntry(
  material: Record<string, unknown>,
  envelope: Record<string, unknown>,
  certificateBase64: string,
): Promise<VerifiedTransparencyLogEntry | false> {
  const entry = transparencyLogEntry(material);
  if (!entry) return false;

  const signedAt = transparencyLogTime(entry);
  const logIndex = transparencyLogIndex(entry);
  const logId = asObject(entry.logId)?.keyId;
  const body = entry.canonicalizedBody;
  const promise = asObject(entry.inclusionPromise)?.signedEntryTimestamp;
  if (
    !signedAt ||
    logIndex === null ||
    typeof logId !== "string" ||
    typeof body !== "string" ||
    body.length > MAX_TLOG_BODY_BASE64_LENGTH ||
    typeof promise !== "string"
  ) {
    return false;
  }

  const trustedKey = REKOR_LOG_KEYS.find((candidate) => candidate.keyId === logId);
  if (!trustedKey || signedAt.getTime() < trustedKey.validFrom) return false;

  let keyIdBytes: Uint8Array;
  let spki: Uint8Array;
  let signature: Uint8Array;
  let bodyBytes: Uint8Array;
  try {
    keyIdBytes = decodeBase64(logId);
    spki = decodeBase64(trustedKey.spki);
    signature = decodeBase64(promise);
    bodyBytes = decodeBase64(body);
  } catch {
    return false;
  }

  // The promise authenticates `canonicalizedBody`, but its timestamp is useful
  // for this bundle only when that body names this envelope's signature and
  // payload. Otherwise an old, valid promise could be replayed alongside a new
  // signature made with a retained Fulcio leaf key.
  if (!(await transparencyLogBodyMatches(entry, bodyBytes, envelope, certificateBase64))) {
    return false;
  }

  // RFC 8785 sorts these four keys exactly as written. Their values are only
  // integers or base64/hex ASCII, so JSON.stringify is canonical for this
  // deliberately narrow payload without a general hostile-JSON canonicalizer.
  const payload = new TextEncoder().encode(
    JSON.stringify({
      body,
      integratedTime: Math.floor(signedAt.getTime() / 1000),
      logID: bytesToHex(keyIdBytes),
      logIndex,
    }),
  );
  const verified = await verifyWithSpkiKey(spki, signature, payload, trustedKey.algorithm);
  return verified ? { signedAt, logIndex: String(logIndex) } : false;
}

function bytesToHex(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) value += byte.toString(16).padStart(2, "0");
  return value;
}

export async function transparencyLogBodyMatches(
  entry: Record<string, unknown>,
  bodyBytes: Uint8Array,
  envelope: Record<string, unknown>,
  certificateBase64: string,
): Promise<boolean> {
  let body: Record<string, unknown> | null;
  try {
    body = asObject(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bodyBytes)));
  } catch {
    return false;
  }
  const kind = asObject(entry.kindVersion)?.kind;
  const version = asObject(entry.kindVersion)?.version;
  if (
    !body ||
    typeof kind !== "string" ||
    typeof version !== "string" ||
    body.kind !== kind ||
    body.apiVersion !== version
  ) {
    return false;
  }

  const payloadBase64 = envelope.payload;
  const signatures = Array.isArray(envelope.signatures) ? envelope.signatures : [];
  const signatureBase64 = asObject(signatures[0])?.sig;
  if (
    typeof payloadBase64 !== "string" ||
    !payloadBase64 ||
    payloadBase64.length > MAX_PAYLOAD_BASE64_LENGTH ||
    signatures.length !== 1 ||
    typeof signatureBase64 !== "string"
  ) {
    return false;
  }

  let payload: Uint8Array;
  let signature: Uint8Array;
  let certificate: Uint8Array;
  try {
    payload = decodeBase64(payloadBase64);
    signature = decodeBase64(signatureBase64);
    certificate = decodeBase64(certificateBase64);
  } catch {
    return false;
  }
  const digestInput = new Uint8Array(payload.length);
  digestInput.set(payload);
  const payloadDigest = new Uint8Array(await crypto.subtle.digest("SHA-256", digestInput));

  if (kind === "intoto" && version === "0.0.2") {
    const content = asObject(asObject(asObject(body.spec)?.content)?.envelope);
    const contentRoot = asObject(asObject(body.spec)?.content);
    const bodySignatures = Array.isArray(content?.signatures) ? content.signatures : [];
    const bodySignature = asObject(bodySignatures[0]);
    const payloadHash = asObject(contentRoot?.payloadHash);
    if (
      bodySignatures.length !== 1 ||
      payloadHash?.algorithm !== "sha256" ||
      typeof payloadHash.value !== "string" ||
      typeof bodySignature?.sig !== "string" ||
      typeof bodySignature.publicKey !== "string"
    ) {
      return false;
    }
    try {
      const encodedSignature = decodeBase64Text(bodySignature.sig);
      const certificatePem = decodeBase64Text(bodySignature.publicKey);
      return (
        bytesEqual(signature, decodeBase64(encodedSignature)) &&
        bytesEqual(payloadDigest, hexToBytes(payloadHash.value)) &&
        bytesEqual(certificate, pemToDer(certificatePem))
      );
    } catch {
      return false;
    }
  }

  if (kind === "dsse" && version === "0.0.1") {
    const spec = asObject(body.spec);
    const bodySignatures = Array.isArray(spec?.signatures) ? spec.signatures : [];
    const bodySignature = asObject(bodySignatures[0]);
    const payloadHash = asObject(spec?.payloadHash);
    if (
      bodySignatures.length !== 1 ||
      typeof bodySignature?.signature !== "string" ||
      typeof bodySignature.verifier !== "string" ||
      payloadHash?.algorithm !== "sha256" ||
      typeof payloadHash.value !== "string"
    ) {
      return false;
    }
    try {
      return (
        bytesEqual(signature, decodeBase64(bodySignature.signature)) &&
        bytesEqual(payloadDigest, hexToBytes(payloadHash.value)) &&
        rekorVerifierMatchesCertificate(bodySignature.verifier, certificate)
      );
    } catch {
      return false;
    }
  }

  if (kind === "dsse" && version === "0.0.2") {
    const spec = asObject(asObject(body.spec)?.dsseV002);
    const bodySignatures = Array.isArray(spec?.signatures) ? spec.signatures : [];
    const bodySignature = asObject(bodySignatures[0]);
    const payloadHash = asObject(spec?.payloadHash);
    const verifier = asObject(bodySignature?.verifier);
    const x509Certificate = asObject(verifier?.x509Certificate);
    if (
      bodySignatures.length !== 1 ||
      typeof bodySignature?.content !== "string" ||
      payloadHash?.algorithm !== "SHA2_256" ||
      typeof payloadHash.digest !== "string" ||
      typeof x509Certificate?.rawBytes !== "string"
    ) {
      return false;
    }
    try {
      return (
        bytesEqual(signature, decodeBase64(bodySignature.content)) &&
        bytesEqual(payloadDigest, decodeBase64(payloadHash.digest)) &&
        bytesEqual(certificate, decodeBase64(x509Certificate.rawBytes))
      );
    } catch {
      return false;
    }
  }

  return false;
}

function rekorVerifierMatchesCertificate(verifierBase64: string, certificate: Uint8Array): boolean {
  let verifier: Uint8Array;
  try {
    verifier = decodeBase64(verifierBase64);
  } catch {
    return false;
  }
  if (bytesEqual(verifier, certificate)) return true;

  try {
    const verifierPem = new TextDecoder("utf-8", { fatal: true }).decode(verifier);
    return bytesEqual(pemToDer(verifierPem), certificate);
  } catch {
    return false;
  }
}

function decodeBase64Text(value: string): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(decodeBase64(value));
}

function hexToBytes(value: string): Uint8Array {
  if (!/^[0-9a-fA-F]{64}$/.test(value)) throw new Error("invalid SHA-256 digest");
  const bytes = new Uint8Array(32);
  for (let i = 0; i < bytes.length; i++)
    bytes[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left[i] ^ right[i];
  return difference === 0;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
