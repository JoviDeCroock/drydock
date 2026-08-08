import { base64UrlDecode } from "../platform/crypto-utils";
import { reliableFetch } from "../platform/reliable-fetch";

/**
 * GitHub Actions OIDC verification for the push-based CI ingest path.
 *
 * The pull-based workflow gate authenticates GitHub by verifying an HMAC
 * webhook signature and then *pulls* artifacts with an installation token. The
 * push path inverts that: a workflow job proves its own identity by presenting
 * a short-lived OIDC token minted by GitHub for that specific run, and pushes
 * the artifacts to us. Nothing in the repository holds a Drydock credential.
 *
 * What the token buys us is a machine-checked binding between the uploaded
 * bytes and `(repository, run, workflow, commit)`. That is strictly stronger
 * evidence than the gate webhook's "a signed delivery mentioned run 123",
 * because `job_workflow_ref` names the exact workflow file (and ref) that ran.
 *
 * Trust boundary: this module authenticates the *caller*. It says nothing about
 * the bytes that follow, which stay hostile evidence and are parsed only in the
 * credentials-free sandbox.
 */

const DEFAULT_ISSUER = "https://token.actions.githubusercontent.com";
const DEFAULT_AUDIENCE = "drydock";

// GitHub mints these with a few minutes of life. Allow a small skew for clock
// drift between GitHub's signer and the Workers runtime, but no more — a wide
// window is exactly what makes a leaked token useful to an attacker.
const CLOCK_SKEW_SECONDS = 60;

// A JWKS response is a handful of RSA public keys. Anything larger is either a
// misconfigured issuer override or someone trying to make us buffer a lot.
const MAX_JWKS_BYTES = 64 * 1024;

// GitHub rotates OIDC signing keys rarely, but a stale cache that outlives a
// rotation would reject every upload until it expired. Five minutes keeps the
// blast radius of a rotation short while still absorbing a release burst.
const JWKS_TTL_MS = 5 * 60 * 1000;

export type CiOidcErrorCode =
  | "token_missing"
  | "token_malformed"
  | "unsupported_algorithm"
  | "unknown_key"
  | "jwks_unavailable"
  | "signature_invalid"
  | "issuer_mismatch"
  | "audience_mismatch"
  | "token_expired"
  | "token_not_yet_valid"
  | "claims_missing";

export class CiOidcError extends Error {
  constructor(
    public code: CiOidcErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CiOidcError";
  }
}

/**
 * The subset of the GitHub Actions OIDC claim set we bind a release set to.
 *
 * `repositoryId` (not `repository`) is the authorization key: a repository can
 * be renamed or transferred, and a name-based lookup would let a new owner of a
 * freed-up name inherit the old repository's Drydock mapping.
 */
export interface GithubOidcClaims {
  subject: string;
  repository: string;
  repositoryId: number;
  repositoryOwner: string;
  runId: number;
  runAttempt: number;
  sha: string;
  ref: string;
  /** Workflow file + ref that GitHub started, e.g. `octo/a/.github/workflows/release.yml@refs/tags/v1`. */
  workflowRef: string;
  /** The job's *own* workflow ref: differs from `workflowRef` inside a reusable workflow. */
  jobWorkflowRef: string;
  actor: string;
  eventName: string;
  /** Only present when the job itself declares `environment:`; upload jobs usually do not. */
  environment: string | null;
  issuedAt: number;
  expiresAt: number;
}

export interface CiOidcConfig {
  issuer: string;
  audience: string;
  jwksUri: string;
}

export function readCiOidcConfig(env: Cloudflare.Env): CiOidcConfig {
  const issuer = normalizeIssuer(env.CI_OIDC_ISSUER?.trim() || DEFAULT_ISSUER);
  const audience = env.CI_OIDC_AUDIENCE?.trim() || DEFAULT_AUDIENCE;
  return { issuer, audience, jwksUri: `${issuer}/.well-known/jwks` };
}

