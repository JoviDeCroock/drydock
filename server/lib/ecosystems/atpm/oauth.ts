import {
  assertPublicHttpsUrl,
  readBoundedJson,
  reliablePublicHttpsFetch,
  resolveAtpmRepoIdentity,
  type AtpmRepoIdentity,
} from "./identity";
import { parseAtpmPublisherRef } from "./stage-ref";
import { base64UrlEncode } from "../../platform/crypto-utils";

/**
 * AT Protocol OAuth, used for one thing: proving that whoever is enrolling a
 * publishing account can actually sign in as it.
 *
 * The unusual part is what happens next — nothing. The access and refresh
 * tokens are read for their `sub` claim and then dropped on the floor. Drydock
 * needs no delegated access to an atpm publisher: staged candidates, published
 * releases, and trusted-publisher declarations are all public records, and
 * approving a release is something Drydock deliberately does not do. Holding a
 * live session would therefore buy nothing and cost the property that makes
 * this whole ecosystem path unusual, which is that it holds no credentials at
 * all (`docs/security-model.md`).
 *
 * So this is an authorization-code flow run for its identity assertion. What it
 * establishes — "this person controls this DID, at this moment" — is recorded
 * as a row in `atpm_publishers` with a `verified_at`, and re-establishing it
 * later means running the flow again.
 *
 * Everything the protocol requires is still done properly, because a proof that
 * skips steps is not a proof:
 *
 *  - the authorization server is discovered from the account's *own* PDS
 *    (`/.well-known/oauth-protected-resource`), never from a directory, so an
 *    account hosted anywhere authenticates against its own host;
 *  - PAR, PKCE (S256), and DPoP are all used, as atproto mandates;
 *  - the `iss` returned to the callback must match the issuer the request was
 *    sent to, and the token response's `sub` must equal the DID the flow was
 *    started for. A different account authorizing the request is a failure, not
 *    a silent re-target.
 */

/**
 * A failure in the enrolment flow.
 *
 * Distinct from `PublicDiffError`, which the shared identity helpers throw:
 * this is an authenticated, non-diff surface, and its statuses include
 * outcomes (403) that the anonymous diff path has no way to produce. The route
 * maps both.
 */
export class AtpmOauthError extends Error {
  constructor(
    message: string,
    public status: 400 | 403 | 404 | 502,
  ) {
    super(message);
    this.name = "AtpmOauthError";
  }
}

/** Bump when the client metadata document or the flow's requirements change. */
export const ATPM_OAUTH_RULES_VERSION = "1";

/** atproto's identity scope. No repository write scope is ever requested. */
const OAUTH_SCOPE = "atproto";

const METADATA_TIMEOUT_MS = 8_000;
const TOKEN_TIMEOUT_MS = 10_000;

// Authorization-server metadata is a small JSON document.
const MAX_METADATA_BYTES = 64 * 1024;

/** An authorization request is finished in a browser round trip or not at all. */
export const OAUTH_REQUEST_TTL_MS = 10 * 60 * 1000;

export interface AtpmOauthEndpoints {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  pushedAuthorizationRequestEndpoint: string;
}

export interface AtpmOauthClient {
  clientId: string;
  redirectUri: string;
}

/**
 * The client identifier is the URL its metadata is served from — atproto has no
 * registration step, so the document *is* the registration.
 */
export function atpmOauthClient(origin: string): AtpmOauthClient {
  return {
    clientId: `${origin}/api/v1/atpm/oauth/client-metadata.json`,
    redirectUri: `${origin}/api/v1/atpm/oauth/callback`,
  };
}

/**
 * The client metadata document, served publicly and fetched by every
 * authorization server this client talks to.
 *
 * `token_endpoint_auth_method: none` makes this a public client: there is no
 * client secret to hold, which is consistent with holding no user tokens
 * either. PKCE and DPoP carry the security of the exchange.
 */
export function atpmOauthClientMetadata(origin: string): Record<string, unknown> {
  const client = atpmOauthClient(origin);
  return {
    client_id: client.clientId,
    client_name: "Drydock",
    client_uri: origin,
    redirect_uris: [client.redirectUri],
    grant_types: ["authorization_code"],
    response_types: ["code"],
    scope: OAUTH_SCOPE,
    application_type: "web",
    token_endpoint_auth_method: "none",
    dpop_bound_access_tokens: true,
  };
}

/** Resolve an account, then its PDS's authorization server. */
export async function resolveAtpmOauthTarget(
  publisherRef: string,
): Promise<{ identity: AtpmRepoIdentity; endpoints: AtpmOauthEndpoints }> {
  const ref = parseAtpmPublisherRef(publisherRef);
  if (!ref) throw new AtpmOauthError("not a readable atpm handle or DID", 400);
  const identity = await resolveAtpmRepoIdentity(ref);
  return { identity, endpoints: await discoverEndpoints(identity.pds) };
}

