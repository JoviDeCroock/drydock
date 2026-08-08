// Signed Sigstore-bundle fixtures, shared by the build-attestation unit specs
// and the workflow-gate worker specs.
//
// The bundles are *really* signed: a fresh P-256 key signs the actual DSSE PAE
// bytes, and its public key is carried in a DER certificate the parser has to
// walk exactly as it walks a Fulcio leaf. A fixture with a faked signature
// would leave the PAE encoding, the certificate walk, and the DER→P1363
// signature conversion untested — and each of those failing silently degrades
// every real attestation to `partial` instead of breaking loudly.

import { dssePae } from "../../server/lib/build-attestation";

export const FIXTURE_REPOSITORY = "acme/widgets";
export const FIXTURE_RUN_ID = "8675309";
export const FIXTURE_COMMIT = "a".repeat(40);

function der(tag: number, content: Uint8Array): Uint8Array {
  const length =
    content.length < 0x80
      ? Uint8Array.from([content.length])
      : content.length < 0x100
        ? Uint8Array.from([0x81, content.length])
        : Uint8Array.from([0x82, content.length >> 8, content.length & 0xff]);
  const out = new Uint8Array(1 + length.length + content.length);
  out[0] = tag;
  out.set(length, 1);
  out.set(content, 1 + length.length);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * Wrap a real SPKI in a certificate shell with the field layout RFC 5280
 * specifies, so the parser has to count past `[0] version`, serialNumber,
 * signature, issuer, validity and subject to reach it. The skipped fields are
 * placeholders — the parser never reads their contents.
 */
function certificateWrapping(spki: Uint8Array): Uint8Array {
  const placeholder = der(0x30, new Uint8Array(0));
  const tbs = der(
    0x30,
    concat(
      der(0xa0, der(0x02, Uint8Array.from([2]))), // [0] version v3
      der(0x02, Uint8Array.from([1])), // serialNumber
      placeholder, // signature
      placeholder, // issuer
      placeholder, // validity
      placeholder, // subject
      spki,
    ),
  );
  return der(0x30, concat(tbs, placeholder, der(0x03, Uint8Array.from([0x00]))));
}

/** WebCrypto emits raw r||s; Sigstore carries DER. Re-encode for the fixture. */
function rawEcdsaSignatureToDer(raw: Uint8Array): Uint8Array {
  const half = raw.length / 2;
  const encodeInteger = (value: Uint8Array) => {
    let start = 0;
    while (start < value.length - 1 && value[start] === 0) start += 1;
    const magnitude = value.subarray(start);
    // DER integers are signed: a leading high bit needs a zero pad.
    const padded = magnitude[0] & 0x80 ? concat(Uint8Array.from([0]), magnitude) : magnitude;
    return der(0x02, padded);
  };
  return der(0x30, concat(encodeInteger(raw.subarray(0, half)), encodeInteger(raw.subarray(half))));
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export interface StatementOverrides {
  repository?: string;
  runId?: string;
  commit?: string;
  digests?: string[];
  predicateType?: string;
  predicate?: unknown;
}

export function slsaV1Statement(overrides: StatementOverrides = {}) {
  const repository = overrides.repository ?? `https://github.com/${FIXTURE_REPOSITORY}`;
  const runId = overrides.runId ?? FIXTURE_RUN_ID;
  return {
    _type: "https://in-toto.io/Statement/v1",
    subject: (overrides.digests ?? []).map((digest, index) => ({
      name: `pkg:generic/artifact-${index}`,
      digest: { sha256: digest },
    })),
    predicateType: overrides.predicateType ?? "https://slsa.dev/provenance/v1",
    predicate: overrides.predicate ?? {
      buildDefinition: {
        buildType: "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
        externalParameters: {
          workflow: {
            ref: "refs/heads/main",
            repository,
            path: ".github/workflows/release.yml",
          },
        },
        resolvedDependencies: [
          {
            uri: `git+${repository}@refs/heads/main`,
            digest: { gitCommit: overrides.commit ?? FIXTURE_COMMIT },
          },
        ],
      },
      runDetails: {
        builder: { id: "https://github.com/actions/runner/github-hosted" },
        metadata: { invocationId: `${repository}/actions/runs/${runId}/attempts/1` },
      },
    },
  };
}

export async function signedBundle(
  statement: unknown,
  options: { tamperSignature?: boolean; omitCertificate?: boolean } = {},
): Promise<Record<string, unknown>> {
  const keyPair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", keyPair.publicKey));

  const payload = new TextEncoder().encode(JSON.stringify(statement));
  const payloadType = "application/vnd.in-toto+json";
  const rawSignature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      keyPair.privateKey,
      dssePae(payloadType, payload),
    ),
  );
  if (options.tamperSignature) rawSignature[0] ^= 0xff;

  return {
    mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
    verificationMaterial: options.omitCertificate
      ? {}
      : { certificate: { rawBytes: toBase64(certificateWrapping(spki)) } },
    dsseEnvelope: {
      payload: toBase64(payload),
      payloadType,
      signatures: [{ sig: toBase64(rawEcdsaSignatureToDer(rawSignature)) }],
    },
  };
}