function normalizeIssuer(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

/** Pull the bearer token out of an `Authorization` header. */
export function readBearerToken(header: string | null | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

interface JwtParts {
  header: { alg?: unknown; kid?: unknown; typ?: unknown };
  payload: Record<string, unknown>;
  signingInput: Uint8Array;
  signature: Uint8Array;
}

function decodeJwt(token: string): JwtParts {
  const segments = token.split(".");
  if (segments.length !== 3) {
    throw new CiOidcError("token_malformed", "OIDC token is not a three-segment JWT");
  }
  const [headerSegment, payloadSegment, signatureSegment] = segments;
  let header: JwtParts["header"];
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(new TextDecoder().decode(base64UrlDecode(headerSegment)));
    payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadSegment)));
  } catch {
    throw new CiOidcError("token_malformed", "OIDC token header/payload is not valid JSON");
  }
  if (!isObject(header) || !isObject(payload)) {
    throw new CiOidcError("token_malformed", "OIDC token header/payload is not an object");
  }
  return {
    header,
    payload,
    signingInput: new TextEncoder().encode(`${headerSegment}.${payloadSegment}`),
    signature: base64UrlDecode(signatureSegment),
  };
}

interface CachedJwks {
  keys: JsonWebKey[];
  expiresAtMs: number;
}

// Per-isolate memo. A Worker isolate serves many requests, so this absorbs the
// common case without a KV round trip; KV is the cross-isolate tier below.
const jwksMemo = new Map<string, CachedJwks>();

/** Test seam: drop the per-isolate JWKS memo so a suite can swap issuers. */
export function resetJwksCacheForTests(): void {
  jwksMemo.clear();
}

