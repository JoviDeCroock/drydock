import { base64Encode, hexEncode } from "../platform/crypto-utils";
import type { CanaryFile, CanaryKind } from "./types";

/**
 * Fake credentials planted in the detonation container.
 *
 * They are shaped like the real thing because credential stealers select by
 * prefix and length (`npm_…`, `ghp_…`, `AKIA…`), but they are random per run
 * and authorize nothing. Seeing one leave the container is the strongest
 * signal a detonation can produce: no benign install script has a reason to
 * send a registry token anywhere.
 */
export interface CanarySet {
  env: Record<string, string>;
  files: CanaryFile[];
  /** Raw secret values, one per kind, that `DetonationEgress` scans for. */
  values: Array<{ kind: CanaryKind; value: string }>;
}

export const DETONATION_HOME = "/home/pkg";

const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const UPPER_ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function randomFrom(alphabet: string, length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = "";
  for (const byte of bytes) out += alphabet[byte % alphabet.length];
  return out;
}

export function generateCanaries(): CanarySet {
  const npmToken = `npm_${randomFrom(ALNUM, 36)}`;
  const githubToken = `ghp_${randomFrom(ALNUM, 36)}`;
  const awsKeyId = `AKIA${randomFrom(UPPER_ALNUM, 16)}`;
  const awsSecret = randomFrom(ALNUM, 40);
  const oidcToken = randomFrom(ALNUM, 40);
  const sshMarker = randomFrom(ALNUM, 48);
  // PyPI API tokens are macaroons whose base64 always opens with the encoded
  // `pypi.org` location, which is the prefix stealers grep for.
  const pypiToken = `pypi-AgEIcHlwaS5vcmc${randomFrom(ALNUM, 64)}`;

  return {
    env: {
      // A release workflow is what worms like Shai-Hulud look for before
      // acting, so the run looks like one.
      CI: "true",
      GITHUB_ACTIONS: "true",
      GITHUB_REPOSITORY: "acme-corp/release-tools",
      GITHUB_WORKFLOW: "release",
      GITHUB_REF: "refs/heads/main",
      RUNNER_OS: "Linux",
      NPM_TOKEN: npmToken,
      NODE_AUTH_TOKEN: npmToken,
      PYPI_API_TOKEN: pypiToken,
      TWINE_USERNAME: "__token__",
      TWINE_PASSWORD: pypiToken,
      GITHUB_TOKEN: githubToken,
      AWS_ACCESS_KEY_ID: awsKeyId,
      AWS_SECRET_ACCESS_KEY: awsSecret,
      // `.invalid` can never resolve, so even an unsinkholed request goes nowhere.
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://pipelines.actions.drydock.invalid/idtoken",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: oidcToken,
    },
    files: [
      {
        path: `${DETONATION_HOME}/.npmrc`,
        content: `//registry.npmjs.org/:_authToken=${npmToken}\n`,
        mode: 0o600,
      },
      {
        path: `${DETONATION_HOME}/.aws/credentials`,
        content: `[default]\naws_access_key_id = ${awsKeyId}\naws_secret_access_key = ${awsSecret}\n`,
        mode: 0o600,
      },
      {
        path: `${DETONATION_HOME}/.config/gh/hosts.yml`,
        content: `github.com:\n    oauth_token: ${githubToken}\n    user: release-bot\n`,
        mode: 0o600,
      },
      {
        path: `${DETONATION_HOME}/.git-credentials`,
        content: `https://release-bot:${githubToken}@github.com\n`,
        mode: 0o600,
      },
      {
        path: `${DETONATION_HOME}/.ssh/id_ed25519`,
        content: `-----BEGIN OPENSSH PRIVATE KEY-----\n${sshMarker}\n-----END OPENSSH PRIVATE KEY-----\n`,
        mode: 0o600,
      },
      {
        path: `${DETONATION_HOME}/.pypirc`,
        content: `[distutils]\nindex-servers =\n    pypi\n\n[pypi]\nusername = __token__\npassword = ${pypiToken}\n`,
        mode: 0o600,
      },
    ],
    values: [
      { kind: "npm-token", value: npmToken },
      { kind: "pypi-token", value: pypiToken },
      { kind: "github-token", value: githubToken },
      { kind: "aws-key", value: awsKeyId },
      { kind: "aws-key", value: awsSecret },
      { kind: "ci-oidc", value: oidcToken },
      { kind: "ssh-key", value: sshMarker },
    ],
  };
}

export interface CanaryNeedle {
  kind: CanaryKind;
  needle: string;
}

// Shorter fragments of a 36+ character random value start matching unrelated
// base64 text by chance.
const MIN_NEEDLE_LENGTH = 16;

/**
 * Base64 of a value embedded at an unknown offset in a larger payload only
 * agrees with `base64(value)` once the encoder's 3-byte groups line up, so
 * emit the stable middle for each of the three possible alignments.
 */
function base64Alignments(value: string): string[] {
  const bytes = new TextEncoder().encode(value);
  const out: string[] = [];
  for (let offset = 0; offset < 3; offset++) {
    const padded = new Uint8Array(offset + bytes.length);
    padded.set(bytes, offset);
    const encoded = base64Encode(padded);
    // Characters touched by the zero prefix, and by the final partial group.
    const start = offset === 0 ? 0 : offset + 1;
    const end = Math.floor(padded.length / 3) * 4;
    const needle = encoded.slice(start, end);
    if (needle.length >= MIN_NEEDLE_LENGTH) out.push(needle);
  }
  return out;
}

/**
 * Every encoding of every canary the egress scan looks for: raw, URL-encoded,
 * hex, base64 (standard and URL-safe), and double base64, the encoding the
 * Shai-Hulud worm used to smuggle secrets into a public repository.
 */
export function canaryNeedles(values: CanarySet["values"]): CanaryNeedle[] {
  const needles = new Map<string, CanaryKind>();
  const add = (kind: CanaryKind, needle: string) => {
    if (needle.length >= MIN_NEEDLE_LENGTH && !needles.has(needle)) needles.set(needle, kind);
  };
  for (const { kind, value } of values) {
    add(kind, value);
    add(kind, encodeURIComponent(value));
    add(kind, hexEncode(new TextEncoder().encode(value)));
    for (const once of base64Alignments(value)) {
      add(kind, once);
      add(kind, once.replaceAll("+", "-").replaceAll("/", "_"));
      for (const twice of base64Alignments(once)) add(kind, twice);
    }
  }
  return Array.from(needles, ([needle, kind]) => ({ kind, needle }));
}

export function findCanaryKinds(text: string, needles: readonly CanaryNeedle[]): CanaryKind[] {
  const hits = new Set<CanaryKind>();
  for (const { kind, needle } of needles) {
    if (!hits.has(kind) && text.includes(needle)) hits.add(kind);
  }
  return Array.from(hits);
}

export function redactCanaries(text: string, needles: readonly CanaryNeedle[]): string {
  let out = text;
  for (const { kind, needle } of needles) {
    if (out.includes(needle)) out = out.replaceAll(needle, `[canary:${kind}]`);
  }
  return out;
}
