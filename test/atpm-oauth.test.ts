import { afterEach, describe, expect, test, vi } from "vitest";
import {
  AtpmOauthError,
  atpmOauthClient,
  atpmOauthClientMetadata,
  createDpopKeyPair,
  createDpopProof,
  createPkcePair,
  discoverEndpoints,
  proveDidFromAuthorizationCode,
  pushAuthorizationRequest,
} from "../server/lib/ecosystems/atpm/oauth";
import { decodeBase64 } from "../server/lib/platform/x509";

const ORIGIN = "https://drydock.org";
const PDS = "https://shiitake.us-east.host.bsky.network";
const ISSUER = "https://bsky.social";
const DID = "did:plc:twegdcgytckr5cxm57gyruxa";

function decodeJwtPart(part: string): Record<string, unknown> {
  const padded = part.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(
    new TextDecoder().decode(decodeBase64(padded + "=".repeat((4 - (padded.length % 4)) % 4))),
  ) as Record<string, unknown>;
}

function stubEndpoints(overrides: Record<string, unknown> = {}) {
  vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === `${PDS}/.well-known/oauth-protected-resource`) {
      return Promise.resolve(Response.json({ authorization_servers: [ISSUER] }));
    }
    if (url === `${ISSUER}/.well-known/oauth-authorization-server`) {
      return Promise.resolve(
        Response.json({
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/oauth/authorize`,
          token_endpoint: `${ISSUER}/oauth/token`,
          pushed_authorization_request_endpoint: `${ISSUER}/oauth/par`,
          ...overrides,
        }),
      );
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  });
}

describe("client metadata", () => {
  test("is self-describing: the client id is where the document lives", () => {
    const metadata = atpmOauthClientMetadata(ORIGIN);
    expect(metadata.client_id).toBe(atpmOauthClient(ORIGIN).clientId);
    expect(metadata.client_id).toBe(`${ORIGIN}/api/v1/atpm/oauth/client-metadata.json`);
    expect(metadata.redirect_uris).toEqual([`${ORIGIN}/api/v1/atpm/oauth/callback`]);
  });

  test("asks for identity only, and holds no client secret", () => {
    const metadata = atpmOauthClientMetadata(ORIGIN);
    // Anything beyond `atproto` would be requesting access this flow has no use
    // for: Drydock reads public records and never writes.
    expect(metadata.scope).toBe("atproto");
    expect(metadata.grant_types).toEqual(["authorization_code"]);
    expect(metadata.token_endpoint_auth_method).toBe("none");
    expect(metadata.dpop_bound_access_tokens).toBe(true);
    expect(JSON.stringify(metadata)).not.toMatch(/secret/i);
  });
});

describe("discoverEndpoints", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("follows the account's own PDS to its authorization server", async () => {
    stubEndpoints();
    expect(await discoverEndpoints(PDS)).toEqual({
      issuer: ISSUER,
      authorizationEndpoint: `${ISSUER}/oauth/authorize`,
      tokenEndpoint: `${ISSUER}/oauth/token`,
      pushedAuthorizationRequestEndpoint: `${ISSUER}/oauth/par`,
    });
  });

  test("refuses metadata that claims a different issuer than it was served from", async () => {
    stubEndpoints({ issuer: "https://attacker.example" });
    await expect(discoverEndpoints(PDS)).rejects.toBeInstanceOf(AtpmOauthError);
  });

  test("refuses an authorization server on a host this deployment will not call", async () => {
    vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
      if (String(input) === `${PDS}/.well-known/oauth-protected-resource`) {
        return Promise.resolve(Response.json({ authorization_servers: ["https://localhost"] }));
      }
      return Promise.resolve(new Response("no", { status: 404 }));
    });
    await expect(discoverEndpoints(PDS)).rejects.toThrow();
  });

  test("refuses a PDS that declares no authorization server", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(Response.json({ authorization_servers: [] })));
    await expect(discoverEndpoints(PDS)).rejects.toBeInstanceOf(AtpmOauthError);
  });
});

describe("DPoP proofs", () => {
  test("carry only the public half of the key", async () => {
    const key = await createDpopKeyPair();
    expect(Object.keys(key.publicJwk).sort()).toEqual(["crv", "kty", "x", "y"]);
    // The private scalar must never travel in a proof header.
    expect(key.publicJwk).not.toHaveProperty("d");

    const proof = await createDpopProof({
      key,
      method: "post",
      url: `${ISSUER}/oauth/token?ignored=1#fragment`,
    });
    const [header, claims] = proof.split(".");
    expect(decodeJwtPart(header)).toMatchObject({ typ: "dpop+jwt", alg: "ES256" });
    expect(decodeJwtPart(header).jwk).not.toHaveProperty("d");
    // RFC 9449: `htu` is the request URI with query and fragment removed.
    expect(decodeJwtPart(claims)).toMatchObject({
      htm: "POST",
      htu: `${ISSUER}/oauth/token`,
    });
  });

  test("verify under the key that signed them", async () => {
    const key = await createDpopKeyPair();
    const proof = await createDpopProof({ key, method: "POST", url: `${ISSUER}/oauth/token` });
    const [header, claims, signature] = proof.split(".");
    const publicKey = await crypto.subtle.importKey(
      "jwk",
      key.publicJwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const raw = signature.replace(/-/g, "+").replace(/_/g, "/");
    const verified = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      decodeBase64(raw + "=".repeat((4 - (raw.length % 4)) % 4)),
      new TextEncoder().encode(`${header}.${claims}`),
    );
    expect(verified).toBe(true);
  });

  test("are unique per request", async () => {
    const key = await createDpopKeyPair();
    const first = await createDpopProof({ key, method: "POST", url: `${ISSUER}/oauth/token` });
    const second = await createDpopProof({ key, method: "POST", url: `${ISSUER}/oauth/token` });
    expect(decodeJwtPart(first.split(".")[1]).jti).not.toBe(
      decodeJwtPart(second.split(".")[1]).jti,
    );
  });
});

