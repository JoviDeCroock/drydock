import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { createDb } from "../../server/db/client";
import * as schema from "../../server/db/schema";
import { callWorker, type Jar, PASSWORD, signUp, totpFor } from "./helpers/auth-http";

describe("two-factor routes", () => {
  test(
    "full TOTP enrollment, sign-in challenge, backup code, and disable",
    { timeout: 30_000 },
    async () => {
      const email = `tf-${crypto.randomUUID()}@example.test`;
      const jar: Jar = new Map();
      await signUp(jar, { email });

      // Enable: returns the otpauth URI and backup codes.
      const enable = await callWorker("POST", "/api/auth/two-factor/enable", {
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
      const verify = await callWorker("POST", "/api/auth/two-factor/verify-totp", {
        body: { code: totpFor(totpURI) },
        jar,
      });
      expect(verify.res.status).toBe(200);

      // Session now reports two-factor enabled.
      const session = await callWorker("GET", "/api/auth/get-session", { jar });
      expect((session.json?.user as { twoFactorEnabled?: boolean })?.twoFactorEnabled).toBe(true);

      // Sign out, then sign in again — should be redirected to the 2FA challenge.
      await callWorker("POST", "/api/auth/sign-out", { jar });
      const freshJar: Jar = new Map();
      const signIn = await callWorker("POST", "/api/auth/sign-in/email", {
        body: { email, password: PASSWORD },
        jar: freshJar,
      });
      expect(signIn.res.status).toBe(200);
      expect(signIn.json?.twoFactorRedirect).toBe(true);

      // No authenticated session until the second factor is provided.
      const pending = await callWorker("GET", "/api/auth/get-session", { jar: freshJar });
      expect(pending.json?.user).toBeFalsy();

      // The challenge lives in D1, not only in KV secondary storage: single-use
      // consumption and the attempt counter must stay transactional even with a
      // KV session store configured (`verification.storeInDatabase`).
      const verifications = await createDb(env.DB).select().from(schema.verification);
      expect(verifications.length).toBeGreaterThan(0);

      // Complete sign-in with a backup code.
      const backup = await callWorker("POST", "/api/auth/two-factor/verify-backup-code", {
        body: { code: backupCodes[0] },
        jar: freshJar,
      });
      expect(backup.res.status).toBe(200);
      const authed = await callWorker("GET", "/api/auth/get-session", { jar: freshJar });
      expect((authed.json?.user as { email?: string })?.email).toBe(email);

      // Disable two-factor.
      const disable = await callWorker("POST", "/api/auth/two-factor/disable", {
        body: { password: PASSWORD },
        jar: freshJar,
      });
      expect(disable.res.status).toBe(200);
      const after = await callWorker("GET", "/api/auth/get-session", { jar: freshJar });
      expect((after.json?.user as { twoFactorEnabled?: boolean })?.twoFactorEnabled).toBeFalsy();
    },
  );

  test("rate limits two-factor verification attempts per IP", async () => {
    const ip = `203.0.113.${Math.floor(Math.random() * 250) + 1}`;
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      const { res } = await callWorker("POST", "/api/auth/two-factor/verify-totp", {
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
