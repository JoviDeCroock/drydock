import {
  decodeBase64,
  decodeDerString,
  parseX509,
  pemToDer,
  verifyCertificateSignature,
  verifyWithCertificateKey,
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
 *  - Rekor inclusion is **not** verified. The transparency-log entry supplies
 *    only the signing timestamp used to evaluate the short-lived leaf's
 *    validity window, and that timestamp comes from the record. It cannot
 *    manufacture a signature: the leaf is Fulcio-issued for a specific
 *    repository and its private key is ephemeral and never persisted, so a
 *    forged timestamp buys nothing beyond skipping an expiry check.
 *  - Nothing here is bound to the reviewed bytes. Verification is intrinsic to
 *    the bundle; `./findings.ts` compares the attested subject and digest
 *    against the artifact the sandbox actually parsed.
 */

/**
 * Cache-identity segment for provenance verification. Bump when a bundle
 * accepted by an older deployment would be rejected now, so a cached verdict
 * cannot outlive the rules that produced it.
 */
export const ATPM_PROVENANCE_RULES_VERSION = "1";

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
  /** Rekor log index, when the bundle carries one. Not independently verified. */
  logIndex: string | null;
  /** Signing time taken from the transparency-log entry, when readable. */
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

  const signedAt = transparencyLogTime(material);
  // Fulcio leaves live about ten minutes, so a release staged and approved days
  // apart is normally verified long after its certificate expired. The window
  // is therefore evaluated at signing time, as recorded by the transparency-log
  // entry, falling back to now when the bundle carries no readable timestamp.
  const reference = signedAt ?? new Date();
  if (reference < leaf.notBefore || reference > leaf.notAfter) {
    return invalid("signing certificate was not valid when the signature was made");
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
      workflowPath: workflowPath(leaf, sourceRepository, statement.predicate),
      runInvocation: extensionString(leaf, OID_RUN_INVOCATION_URI),
      runnerEnvironment: extensionString(leaf, OID_RUNNER_ENVIRONMENT),
      repositoryVisibility: extensionString(leaf, OID_SOURCE_REPO_VISIBILITY),
      subjectName: statement.subjectName,
      subjectSha512: statement.subjectSha512,
      logIndex: transparencyLogIndex(material),
      signedAt: signedAt?.toISOString() ?? null,
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
  predicate: Record<string, unknown> | null;
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
  return { subjectName, subjectSha512: sha512, predicate: asObject(statement.predicate) };
}

/**
 * The workflow file the build ran. Fulcio's build-config URI is preferred — it
 * is inside the signed certificate — with the SLSA predicate as a fallback for
 * bundles issued before that extension existed. The predicate is signed too,
 * but by the same key, so neither is more trustworthy than the other; the
 * certificate is simply the more constrained shape.
 */
function workflowPath(
  leaf: X509Certificate,
  sourceRepository: string,
  predicate: Record<string, unknown> | null,
): string | null {
  const buildConfig = extensionString(leaf, OID_BUILD_CONFIG_URI);
  if (buildConfig?.startsWith(`${sourceRepository}/`)) {
    const rest = buildConfig.slice(sourceRepository.length + 1);
    const path = rest.split("@")[0];
    if (path.startsWith(".github/workflows/")) return path;
  }
  const external = asObject(asObject(predicate?.buildDefinition)?.externalParameters);
  const workflow = asObject(external?.workflow);
  if (typeof workflow?.path === "string" && workflow.path) return workflow.path;
  const entryPoint = asObject(predicate?.invocation)?.configSource;
  const legacy = asObject(entryPoint)?.entryPoint;
  return typeof legacy === "string" && legacy ? legacy : null;
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

function transparencyLogIndex(material: Record<string, unknown>): string | null {
  const raw = transparencyLogEntry(material)?.logIndex;
  if (typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0) return String(raw);
  if (typeof raw === "string" && /^\d{1,19}$/.test(raw)) return raw;
  return null;
}

/**
 * When the signature was made, per the transparency-log entry.
 *
 * The protobuf JSON mapping renders `integratedTime` (an int64 of seconds) as a
 * decimal string, but bundles produced by other tooling have been seen carrying
 * an RFC 3339 timestamp in the same field. Both are read; anything else is
 * treated as absent rather than guessed at.
 */
function transparencyLogTime(material: Record<string, unknown>): Date | null {
  const raw = transparencyLogEntry(material)?.integratedTime;
  if (typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0) {
    return new Date(raw * 1000);
  }
  if (typeof raw !== "string" || !raw) return null;
  if (/^\d{1,12}$/.test(raw)) return new Date(Number(raw) * 1000);
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed) : null;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
