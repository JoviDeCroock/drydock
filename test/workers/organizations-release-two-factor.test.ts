import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { createDb } from "../../server/db/client";
import {
  ensurePersonalOrganization,
  organizationRequiresTwoFactorForReleaseDecisions,
  setRequireTwoFactorForReleaseDecisions,
} from "../../server/db/organizations";
import { personalOrganizationId } from "../../server/lib/auth/ownership";
import { callWorker, type Jar, PASSWORD, signUpUserId, totpFor } from "./helpers/auth-http";

// The owner-only release-two-factor toggle is itself 2FA-guarded, mirroring the
// gate decision it governs: enabling requires the owner be enrolled (you cannot
// mandate a control you have not adopted), and *relaxing* it — the
// security-weakening direction — demands a fresh TOTP step-up, not just a live
// session. These specs drive the real worker end to end (real session cookies +
// Better Auth TOTP enrollment) so the step-up is exercised exactly as the
// browser hits it; the stub-harness specs in organizations-routes.test.ts cover
// the enrollment gate and the no-code path that need no real authenticator.

async function enrollTwoFactor(jar: Jar): Promise<string> {
  const enable = await callWorker("POST", "/api/auth/two-factor/enable", {
    body: { password: PASSWORD },
    jar,
  });
  expect(enable.res.status).toBe(200);
  const totpURI = enable.json?.totpURI as string;
  expect(typeof totpURI).toBe("string");
  const verify = await callWorker("POST", "/api/auth/two-factor/verify-totp", {
    body: { code: totpFor(totpURI) },
    jar,
  });
  expect(verify.res.status).toBe(200);
  return totpURI;
}

async function setUpOwner(): Promise<{ jar: Jar; userId: string; organizationId: string }> {
  const jar: Jar = new Map();
  const userId = await signUpUserId(jar);
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

    const res = await callWorker("PUT", releasePath(organizationId), {
      body: { enabled: true },
      jar,
    });

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

    const res = await callWorker("PUT", releasePath(organizationId), {
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

      const res = await callWorker("PUT", releasePath(organizationId), {
        body: { enabled: false },
        jar,
      });

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

      const res = await callWorker("PUT", releasePath(organizationId), {
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

    const res = await callWorker("PUT", releasePath(organizationId), {
      body: { enabled: true },
      jar,
    });

    expect(res.res.status).toBe(403);
    expect(res.json).toMatchObject({ code: "two_factor_enrollment_required" });
    expect(
      await organizationRequiresTwoFactorForReleaseDecisions(createDb(env.DB), organizationId),
    ).toBe(false);
  });
});