async function loadJwks(env: Cloudflare.Env, config: CiOidcConfig): Promise<JsonWebKey[]> {
  const nowMs = Date.now();
  const memo = jwksMemo.get(config.jwksUri);
  if (memo && memo.expiresAtMs > nowMs) return memo.keys;

  const cacheKey = `ci-oidc-jwks:${config.jwksUri}`;
  if (env.COMPARE_CACHE) {
    try {
      const cached = await env.COMPARE_CACHE.get(cacheKey, "json");
      const keys = readJwksKeys(cached);
      if (keys) {
        jwksMemo.set(config.jwksUri, { keys, expiresAtMs: nowMs + JWKS_TTL_MS });
        return keys;
      }
    } catch {
      // A cache miss or a malformed cached document must not block an upload;
      // fall through to the network fetch below.
    }
  }

  let response: Response;
  try {
    response = await reliableFetch(config.jwksUri, {
      headers: { Accept: "application/json", "User-Agent": "drydock-ci" },
    });
  } catch (err) {
    throw new CiOidcError(
      "jwks_unavailable",
      `could not fetch OIDC JWKS: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!response.ok) {
    throw new CiOidcError("jwks_unavailable", `OIDC JWKS fetch failed (${response.status})`);
  }
  const raw = await readBoundedJson(response, MAX_JWKS_BYTES);
  const keys = readJwksKeys(raw);
  if (!keys) throw new CiOidcError("jwks_unavailable", "OIDC JWKS document has no usable keys");

  jwksMemo.set(config.jwksUri, { keys, expiresAtMs: nowMs + JWKS_TTL_MS });
  if (env.COMPARE_CACHE) {
    try {
      await env.COMPARE_CACHE.put(cacheKey, JSON.stringify({ keys }), {
        expirationTtl: Math.floor(JWKS_TTL_MS / 1000),
      });
    } catch {
      // Best effort: the memo above already covers this isolate.
    }
  }
  return keys;
}

function readJwksKeys(value: unknown): JsonWebKey[] | null {
  if (!isObject(value)) return null;
  const keys = (value as { keys?: unknown }).keys;
  if (!Array.isArray(keys)) return null;
  const usable = keys.filter((key): key is JsonWebKey => isObject(key));
  return usable.length > 0 ? usable : null;
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new CiOidcError("jwks_unavailable", "OIDC JWKS document is too large");
  }
  const text = await response.text();
  if (text.length > maxBytes) {
    throw new CiOidcError("jwks_unavailable", "OIDC JWKS document is too large");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new CiOidcError("jwks_unavailable", "OIDC JWKS document is not valid JSON");
  }
}

/**
 * Verify a GitHub Actions OIDC token and return its release-binding claims.
 *
 * Fail-closed at every step: an unknown `kid`, an unfetchable JWKS, a bad
 * signature, a wrong audience, or a missing binding claim all throw. There is
 * no "degrade to unauthenticated" path, because the claims are the only thing
 * that decides which organization the uploaded bytes land in.
 */
export async function verifyGithubOidcToken(
  env: Cloudflare.Env,
  token: string,
  config: CiOidcConfig = readCiOidcConfig(env),
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<GithubOidcClaims> {
  if (!token) throw new CiOidcError("token_missing", "no OIDC bearer token was presented");

  const { header, payload, signingInput, signature } = decodeJwt(token);
  if (header.alg !== "RS256") {
    throw new CiOidcError(
      "unsupported_algorithm",
      `OIDC token alg must be RS256, got ${String(header.alg)}`,
    );
  }
  const kid = typeof header.kid === "string" ? header.kid : null;
  if (!kid) throw new CiOidcError("token_malformed", "OIDC token header has no kid");

  const keys = await loadJwks(env, config);
  const jwk = keys.find((key) => (key as { kid?: unknown }).kid === kid);
  if (!jwk) throw new CiOidcError("unknown_key", `no JWKS key matches kid ${kid}`);

  const publicKey = await crypto.subtle.importKey(
    "jwk",
    { ...jwk, alg: "RS256", ext: true, key_ops: ["verify"] },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    publicKey,
    signature as unknown as BufferSource,
    signingInput as unknown as BufferSource,
  );
  if (!valid) throw new CiOidcError("signature_invalid", "OIDC token signature does not verify");

  // Signature first, claims second: never read a claim off an unverified token.
  if (payload.iss !== config.issuer) {
    throw new CiOidcError(
      "issuer_mismatch",
      `OIDC token issuer ${String(payload.iss)} not allowed`,
    );
  }
  if (!audienceMatches(payload.aud, config.audience)) {
    throw new CiOidcError(
      "audience_mismatch",
      `OIDC token audience does not include ${config.audience}`,
    );
  }

  const expiresAt = readNumber(payload.exp);
  if (expiresAt === null) throw new CiOidcError("claims_missing", "OIDC token has no exp");
  if (nowSeconds - CLOCK_SKEW_SECONDS >= expiresAt) {
    throw new CiOidcError("token_expired", "OIDC token has expired");
  }
  const notBefore = readNumber(payload.nbf);
  if (notBefore !== null && nowSeconds + CLOCK_SKEW_SECONDS < notBefore) {
    throw new CiOidcError("token_not_yet_valid", "OIDC token is not valid yet");
  }
  const issuedAt = readNumber(payload.iat) ?? nowSeconds;

  const repository = readString(payload.repository);
  const repositoryId = readNumericId(payload.repository_id);
  const runId = readNumericId(payload.run_id);
  if (!repository || !repositoryId || !runId) {
    throw new CiOidcError(
      "claims_missing",
      "OIDC token must carry repository, repository_id and run_id",
    );
  }

  return {
    subject: readString(payload.sub) ?? "",
    repository,
    repositoryId,
    repositoryOwner: readString(payload.repository_owner) ?? repository.split("/")[0],
    runId,
    // A first attempt omits nothing, but a token minted by an older runner may
    // not carry the claim at all; treating that as attempt 1 keeps the unique
    // key stable instead of failing an otherwise valid upload.
    runAttempt: readNumericId(payload.run_attempt) ?? 1,
    sha: readString(payload.sha) ?? "",
    ref: readString(payload.ref) ?? "",
    workflowRef: readString(payload.workflow_ref) ?? "",
    jobWorkflowRef: readString(payload.job_workflow_ref) ?? "",
    actor: readString(payload.actor) ?? "",
    eventName: readString(payload.event_name) ?? "",
    environment: readString(payload.environment),
    issuedAt,
    expiresAt,
  };
}

function audienceMatches(aud: unknown, expected: string): boolean {
  if (typeof aud === "string") return aud === expected;
  if (Array.isArray(aud)) return aud.some((entry) => entry === expected);
  return false;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readNumericId(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number.parseInt(value, 10);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
