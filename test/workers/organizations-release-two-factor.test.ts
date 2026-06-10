import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import * as OTPAuth from "otpauth";
import worker from "../../server/index";
import {
  createDb,
  ensurePersonalOrganization,
  organizationRequiresTwoFactorForReleaseDecisions,
  setRequireTwoFactorForReleaseDecisions,
} from "../../server/db";
import { personalOrganizationId } from "../../server/lib/ownership";

// The owner-only release-two-factor toggle is itself 2FA-guarded, mirroring the
// gate decision it governs: enabling requires the owner be enrolled (you cannot
// mandate a control you have not adopted), and *relaxing* it — the
// security-weakening direction — demands a fresh TOTP step-up, not just a live
// session. These specs drive the real worker end to end (real session cookies +
// Better Auth TOTP enrollment) so the step-up is exercised exactly as the
// browser hits it; the stub-harness specs in organizations-routes.test.ts cover
// the enrollment gate and the no-code path that need no real authenticator.

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

async function call(method: string, path: string, opts: { body?: unknown; jar?: Jar } = {}) {
  const ctx = createExecutionContext();
  const headers = new Headers();
  if (opts.body !== undefined) headers.set("content-type", "application/json");
  // Non-GET requests are CSRF-checked against the request origin.
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) headers.set("origin", ORIGIN);
  if (opts.jar && opts.jar.size) headers.set("cookie", cookieHeader(opts.jar));
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
  return { res, json: json as Record<string, unknown> | null };
}

function totpFor(totpURI: string): string {
  const parsed = OTPAuth.URI.parse(totpURI) as OTPAuth.TOTP;
  return parsed.generate();
}

async function signUp(jar: Jar): Promise<string> {
  const email = `release2fa-${crypto.randomUUID()}@example.test`;
  const up = await call("POST", "/api/auth/sign-up/email", {
    body: { name: "Release Tester", email, password: PASSWORD },
    jar,
  });
  expect(up.res.status).toBe(200);
  const session = await call("GET", "/api/auth/get-session", { jar });
  const userId = (session.json?.user as { id?: string } | undefined)?.id;
  expect(typeof userId).toBe("string");
  return userId as string;
}

async function enrollTwoFactor(jar: Jar): Promise<string> {
  const enable = await call("POST", "/api/auth/two-factor/enable", {
    body: { password: PASSWORD },
    jar,
  });
  expect(enable.res.status).toBe(200);
  const totpURI = enable.json?.totpURI as string;
  expect(typeof totpURI).toBe("string");
  const verify = await call("POST", "/api/auth/two-factor/verify-totp", {
    body: { code: totpFor(totpURI) },
    jar,
  });
  expect(verify.res.status).toBe(200);
  return totpURI;
}

async function setUpOwner(): Promise<{ jar: Jar; userId: string; organizationId: string }> {
  const jar: Jar = new Map();
  const userId = await signUp(jar);
  const organizationId = personalOrganizationId(userId);
  await ensurePersonalOrganization(createDb(env.DB), { userId });
  return { jar, userId, organizationId };
}

const releasePath = (organizationId: string) =>
  `/api/v1/organizations/${organizationId}/release-two-factor`;

describe("release-two-factor toggle 2FA guard", () => {
  test("an enrolled owner enables the policy without a code", { timeout: 30_000 }, async () => {
    const { jar, organizationId } = await setUpOwner();
    await enrollTwoFactor(jar);

    const res = await call("PUT", releasePath(organizationId), { body: { enabled: true }, jar });

    expect(res.res.status).toBe(200);
    expect(res.json).toMatchObject({ requireTwoFactorForReleaseDecisions: true });
    expect(
      await organizationRequiresTwoFactorForReleaseDecisions(createDb(env.DB), organizationId),
    ).toBe(true);
  });

  test("an enrolled owner relaxes the policy with a fresh code", { timeout: 30_000 }, async () => {
    const { jar, organizationId } = await setUpOwner();
    const totpURI = await enrollTwoFactor(jar);
    await setRequireTwoFactorForReleaseDecisions(createDb(env.DB), organizationId, true);

    const res = await call("PUT", releasePath(organizationId), {
      body: { enabled: false, totpCode: totpFor(totpURI) },
      jar,
    });

    expect(res.res.status).toBe(200);
    expect(res.json).toMatchObject({ requireTwoFactorForReleaseDecisions: false });
    expect(
      await organizationRequiresTwoFactorForReleaseDecisions(createDb(env.DB), organizationId),
    ).toBe(false);
  });

  test(
    "an enrolled owner cannot relax the policy without a code",
    { timeout: 30_000 },
    async () => {
      const { jar, organizationId } = await setUpOwner();
      await enrollTwoFactor(jar);
      await setRequireTwoFactorForReleaseDecisions(createDb(env.DB), organizationId, true);

      const res = await call("PUT", releasePath(organizationId), { body: { enabled: false }, jar });

      expect(res.res.status).toBe(401);
      expect(res.json).toMatchObject({ code: "two_factor_required" });
      // The hardened policy is left in place — a failed step-up never weakens it.
      expect(
        await organizationRequiresTwoFactorForReleaseDecisions(createDb(env.DB), organizationId),
      ).toBe(true);
    },
  );

  test(
    "an enrolled owner cannot relax the policy with an invalid code",
    { timeout: 30_000 },
    async () => {
      const { jar, organizationId } = await setUpOwner();
      await enrollTwoFactor(jar);
      await setRequireTwoFactorForReleaseDecisions(createDb(env.DB), organizationId, true);

      const res = await call("PUT", releasePath(organizationId), {
        body: { enabled: false, totpCode: "000000" },
        jar,
      });

      expect(res.res.status).toBe(401);
      expect(res.json).toMatchObject({ code: "two_factor_invalid" });
      expect(
        await organizationRequiresTwoFactorForReleaseDecisions(createDb(env.DB), organizationId),
      ).toBe(true);
    },
  );

  test("an owner without 2FA cannot enable the policy", { timeout: 30_000 }, async () => {
    const { jar, organizationId } = await setUpOwner();

    const res = await call("PUT", releasePath(organizationId), { body: { enabled: true }, jar });

    expect(res.res.status).toBe(403);
    expect(res.json).toMatchObject({ code: "two_factor_enrollment_required" });
    expect(
      await organizationRequiresTwoFactorForReleaseDecisions(createDb(env.DB), organizationId),
    ).toBe(false);
  });
});