describe("PKCE", () => {
  test("challenge is the S256 of the verifier", async () => {
    const pkce = await createPkcePair();
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pkce.verifier));
    const expected = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(pkce.challenge).toBe(expected);
  });
});

describe("pushAuthorizationRequest", () => {
  afterEach(() => vi.unstubAllGlobals());

  const endpoints = {
    issuer: ISSUER,
    authorizationEndpoint: `${ISSUER}/oauth/authorize`,
    tokenEndpoint: `${ISSUER}/oauth/token`,
    pushedAuthorizationRequestEndpoint: `${ISSUER}/oauth/par`,
  };
  const identity = { did: DID, pds: PDS, handle: "ebey.dev", handleMethod: "dns" as const };

  test("retries once with the nonce the server demands", async () => {
    const proofs: string[] = [];
    let calls = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      calls++;
      const headers = new Headers(init?.headers);
      proofs.push(String(headers.get("dpop")));
      if (calls === 1) {
        // The standard DPoP handshake: the first proof is always rejected so
        // the server can pin a nonce to it.
        return new Response(JSON.stringify({ error: "use_dpop_nonce" }), {
          status: 400,
          headers: { "DPoP-Nonce": "server-nonce" },
        });
      }
      return Response.json({ request_uri: "urn:ietf:params:oauth:request_uri:abc" });
    });

    const result = await pushAuthorizationRequest({
      client: atpmOauthClient(ORIGIN),
      endpoints,
      identity,
      key: await createDpopKeyPair(),
      pkce: await createPkcePair(),
      state: "state-value",
    });

    expect(calls).toBe(2);
    expect(decodeJwtPart(proofs[0].split(".")[1])).not.toHaveProperty("nonce");
    expect(decodeJwtPart(proofs[1].split(".")[1]).nonce).toBe("server-nonce");
    expect(result.authorizationUrl).toBe(
      `${ISSUER}/oauth/authorize?client_id=${encodeURIComponent(atpmOauthClient(ORIGIN).clientId)}&request_uri=urn%3Aietf%3Aparams%3Aoauth%3Arequest_uri%3Aabc`,
    );
  });

  test("does not loop when a server keeps asking for a new nonce", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls++;
      return new Response(JSON.stringify({ error: "use_dpop_nonce" }), {
        status: 400,
        headers: { "DPoP-Nonce": `nonce-${calls}` },
      });
    });
    await expect(
      pushAuthorizationRequest({
        client: atpmOauthClient(ORIGIN),
        endpoints,
        identity,
        key: await createDpopKeyPair(),
        pkce: await createPkcePair(),
        state: "state-value",
      }),
    ).rejects.toBeInstanceOf(AtpmOauthError);
    expect(calls).toBe(2);
  });
});

describe("proveDidFromAuthorizationCode", () => {
  afterEach(() => vi.unstubAllGlobals());

  async function exchange(responseBody: Record<string, unknown>, expectedDid = DID) {
    vi.stubGlobal("fetch", async () => Response.json(responseBody));
    return proveDidFromAuthorizationCode({
      client: atpmOauthClient(ORIGIN),
      tokenEndpoint: `${ISSUER}/oauth/token`,
      key: await createDpopKeyPair(),
      code: "auth-code",
      pkceVerifier: "verifier",
      expectedDid,
    });
  }

  test("returns the proven DID and nothing else", async () => {
    // The tokens in this response are the by-product of the flow, not its
    // purpose: only the subject comes back to the caller.
    const proven = await exchange({
      sub: DID,
      access_token: "SHOULD-NOT-ESCAPE",
      refresh_token: "SHOULD-NOT-ESCAPE",
    });
    expect(proven).toBe(DID);
  });

  test("refuses a response for a different account", async () => {
    await expect(exchange({ sub: "did:plc:someoneelse00000000000000" })).rejects.toMatchObject({
      status: 403,
    });
  });

  test("refuses a response that names no account", async () => {
    await expect(exchange({ access_token: "x" })).rejects.toBeInstanceOf(AtpmOauthError);
  });
});
