import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import * as OTPAuth from "otpauth";
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

async function signUp(requestEnv: Cloudflare.Env = env): Promise<Jar> {
  const jar: Jar = new Map();
  const res = await call("POST", "/api/auth/sign-up/email", {
    body: {
      name: "Session Cache Tester",
      email: `session-cache-${crypto.randomUUID()}@example.test`,
      password: PASSWORD,
    },
    jar,
    requestEnv,
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

function envWithoutSessionStore(): Cloudflare.Env {
  return { ...env, AUTH_SESSIONS: undefined };
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

  test("lists and revokes sessions created before KV was enabled", async () => {
    const d1OnlyEnv = envWithoutSessionStore();
    const primary = await signUp(d1OnlyEnv);
    const session = await call("GET", "/api/auth/get-session", {
      jar: primary,
      requestEnv: d1OnlyEnv,
    });
    const email = ((await session.json()) as { user: { email: string } }).user.email;

    const secondary: Jar = new Map();
    expect(
      (
        await call("POST", "/api/auth/sign-in/email", {
          body: { email, password: PASSWORD },
          jar: secondary,
          requestEnv: d1OnlyEnv,
        })
      ).status,
    ).toBe(200);
    await clearSessionKv();

    const listed = await call("GET", "/api/auth/list-sessions", { jar: primary });
    expect(listed.status).toBe(200);
    expect(await listed.json()).toHaveLength(2);

    const revoked = await call("POST", "/api/auth/revoke-other-sessions", { jar: primary });
    expect(revoked.status).toBe(200);

    // Remove the bounded cookie cache so this proves the durable session and
    // its newly hydrated KV entry were both revoked.
    secondary.delete(SESSION_DATA_COOKIE);
    expect((await call("GET", "/api/health", { jar: secondary })).status).toBe(401);
    expect((await call("GET", "/api/health", { jar: primary })).status).toBe(200);
  });
});

describe("session secondary storage contents", () => {
  test(
    "no verification record reaches the session KV namespace, and the 2FA challenge still resolves",
    { timeout: 30_000 },
    async () => {
      // Better Auth has no per-model opt-out for secondary storage: with one
      // configured it writes verification records too, keyed
      // `verification:<identifier>` — which for a password reset would put the
      // token itself in a KV key *name*, readable by anything with list access.
      // Only session records may live in AUTH_SESSIONS.
      await clearSessionKv();

      const email = `kv-guard-${crypto.randomUUID()}@example.test`;
      const jar: Jar = new Map();
      const signUpRes = await call("POST", "/api/auth/sign-up/email", {
        body: { name: "KV Guard Tester", email, password: PASSWORD },
        jar,
      });
      expect(signUpRes.status).toBe(200);

      const enable = await call("POST", "/api/auth/two-factor/enable", {
        body: { password: PASSWORD },
        jar,
      });
      expect(enable.status).toBe(200);
      const totp = OTPAuth.URI.parse(
        ((await enable.json()) as { totpURI: string }).totpURI,
      ) as OTPAuth.TOTP;
      expect(
        (
          await call("POST", "/api/auth/two-factor/verify-totp", {
            body: { code: totp.generate() },
            jar,
          })
        ).status,
      ).toBe(200);

      // Sign in again to leave a *pending* two-factor challenge — the shortest
      // path to a live single-use verification record.
      await call("POST", "/api/auth/sign-out", { jar });
      const challengeJar: Jar = new Map();
      const signIn = await call("POST", "/api/auth/sign-in/email", {
        body: { email, password: PASSWORD },
        jar: challengeJar,
      });
      expect(signIn.status).toBe(200);
      expect(await signIn.json()).toMatchObject({ twoFactorRedirect: true });

      // The challenge exists — in D1, where consumption is transactional — and
      // nothing namespaced was written to KV to mirror it. (Sign-out cleared the
      // session keys, so KV may legitimately be empty right here.)
      const verifications = await createDb(env.DB).select().from(schema.verification);
      expect(verifications.length).toBeGreaterThan(0);
      const pending = await env.AUTH_SESSIONS!.list();
      expect(pending.keys.map((key) => key.name).filter((name) => name.includes(":"))).toEqual([]);

      // The guard suppresses reads as well as writes, so completing the
      // handshake has to work entirely off D1.
      const challenge = await call("POST", "/api/auth/two-factor/verify-totp", {
        body: { code: totp.generate() },
        jar: challengeJar,
      });
      expect(challenge.status).toBe(200);

      // And the namespace ends up holding sessions, only sessions.
      const listed = await env.AUTH_SESSIONS!.list();
      expect(listed.keys.length).toBeGreaterThan(0);
      expect(listed.keys.map((key) => key.name).filter((name) => name.includes(":"))).toEqual([]);
    },
  );
});

describe("a session that outlives its user", () => {
  test("answers 401, not 500, on an organization-scoped request", async () => {
    // A cached session cookie can outlive the account by up to the cache
    // lifetime. The first organization-scoped request from the other device used
    // to reach ensurePersonalOrganization, which inserted an organization owned
    // by a user row that no longer exists — a foreign-key failure surfacing as a
    // 500 with a stack in the logs instead of the 401 the caller has earned.
    const email = `ghost-${crypto.randomUUID()}@example.test`;
    const deviceA: Jar = new Map();
    expect(
      (
        await call("POST", "/api/auth/sign-up/email", {
          body: { name: "Ghost", email, password: PASSWORD },
          jar: deviceA,
        })
      ).status,
    ).toBe(200);

    const deviceB: Jar = new Map();
    expect(
      (
        await call("POST", "/api/auth/sign-in/email", {
          body: { email, password: PASSWORD },
          jar: deviceB,
        })
      ).status,
    ).toBe(200);
    expect(deviceB.get(SESSION_DATA_COOKIE)).toBeTruthy();

    const deleted = await call("POST", "/api/auth/delete-user", {
      body: { password: PASSWORD },
      jar: deviceA,
    });
    expect(deleted.status).toBe(200);

    // Device B never saw the sign-out, so its cookie cache is still warm.
    for (const path of ["/api/v1/organizations", "/api/v1/scans"]) {
      const res = await call("GET", path, { jar: deviceB });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
    }

    const createOrganization = await call("POST", "/api/v1/organizations", {
      body: { name: "Orphaned workspace" },
      jar: deviceB,
    });
    expect(createOrganization.status).toBe(401);
    expect(await createOrganization.json()).toEqual({ error: "unauthorized" });

    // And nothing was created on the way out.
    const orphans = await createDb(env.DB).select().from(schema.organizations);
    expect(orphans.some((row) => row.name === "Ghost")).toBe(false);
    expect(orphans.some((row) => row.name === "Orphaned workspace")).toBe(false);
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