/**
 * Discover the authorization server for a PDS.
 *
 * Two hops, both required by the atproto profile: the PDS declares which
 * authorization servers may issue tokens for it, and that server declares its
 * own endpoints. Following the PDS's own declaration is what keeps a
 * self-hosted account authenticating against its own infrastructure.
 */
export async function discoverEndpoints(pds: string): Promise<AtpmOauthEndpoints> {
  const resource = await readJsonDocument(
    `${pds}/.well-known/oauth-protected-resource`,
    "PDS metadata",
  );
  const servers = Array.isArray(resource.authorization_servers)
    ? resource.authorization_servers
    : [];
  const issuerRaw = servers.find((value): value is string => typeof value === "string" && !!value);
  if (!issuerRaw) throw new AtpmOauthError("PDS declares no authorization server", 502);
  // The issuer is a host the account under enrolment chose, so it goes through
  // the same policy as every other publisher-named host on this path.
  const issuer = assertPublicHttpsUrl(issuerRaw, "authorization server").origin;

  const metadata = await readJsonDocument(
    `${issuer}/.well-known/oauth-authorization-server`,
    "authorization server metadata",
  );
  // A metadata document that names a different issuer than the one it was
  // fetched from cannot be used to authenticate that issuer.
  if (metadata.issuer !== issuer) {
    throw new AtpmOauthError("authorization server metadata is for a different issuer", 502);
  }
  const authorizationEndpoint = requireEndpoint(metadata.authorization_endpoint, "authorization");
  const tokenEndpoint = requireEndpoint(metadata.token_endpoint, "token");
  const parEndpoint = requireEndpoint(
    metadata.pushed_authorization_request_endpoint,
    "pushed authorization request",
  );
  return {
    issuer,
    authorizationEndpoint,
    tokenEndpoint,
    pushedAuthorizationRequestEndpoint: parEndpoint,
  };
}

function requireEndpoint(value: unknown, what: string): string {
  if (typeof value !== "string" || !value) {
    throw new AtpmOauthError(`authorization server declares no ${what} endpoint`, 502);
  }
  return assertPublicHttpsUrl(value, `${what} endpoint`).toString();
}

async function readJsonDocument(url: string, what: string): Promise<Record<string, unknown>> {
  assertPublicHttpsUrl(url, what);
  let response: Response;
  try {
    response = await reliablePublicHttpsFetch(url, what, {
      headers: new Headers({ accept: "application/json" }),
      timeoutMs: METADATA_TIMEOUT_MS,
    });
  } catch {
    throw new AtpmOauthError(`${what} could not be read`, 502);
  }
  if (!response.ok) throw new AtpmOauthError(`${what} could not be read`, 502);
  const body = await readBoundedJson<Record<string, unknown>>(response, MAX_METADATA_BYTES);
  if (!body || typeof body !== "object") {
    throw new AtpmOauthError(`${what} is not valid JSON`, 502);
  }
  return body;
}

export interface DpopKeyPair {
  privateJwk: JsonWebKey;
  publicJwk: JsonWebKey;
}

/**
 * A fresh DPoP key per authorization request. It binds one token exchange and
 * is discarded with the rest of the request state, so there is no long-lived
 * key to rotate or leak.
 */
export async function createDpopKeyPair(): Promise<DpopKeyPair> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  // The proof's header carries the public key; anything else exported with it
  // (the private scalar, usage hints) must not travel.
  return {
    privateJwk,
    publicJwk: { kty: publicJwk.kty, crv: publicJwk.crv, x: publicJwk.x, y: publicJwk.y },
  };
}

