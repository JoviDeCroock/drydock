import { base64UrlDecode, sha256Hex } from "../../platform/crypto-utils";
import { openSecret, sealSecret } from "../../platform/secret-box";
import { normalizePyPiProjectName } from "./manifest";

/**
 * PyPI API tokens for PEP 694 mode B (preview): stored per organization, bound
 * to one normalized project on one index, sealed at rest, and handed only to
 * `PyPiSessionGateway`.
 *
 * PyPI tokens are macaroons (`pypi-` + base64). Their caveats are plain JSON
 * inside the serialized bytes, so Drydock can check, without any network call,
 * that a token is restricted to the bound project. A token Drydock cannot prove
 * is project-scoped is refused: an account-wide token would let a compromised
 * Drydock upload any of the account's projects.
 */

const TOKEN_PREFIX = "pypi-";
const MIN_TOKEN_LENGTH = 32;
const MAX_TOKEN_LENGTH = 4096;
const TOKEN_BODY_RE = /^[A-Za-z0-9_\-+/=]+$/;

export type PyPiTokenScope =
  | { kind: "project"; projects: string[] }
  | { kind: "user" }
  | { kind: "unknown" };

/**
 * Read the project restriction from a token's caveats. Recognizes Warehouse's
 * current caveat encoding (`[1, ["project"]]` is ProjectName, `[3, "<user>"]`
 * is RequestUser) and the legacy v1 permissions object. Anything else is
 * `unknown`.
 */
export function inspectPyPiTokenScope(token: string): PyPiTokenScope {
  if (!token.startsWith(TOKEN_PREFIX)) return { kind: "unknown" };
  let bytes: Uint8Array;
  try {
    bytes = base64UrlDecode(
      token.slice(TOKEN_PREFIX.length).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
    );
  } catch {
    return { kind: "unknown" };
  }
  const text = new TextDecoder("latin1").decode(bytes);
  const projects = new Set<string>();
  let user = false;
  for (const match of text.matchAll(/\[\s*1\s*,\s*\[([^\]]*)\]\s*\]/g)) {
    for (const name of match[1].matchAll(/"([^"]{1,214})"/g)) {
      projects.add(normalizePyPiProjectName(name[1]));
    }
  }
  for (const match of text.matchAll(/"projects"\s*:\s*\[([^\]]*)\]/g)) {
    for (const name of match[1].matchAll(/"([^"]{1,214})"/g)) {
      projects.add(normalizePyPiProjectName(name[1]));
    }
  }
  if (/\[\s*3\s*,\s*"/.test(text) || /"permissions"\s*:\s*"user"/.test(text)) user = true;
  if (projects.size > 0) return { kind: "project", projects: [...projects] };
  if (user) return { kind: "user" };
  return { kind: "unknown" };
}

/** Null when the token may be stored for `project`; otherwise why not. */
export function pyPiTokenProblem(token: string, project: string): string | null {
  if (!token.startsWith(TOKEN_PREFIX)) return "a PyPI API token starts with pypi-";
  if (token.length < MIN_TOKEN_LENGTH || token.length > MAX_TOKEN_LENGTH) {
    return "the PyPI API token has an unexpected length";
  }
  if (!TOKEN_BODY_RE.test(token.slice(TOKEN_PREFIX.length))) {
    return "the PyPI API token contains unexpected characters";
  }
  const scope = inspectPyPiTokenScope(token);
  const normalized = normalizePyPiProjectName(project);
  if (scope.kind === "user") {
    return "the token is scoped to an account; create a token scoped to this project only";
  }
  if (scope.kind === "unknown") {
    return "could not confirm the token is scoped to this project; create a project-scoped token";
  }
  if (scope.projects.length !== 1 || scope.projects[0] !== normalized) {
    return `the token is scoped to ${scope.projects.join(", ")}, not ${normalized}`;
  }
  return null;
}

/** A release target that can gate PyPI (pinned to it, or auto-detecting). */
export function releaseTargetGatesPyPi(ecosystem: string | null): boolean {
  return ecosystem === null || ecosystem === "pypi";
}

export interface SealedPyPiToken {
  tokenCiphertext: string;
  tokenNonce: string;
  tokenFingerprint: string;
  tokenLast4: string;
}

export async function sealPyPiToken(env: Cloudflare.Env, token: string): Promise<SealedPyPiToken> {
  const sealed = await sealSecret(env, "pypi-project-token", token);
  return {
    tokenCiphertext: sealed.ciphertext,
    tokenNonce: sealed.nonce,
    tokenFingerprint: (await sha256Hex(`pypi-project-token:${token}`)).slice(0, 16),
    tokenLast4: token.slice(-4),
  };
}

export async function openPyPiToken(
  env: Cloudflare.Env,
  sealed: { tokenCiphertext: string; tokenNonce: string },
): Promise<string> {
  return openSecret(env, "pypi-project-token", {
    ciphertext: sealed.tokenCiphertext,
    nonce: sealed.tokenNonce,
  });
}
