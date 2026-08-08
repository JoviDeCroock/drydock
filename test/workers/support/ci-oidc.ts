import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";

/**
 * A local stand-in for GitHub's Actions OIDC issuer.
 *
 * Tests need to mint tokens that the real verifier accepts on its own terms —
 * real RS256 signatures checked against a real JWKS document — so the only
 * thing faked is *who* is issuing. Anything weaker (a stubbed verifier, a
 * pre-baked token) would stop testing the code that decides which organization
 * a pushed release lands in.
 */

const TEST_ISSUER = "https://oidc.test";
const TEST_AUDIENCE = "drydock";
const TEST_KID = "drydock-test-key";

export interface FakeOidcIssuer {
  issuer: string;
  audience: string;
  jwksUri: string;
  jwks: { keys: unknown[] };
  /** Mint a token; `claims` overrides any default, `null` deletes a claim. */
  mint(claims?: Record<string, unknown>): string;
  /** Mint a token signed by a key the JWKS does not publish. */
  mintWithForeignKey(claims?: Record<string, unknown>): string;
}

export function createFakeOidcIssuer(options?: { issuer?: string }): FakeOidcIssuer {
  const issuer = options?.issuer ?? TEST_ISSUER;
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const foreign = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;

  const mintWith = (key: KeyObject, kid: string, claims?: Record<string, unknown>) => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const payload: Record<string, unknown> = {
      iss: issuer,
      aud: TEST_AUDIENCE,
      sub: "repo:octo/example:ref:refs/heads/main",
      iat: nowSeconds,
      nbf: nowSeconds,
      exp: nowSeconds + 600,
      repository: "octo/example",
      repository_id: "4242",
      repository_owner: "octo",
      run_id: "9001",
      run_attempt: "1",
      sha: "a".repeat(40),
      ref: "refs/heads/main",
      workflow_ref: "octo/example/.github/workflows/release.yml@refs/heads/main",
      job_workflow_ref: "octo/example/.github/workflows/release.yml@refs/heads/main",
      actor: "octocat",
      event_name: "push",
      ...claims,
    };
    for (const [name, value] of Object.entries(payload)) {
      if (value === null) delete payload[name];
    }
    const header = { alg: "RS256", typ: "JWT", kid };
    const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
    const signer = createSign("RSA-SHA256");
    signer.update(signingInput);
    const signature = signer.sign(key).toString("base64url");
    return `${signingInput}.${signature}`;
  };

  return {
    issuer,
    audience: TEST_AUDIENCE,
    jwksUri: `${issuer}/.well-known/jwks`,
    jwks: { keys: [{ ...jwk, kid: TEST_KID, alg: "RS256", use: "sig" }] },
    mint: (claims) => mintWith(privateKey, TEST_KID, claims),
    // Same published kid, different key: exercises signature rejection rather
    // than the easier "unknown kid" path.
    mintWithForeignKey: (claims) => mintWith(foreign.privateKey, TEST_KID, claims),
  };
}

/**
 * Wrap a fetch handler so the fake issuer's JWKS document is served and every
 * other request falls through to `rest`.
 */
export function withJwks(
  issuer: FakeOidcIssuer,
  rest?: (request: Request) => Promise<Response> | Response,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (request.url === issuer.jwksUri) {
      return Response.json(issuer.jwks);
    }
    if (rest) return rest(request);
    throw new Error(`unexpected fetch in test: ${request.url}`);
  };
}

function base64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}
