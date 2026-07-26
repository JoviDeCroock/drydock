import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import * as OTPAuth from "otpauth";
import worker from "../../server";

const ORIGIN = "http://example.com";
const PASSWORD = "correct horse battery staple";

type Jar = Map<string, string>;

function mergeSetCookies(jar: Jar, res: Response) {
  const cookies = res.headers.getSetCookie?.() ?? [];
  for (const raw of cookies) {
    const [pair] = raw.split(";");
    const idx = pair.indexOf("=");
    if (idx === -1) continue;
    jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
  }
}

function cookieHeader(jar: Jar): string {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

interface CallOptions {
  body?: unknown;
  jar?: Jar;
  ip?: string;
}

async function call(method: string, path: string, opts: CallOptions = {}) {
  const ctx = createExecutionContext();
  const headers = new Headers();
  if (opts.body !== undefined) headers.set("content-type", "application/json");
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) headers.set("origin", ORIGIN);
  if (opts.jar && opts.jar.size) headers.set("cookie", cookieHeader(opts.jar));
  if (opts.ip) headers.set("cf-connecting-ip", opts.ip);
  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
  const res = await worker.fetch(new Request(`${ORIGIN}${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  if (opts.jar) mergeSetCookies(opts.jar, res);
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { res, json: json as Record<string, unknown> | null, text };
}

function totpFor(totpURI: string): string {
  const parsed = OTPAuth.URI.parse(totpURI) as OTPAuth.TOTP;
  return parsed.generate();
}

async function signUp(jar: Jar, email: string) {
  const { res } = await call("POST", "/api/auth/sign-up/email", {
    body: { name: "2FA Tester", email, password: PASSWORD },
    jar,
  });
  expect(res.status).toBe(200);
}

describe("two-factor routes", () => {
  test(
    "full TOTP enrollment, sign-in challenge, backup code, and disable",
    { timeout: 30_000 },
    async () => {
      const email = `tf-${crypto.randomUUID()}@example.test`;
      const jar: Jar = new Map();
      await signUp(jar, email);

      // Enable: returns the otpauth URI and backup codes.
      const enable = await call("POST", "/api/auth/two-factor/enable", {
        body: { password: PASSWORD },
        jar,
      });
      expect(enable.res.status).toBe(200);
      const totpURI = enable.json?.totpURI as string;
      const backupCodes = enable.json?.backupCodes as string[];
      expect(typeof totpURI).toBe("string");
      expect(Array.isArray(backupCodes)).toBe(true);
      expect(backupCodes.length).toBeGreaterThan(0);

      // Confirm enrollment with a freshly generated TOTP code.
      const verify = await call("POST", "/api/auth/two-factor/verify-totp", {
        body: { code: totpFor(totpURI) },
        jar,
      });
      expect(verify.res.status).toBe(200);

      // Session now reports two-factor enabled.
      const session = await call("GET", "/api/auth/get-session", { jar });
      expect((session.json?.user as { twoFactorEnabled?: boolean })?.twoFactorEnabled).toBe(true);

      // Sign out, then sign in again — should be redirected to the 2FA challenge.
      await call("POST", "/api/auth/sign-out", { jar });
      const freshJar: Jar = new Map();
      const signIn = await call("POST", "/api/auth/sign-in/email", {
        body: { email, password: PASSWORD },
        jar: freshJar,
      });
      expect(signIn.res.status).toBe(200);
      expect(signIn.json?.twoFactorRedirect).toBe(true);

      // No authenticated session until the second factor is provided.
      const pending = await call("GET", "/api/auth/get-session", { jar: freshJar });
      expect(pending.json?.user).toBeFalsy();

      // Complete sign-in with a backup code.
      const backup = await call("POST", "/api/auth/two-factor/verify-backup-code", {
        body: { code: backupCodes[0] },
        jar: freshJar,
      });
      expect(backup.res.status).toBe(200);
      const authed = await call("GET", "/api/auth/get-session", { jar: freshJar });
      expect((authed.json?.user as { email?: string })?.email).toBe(email);

      // Disable two-factor.
      const disable = await call("POST", "/api/auth/two-factor/disable", {
        body: { password: PASSWORD },
        jar: freshJar,
      });
      expect(disable.res.status).toBe(200);
      const after = await call("GET", "/api/auth/get-session", { jar: freshJar });
      expect((after.json?.user as { twoFactorEnabled?: boolean })?.twoFactorEnabled).toBeFalsy();
    },
  );

  test("rate limits two-factor verification attempts per IP", async () => {
    const ip = `203.0.113.${Math.floor(Math.random() * 250) + 1}`;
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      const { res } = await call("POST", "/api/auth/two-factor/verify-totp", {
        body: { code: "000000" },
        ip,
      });
      statuses.push(res.status);
    }
    // The limit is 10 per window; the 11th request (index 10) is rejected.
    expect(statuses.slice(0, 10).every((s) => s !== 429)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});
