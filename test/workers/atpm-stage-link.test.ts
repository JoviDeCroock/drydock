import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, test, vi } from "vitest";
import worker from "../../server";

const DID = "did:plc:twegdcgytckr5cxm57gyruxa";
const PDS = "https://shiitake.us-east.host.bsky.network";
const CID = "bafkreibrz4xmz6sbraw6h2mtchh5xq7jqghrjhr3yyyub3wbyrvmyjg2bm";
const RECORD_CID = "bafyreid6s3kc6vqdqr3q32chwtumycvyd2zrzuc4p2ftcoztimngtpst6u";
const RKEY = "3lmabcdefghij";

function stageRecord() {
  return {
    uri: `at://${DID}/dev.atpm.alpha.stage/${RKEY}`,
    cid: RECORD_CID,
    value: {
      $type: "dev.atpm.alpha.stage",
      createdAt: "2026-08-13T06:28:24.000Z",
      name: "@ebey.dev/counter",
      version: "0.0.16",
      tags: { latest: "0.0.16" },
      blob: { $type: "blob", ref: { $link: CID }, size: 604, mimeType: "application/gzip" },
      meta: {
        name: "@ebey.dev/counter",
        version: "0.0.16",
        dist: { tarball: `${PDS}/xrpc/com.atproto.sync.getBlob?did=${DID}&cid=${CID}` },
      },
    },
  };
}

function packageRecord() {
  return {
    $type: "dev.atpm.alpha.package",
    createdAt: "2026-01-01T00:00:00.000Z",
    tags: { latest: "0.0.15" },
    versions: [
      {
        $type: "dev.atpm.alpha.package#package",
        version: "0.0.15",
        createdAt: "2026-01-01T00:00:00.000Z",
        blob: { $type: "blob", ref: { $link: CID }, size: 604, mimeType: "application/gzip" },
        meta: {
          name: "@ebey.dev/counter",
          version: "0.0.15",
          dist: { tarball: `${PDS}/xrpc/com.atproto.sync.getBlob?did=${DID}&cid=${CID}` },
        },
      },
    ],
  };
}

function stubNetwork(options: { staged?: unknown } = {}) {
  vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("https://cloudflare-dns.com/dns-query")) {
      return Promise.resolve(Response.json({ Answer: [{ type: 16, data: `"did=${DID}"` }] }));
    }
    if (url.startsWith(`https://plc.directory/${encodeURIComponent(DID)}`)) {
      return Promise.resolve(
        Response.json({
          id: DID,
          alsoKnownAs: ["at://ebey.dev"],
          service: [
            { id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: PDS },
          ],
        }),
      );
    }
    if (url.includes("collection=dev.atpm.alpha.stage")) {
      return options.staged === null
        ? Promise.resolve(Response.json({ error: "RecordNotFound" }, { status: 400 }))
        : Promise.resolve(Response.json(stageRecord()));
    }
    if (url.includes("collection=dev.atpm.alpha.package")) {
      return Promise.resolve(Response.json({ value: packageRecord() }));
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  });
}

/** No cookie, no Authorization header — exactly what a link click sends. */
async function anonymousGet(path: string): Promise<Response> {
  return anonymousGetWithEnv(path, env);
}

async function anonymousGetWithEnv(path: string, requestEnv: Cloudflare.Env): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`https://drydock.org${path}`, {
      headers: { "cf-connecting-ip": `203.0.113.${Math.floor(Math.random() * 200) + 1}` },
    }),
    requestEnv,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

describe("/stage/atpm/:publisher/:rkey", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("resolves to the review with no session at all", async () => {
    // The whole premise of this route: a maintainer looking at atpm's staged
    // dashboard clicks through to the review without holding a Drydock account.
    stubNetwork();
    const response = await anonymousGet(`/stage/atpm/@ebey.dev/${RKEY}`);
    expect(response.status).toBe(302);
    // Built against the deployment's canonical origin rather than the request
    // host, so a forged Host header cannot bend the destination.
    expect(new URL(response.headers.get("location")!).pathname).toBe(
      `/diff/atpm/${DID}/counter/0.0.15/staged.${RKEY}.${RECORD_CID}`,
    );
  });

  test("is disabled with the rest of public diff on custom-registry deployments", async () => {
    const network = vi.fn();
    vi.stubGlobal("fetch", network);
    const response = await anonymousGetWithEnv(`/stage/atpm/@ebey.dev/${RKEY}`, {
      ...env,
      NPM_REGISTRY: "https://registry.example.test",
    });
    expect(response.status).toBe(404);
    expect(network).not.toHaveBeenCalled();
  });

  test("does not send the visitor to a login", async () => {
    stubNetwork();
    const response = await anonymousGet(`/stage/atpm/${DID}/${RKEY}`);
    expect(response.headers.get("location")).not.toContain("/login");
    expect(response.status).not.toBe(401);
    expect(response.status).not.toBe(403);
  });

  test("explains an approved candidate rather than 404ing blankly", async () => {
    // atpm deletes the staged record on approval, so this is where every one of
    // these links ends up — it should read as an outcome, not a broken link.
    stubNetwork({ staged: null });
    const response = await anonymousGet(`/stage/atpm/@ebey.dev/${RKEY}`);
    expect(response.status).toBe(404);
    const body = await response.text();
    expect(body).toContain("no longer waiting");
    expect(body).toContain("/diff");
  });

  test("refuses a publisher this deployment will not resolve", async () => {
    const response = await anonymousGet(`/stage/atpm/@localhost/${RKEY}`);
    expect(response.status).toBe(502);
  });

  test("the API behind it is anonymous too", async () => {
    stubNetwork();
    const response = await anonymousGet(
      `/api/public/v1/package-diff/atpm-stage?publisher=@ebey.dev&rkey=${RKEY}`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      packageName: `${DID}/counter`,
      displayName: "@ebey.dev/counter",
      version: "0.0.16",
      baselineVersion: "0.0.15",
    });
    // Nothing about approving travels with it: Drydock shows what changed and
    // stops there.
    expect(body).not.toHaveProperty("approveId");
  });
});