/** Build and sign a DPoP proof for one request. */
export async function createDpopProof(input: {
  key: DpopKeyPair;
  method: string;
  url: string;
  nonce?: string | null;
}): Promise<string> {
  const header = { typ: "dpop+jwt", alg: "ES256", jwk: input.key.publicJwk };
  // `htu` is the request URI without query or fragment, per RFC 9449.
  const target = new URL(input.url);
  const claims: Record<string, unknown> = {
    jti: crypto.randomUUID(),
    htm: input.method.toUpperCase(),
    htu: `${target.origin}${target.pathname}`,
    iat: Math.floor(Date.now() / 1000),
    ...(input.nonce ? { nonce: input.nonce } : {}),
  };

  const signingInput = `${base64UrlJson(header)}.${base64UrlJson(claims)}`;
  const key = await crypto.subtle.importKey(
    "jwk",
    input.key.privateJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

function base64UrlJson(value: unknown): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export async function createPkcePair(): Promise<PkcePair> {
  const verifier = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64UrlEncode(new Uint8Array(digest)) };
}

/**
 * Send a request through the authorization server and retry once with the nonce
 * it demands.
 *
 * DPoP servers reject a first proof with `use_dpop_nonce` and hand back a
 * `DPoP-Nonce` header; that is the normal path, not an error. One retry is
 * enough — a server that asks twice is not following the protocol, and looping
 * on its say-so would let it drive an unbounded number of signatures.
 */
async function fetchWithDpop(
  url: string,
  key: DpopKeyPair,
  body: URLSearchParams,
  timeoutMs: number,
): Promise<Response> {
  let nonce: string | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const proof = await createDpopProof({ key, method: "POST", url, nonce });
    const response = await reliablePublicHttpsFetch(url, "authorization server", {
      method: "POST",
      headers: new Headers({
        "content-type": "application/x-www-form-urlencoded",
        dpop: proof,
      }),
      body: body.toString(),
      timeoutMs,
    });
    if (response.status !== 400 && response.status !== 401) return response;

    const offered = response.headers.get("dpop-nonce");
    if (!offered || attempt === 1) return response;
    await response.body?.cancel();
    nonce = offered;
  }
  throw new AtpmOauthError("authorization server rejected the DPoP proof", 502);
}

export interface StartedAuthorization {
  authorizationUrl: string;
}

/**
 * Push the authorization request and return the URL to send the browser to.
 *
 * Pushing it first (RFC 9126) means the parameters — including the DID being
 * proven — are delivered server to server and cannot be rewritten in the
 * user's address bar on the way to the login page.
 */
export async function pushAuthorizationRequest(input: {
  client: AtpmOauthClient;
  endpoints: AtpmOauthEndpoints;
  identity: AtpmRepoIdentity;
  key: DpopKeyPair;
  pkce: PkcePair;
  state: string;
}): Promise<StartedAuthorization> {
  const body = new URLSearchParams({
    client_id: input.client.clientId,
    redirect_uri: input.client.redirectUri,
    response_type: "code",
    scope: OAUTH_SCOPE,
    state: input.state,
    code_challenge: input.pkce.challenge,
    code_challenge_method: "S256",
    // Naming the account up front is what lets the server skip the "who are
    // you?" step and makes a mismatch on return unambiguous.
    login_hint: input.identity.handle ?? input.identity.did,
  });

  const response = await fetchWithDpop(
    input.endpoints.pushedAuthorizationRequestEndpoint,
    input.key,
    body,
    METADATA_TIMEOUT_MS,
  );
  const payload = await readBoundedJson<{ request_uri?: unknown }>(response, MAX_METADATA_BYTES);
  if (!response.ok || typeof payload?.request_uri !== "string" || !payload.request_uri) {
    throw new AtpmOauthError("authorization server refused the request", 502);
  }

  const authorizationUrl = new URL(input.endpoints.authorizationEndpoint);
  authorizationUrl.searchParams.set("client_id", input.client.clientId);
  authorizationUrl.searchParams.set("request_uri", payload.request_uri);
  return { authorizationUrl: authorizationUrl.toString() };
}

/**
 * Exchange the authorization code and return only the DID it proves.
 *
 * The tokens in the response are deliberately not returned, stored, or logged.
 * They are the by-product of this flow, not its purpose.
 */
export async function proveDidFromAuthorizationCode(input: {
  client: AtpmOauthClient;
  tokenEndpoint: string;
  key: DpopKeyPair;
  code: string;
  pkceVerifier: string;
  expectedDid: string;
}): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.client.redirectUri,
    client_id: input.client.clientId,
    code_verifier: input.pkceVerifier,
  });

  const response = await fetchWithDpop(input.tokenEndpoint, input.key, body, TOKEN_TIMEOUT_MS);
  const payload = await readBoundedJson<{ sub?: unknown }>(response, MAX_METADATA_BYTES);
  if (!response.ok || !payload) {
    throw new AtpmOauthError("authorization server refused the token exchange", 502);
  }
  const sub = typeof payload.sub === "string" ? payload.sub : null;
  if (!sub) throw new AtpmOauthError("token response names no account", 502);
  // Whoever signed in is who the account is, and it must be the account this
  // enrolment was started for. Accepting a different `sub` would let a user
  // enrol an account by starting the flow for it and authenticating as
  // themselves.
  if (sub !== input.expectedDid) {
    throw new AtpmOauthError("a different account authorized this request", 403);
  }
  return sub;
}
