import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { createEmailVerificationToken } from "better-auth/api";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, test, vi } from "vitest";
import worker from "../../server";
import { createDb } from "../../server/db/client";
import * as schema from "../../server/db/schema";
import { callWorker, type Jar, signUp } from "./helpers/auth-http";

const ORIGIN = "http://example.com";
const LOCAL_ORIGIN = "http://localhost:5173";
const PASSWORD = "correct horse battery staple";
const WORKER_AUTH_TIMEOUT_MS = 15_000;

function uniqueEmail() {
  return `verify-${crypto.randomUUID()}@example.test`;
}

async function authPost(path: string, body: unknown, origin = ORIGIN) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`${origin}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify(body),
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

function withEmailBinding(): { send: ReturnType<typeof vi.fn> } {
  const send = vi.fn(async () => undefined);
  (env as { SEND_EMAIL?: unknown }).SEND_EMAIL = { send };
  return { send };
}

function clearEmailBinding() {
  delete (env as { SEND_EMAIL?: unknown }).SEND_EMAIL;
}

function setAuthUrl(url: string) {
  (env as { BETTER_AUTH_URL?: string }).BETTER_AUTH_URL = url;
}

afterEach(() => {
  clearEmailBinding();
  setAuthUrl(ORIGIN);
});

describe("email verification gating", () => {
  test(
    "with email configured, local sign-up still signs the user in immediately",
    async () => {
      const { send } = withEmailBinding();
      setAuthUrl(LOCAL_ORIGIN);
      const email = uniqueEmail();

      const res = await authPost(
        "/api/auth/sign-up/email",
        {
          name: "Verify Tester",
          email,
          password: PASSWORD,
          callbackURL: "/verify-email",
        },
        LOCAL_ORIGIN,
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { token: string | null };
      expect(typeof body.token).toBe("string");
      expect(res.headers.get("set-cookie") ?? "").toContain("session_token");
      expect(send).not.toHaveBeenCalled();
    },
    WORKER_AUTH_TIMEOUT_MS,
  );

  test(
    "with email configured, sign-up sends a verification email and still signs the user in",
    async () => {
      const { send } = withEmailBinding();
      const email = uniqueEmail();

      const res = await authPost("/api/auth/sign-up/email", {
        name: "Verify Tester",
        email,
        password: PASSWORD,
        callbackURL: "/verify-email",
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { token: string | null; user: { email: string } };
      // Verification is no longer a sign-in gate, so the session is issued now
      // and the address is proved later, per action.
      expect(typeof body.token).toBe("string");
      expect(res.headers.get("set-cookie") ?? "").toContain("session_token");
      // `sendOnSignUp` keeps dispatching the link even though nothing waits on it.
      expect(send).toHaveBeenCalledTimes(1);

      const db = createDb(env.DB);
      const [row] = await db
        .select({ emailVerified: schema.user.emailVerified })
        .from(schema.user)
        .where(eq(schema.user.email, email));
      expect(row?.emailVerified).toBe(false);
    },
    WORKER_AUTH_TIMEOUT_MS,
  );

  test(
    "unverified sign-in succeeds and issues a session",
    async () => {
      withEmailBinding();
      const email = uniqueEmail();

      await authPost("/api/auth/sign-up/email", {
        name: "Verify Tester",
        email,
        password: PASSWORD,
        callbackURL: "/verify-email",
      });

      const res = await authPost("/api/auth/sign-in/email", { email, password: PASSWORD });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { token?: string };
      expect(typeof body.token).toBe("string");
    },
    WORKER_AUTH_TIMEOUT_MS,
  );

  test(
    "once verified, sign-in succeeds and issues a session",
    async () => {
      withEmailBinding();
      const email = uniqueEmail();

      await authPost("/api/auth/sign-up/email", {
        name: "Verify Tester",
        email,
        password: PASSWORD,
        callbackURL: "/verify-email",
      });

      const db = createDb(env.DB);
      await db.update(schema.user).set({ emailVerified: true }).where(eq(schema.user.email, email));

      const res = await authPost("/api/auth/sign-in/email", { email, password: PASSWORD });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { token?: string; user?: { email: string } };
      expect(typeof body.token).toBe("string");
      expect(body.user?.email).toBe(email);
      expect(res.headers.get("set-cookie") ?? "").toContain("session_token");
    },
    WORKER_AUTH_TIMEOUT_MS,
  );

  test(
    "without an email transport, sign-up signs the user in immediately",
    async () => {
      clearEmailBinding();
      const email = uniqueEmail();

      const res = await authPost("/api/auth/sign-up/email", {
        name: "Verify Tester",
        email,
        password: PASSWORD,
        callbackURL: "/verify-email",
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { token: string | null };
      // No SEND_EMAIL binding => verification not enforced => auto sign-in.
      expect(typeof body.token).toBe("string");
    },
    WORKER_AUTH_TIMEOUT_MS,
  );
});

describe("email verification link", () => {
  async function verificationPath(email: string) {
    const token = await createEmailVerificationToken(env.BETTER_AUTH_SECRET as string, email);
    return `/api/auth/verify-email?token=${token}&callbackURL=%2Fverify-email`;
  }

  async function sessionUser(jar: Jar) {
    const { json } = await callWorker("GET", "/api/auth/get-session", { jar });
    return (json?.user ?? null) as { email: string; emailVerified: boolean } | null;
  }

  test(
    "verifies the address without signing in a browser that holds no session, even past 2FA",
    async () => {
      withEmailBinding();
      const email = await signUp(new Map());
      const db = createDb(env.DB);
      await db
        .update(schema.user)
        .set({ twoFactorEnabled: true })
        .where(eq(schema.user.email, email));

      const inboxOnly: Jar = new Map();
      const { res } = await callWorker("GET", await verificationPath(email), { jar: inboxOnly });

      expect(res.status).toBe(302);
      expect(res.headers.get("set-cookie") ?? "").not.toContain("session_token");
      expect(await sessionUser(inboxOnly)).toBeNull();
      const [row] = await db
        .select({ emailVerified: schema.user.emailVerified })
        .from(schema.user)
        .where(eq(schema.user.email, email));
      expect(row?.emailVerified).toBe(true);
    },
    WORKER_AUTH_TIMEOUT_MS,
  );

  test(
    "refreshes the verified state of the session that opened it",
    async () => {
      withEmailBinding();
      const jar: Jar = new Map();
      const email = await signUp(jar);
      expect((await sessionUser(jar))?.emailVerified).toBe(false);

      const { res } = await callWorker("GET", await verificationPath(email), { jar });

      expect(res.status).toBe(302);
      // Read through the cookie cache, which would otherwise still say false.
      expect(await sessionUser(jar)).toMatchObject({ email, emailVerified: true });
    },
    WORKER_AUTH_TIMEOUT_MS,
  );

  test(
    "opened in a browser signed in to another account, verifies the link's account only",
    async () => {
      withEmailBinding();
      const linkOwner = await signUp(new Map());
      const other: Jar = new Map();
      const otherEmail = await signUp(other);

      const { res } = await callWorker("GET", await verificationPath(linkOwner), { jar: other });

      expect(res.status).toBe(302);
      expect(await sessionUser(other)).toMatchObject({ email: otherEmail, emailVerified: false });
      const db = createDb(env.DB);
      const [row] = await db
        .select({ emailVerified: schema.user.emailVerified })
        .from(schema.user)
        .where(eq(schema.user.email, linkOwner));
      expect(row?.emailVerified).toBe(true);
    },
    WORKER_AUTH_TIMEOUT_MS,
  );

  test(
    "leaves change-email off, whose verification branches would sign the link's holder in",
    async () => {
      const jar: Jar = new Map();
      await signUp(jar);

      const { res, json } = await callWorker("POST", "/api/auth/change-email", {
        body: { newEmail: `moved-${crypto.randomUUID()}@example.test` },
        jar,
      });

      expect(res.status).toBe(400);
      expect(json?.code).toBe("CHANGE_EMAIL_DISABLED");
    },
    WORKER_AUTH_TIMEOUT_MS,
  );
});
