import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import worker from "../../server";
import { createDb } from "../../server/db/client";
import * as schema from "../../server/db/schema";

const ORIGIN = "http://example.com";
const PASSWORD = "correct horse battery staple";
const SESSION_DATA_COOKIE = "spr.session_data";
const SESSION_TOKEN_COOKIE = "spr.session_token";

type Jar = Map<string, string>;

function mergeSetCookies(jar: Jar, res: Response) {
  for (const raw of res.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(";");
    const idx = pair.indexOf("=");
    if (idx === -1) continue;
    const name = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    // An expiring cookie clears the jar entry, the way a browser would.
    if (!value || /expires=Thu, 01 Jan 1970/i.test(raw)) jar.delete(name);
    else jar.set(name, value);
  }
}

function cookieHeader(jar: Jar): string {
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

async function call(
  method: string,
  path: string,
  opts: { body?: unknown; jar?: Jar; requestEnv?: Cloudflare.Env } = {},
) {
  const ctx = createExecutionContext();
  const headers = new Headers();
  if (opts.body !== undefined) headers.set("content-type", "application/json");
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) headers.set("origin", ORIGIN);
  if (opts.jar?.size) headers.set("cookie", cookieHeader(opts.jar));
  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
  const res = await worker.fetch(
    new Request(`${ORIGIN}${path}`, init),
    opts.requestEnv ?? env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  if (opts.jar) mergeSetCookies(opts.jar, res);
  return res;
}

async function signUp(): Promise<Jar> {
  const jar: Jar = new Map();
  const res = await call("POST", "/api/auth/sign-up/email", {
    body: {
      name: "Session Cache Tester",
      email: `session-cache-${crypto.randomUUID()}@example.test`,
      password: PASSWORD,
    },
    jar,
  });
  expect(res.status).toBe(200);
  return jar;
}

/** An env whose session KV throws on every read, to prove a path skips it. */
function envWithFailingSessionStore(): Cloudflare.Env {
  const forbidden = () => {
    throw new Error("the session store must not be read on this path");
  };
  return {
    ...env,
    AUTH_SESSIONS: {
      get: forbidden,
      put: forbidden,
      delete: forbidden,
      list: forbidden,
      getWithMetadata: forbidden,
    } as unknown as KVNamespace,
  };
}

async function clearSessionKv(): Promise<void> {
  const namespace = env.AUTH_SESSIONS;
  if (!namespace) throw new Error("AUTH_SESSIONS is not bound in the test env");
  const listed = await namespace.list();
  for (const key of listed.keys) await namespace.delete(key.name);
}

describe("session cookie cache", () => {
  test("sign-up issues a session-data cookie", async () => {
    const jar = await signUp();
    expect(jar.get(SESSION_TOKEN_COOKIE)).toBeTruthy();
    expect(jar.get(SESSION_DATA_COOKIE)).toBeTruthy();
  });

  test("an authenticated request resolves without reading the session store", async () => {
    const jar = await signUp();

    // Every /api/* request used to cost a session read against the D1 single
    // writer. With the cookie cache fresh, the request must not consult the
    // session store at all — a store that throws on read proves it.
    const res = await call("GET", "/api/health", {
      jar,
      requestEnv: envWithFailingSessionStore(),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  test("a request without the cached cookie still resolves from the session store", async () => {
    const jar = await signUp();
    jar.delete(SESSION_DATA_COOKIE);

    const res = await call("GET", "/api/health", { jar });
    expect(res.status).toBe(200);
  });
});

describe("session secondary storage", () => {
  test("a session lands in KV and stays durable in D1", async () => {
    const jar = await signUp();
    const token = decodeURIComponent(jar.get(SESSION_TOKEN_COOKIE) ?? "").split(".")[0];
    expect(token).toBeTruthy();

    expect(await env.AUTH_SESSIONS?.get(token)).toBeTruthy();
    // `storeSessionInDatabase` keeps D1 as the durable record, so an emptied or
    // newly introduced KV namespace cannot sign everyone out and revocation
    // still has a row to delete.
    const rows = await createDb(env.DB).select().from(schema.session);
    expect(rows.some((row) => row.token === token)).toBe(true);
  });

  test("an empty KV namespace falls back to the durable D1 session", async () => {
    const jar = await signUp();
    await clearSessionKv();
    jar.delete(SESSION_DATA_COOKIE);

    const res = await call("GET", "/api/health", { jar });
    expect(res.status).toBe(200);
  });
});

describe("sign-out", () => {
  test("clears the cached cookie and removes the session from both stores", async () => {
    const jar = await signUp();
    const token = decodeURIComponent(jar.get(SESSION_TOKEN_COOKIE) ?? "").split(".")[0];

    const signOut = await call("POST", "/api/auth/sign-out", { jar });
    expect(signOut.status).toBe(200);

    // The cookie cache is the revocation lag, so sign-out has to expire it.
    expect(jar.get(SESSION_DATA_COOKIE)).toBeUndefined();
    expect(jar.get(SESSION_TOKEN_COOKIE)).toBeUndefined();

    expect(await env.AUTH_SESSIONS?.get(token)).toBeNull();
    const rows = await createDb(env.DB).select().from(schema.session);
    expect(rows.some((row) => row.token === token)).toBe(false);

    const res = await call("GET", "/api/health", { jar });
    expect(res.status).toBe(401);
  });
});
