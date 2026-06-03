import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, test, vi } from "vitest";
import worker from "../../server/index";
import { createDb } from "../../server/db";
import * as schema from "../../server/db/schema";

const ORIGIN = "http://example.com";
const PASSWORD = "correct horse battery staple";
const WORKER_AUTH_TIMEOUT_MS = 15_000;

function uniqueEmail() {
  return `verify-${crypto.randomUUID()}@example.test`;
}

async function authPost(path: string, body: unknown) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
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

afterEach(() => {
  clearEmailBinding();
});

describe("email verification gating", () => {
  test(
    "with email configured, sign-up sends a verification email and withholds the session",
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
      // requireEmailVerification withholds auto sign-in: no session token is issued.
      expect(body.token).toBeNull();
      expect(res.headers.get("set-cookie") ?? "").not.toContain("session_token");
      // The verification email was dispatched through the configured binding.
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
    "unverified sign-in is blocked and re-sends the verification link",
    async () => {
      const { send } = withEmailBinding();
      const email = uniqueEmail();

      await authPost("/api/auth/sign-up/email", {
        name: "Verify Tester",
        email,
        password: PASSWORD,
        callbackURL: "/verify-email",
      });
      send.mockClear();

      const res = await authPost("/api/auth/sign-in/email", { email, password: PASSWORD });

      expect(res.status).toBe(403);
      const body = (await res.json()) as { code?: string };
      expect(body.code).toBe("EMAIL_NOT_VERIFIED");
      // sendOnSignIn re-dispatches a fresh link so the user can recover from here.
      expect(send).toHaveBeenCalledTimes(1);
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
