import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import * as OTPAuth from "otpauth";
import worker from "../../server";
import { createDb } from "../../server/db/client";
import {
  ensurePersonalOrganization,
  setRequireTwoFactorForReleaseDecisions,
} from "../../server/db/organizations";
import { createScanJob, persistScan } from "../../server/db/scans";
import * as schema from "../../server/db/schema";
import { personalOrganizationId } from "../../server/lib/auth/ownership";

/**
 * A pushed release can be approved before any deployment gate exists, and a
 * gate that binds to it later delivers that decision to GitHub — which releases
 * the held publish job. So a decision on a release-set scan is exactly as
 * irreversible as a decision on a gate, and must carry the same step-up.
 *
 * These specs exist because the plain scan decision route deliberately does
 * *not* require 2FA for staged-publish scans (an audit record that publishes
 * nothing). Without the release-gating distinction, the push path would be a way
 * around an organization's release 2FA policy.
 */

const ORIGIN = "http://example.com";
const PASSWORD = "correct horse battery staple";

type Jar = Map<string, string>;

function mergeSetCookies(jar: Jar, res: Response) {
  for (const raw of res.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(";");
    const index = pair.indexOf("=");
    if (index === -1) continue;
    jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
  }
}

async function call(
  method: string,
  path: string,
  opts: { body?: unknown; jar?: Jar } = {},
): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const ctx = createExecutionContext();
  const headers = new Headers();
  if (opts.body !== undefined) headers.set("content-type", "application/json");
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) headers.set("origin", ORIGIN);
  if (opts.jar?.size) {
    headers.set(
      "cookie",
      [...opts.jar.entries()].map(([key, value]) => `${key}=${value}`).join("; "),
    );
  }
  const res = await worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers,
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  if (opts.jar) mergeSetCookies(opts.jar, res);
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function signUp(jar: Jar): Promise<string> {
  const email = `ci2fa-${crypto.randomUUID()}@example.test`;
  const up = await call("POST", "/api/auth/sign-up/email", {
    body: { name: "CI Tester", email, password: PASSWORD },
    jar,
  });
  expect(up.status).toBe(200);
  const session = await call("GET", "/api/auth/get-session", { jar });
  const user = session.json?.user as { id: string } | undefined;
  expect(user?.id).toBeTruthy();
  const userId = user!.id;
  // The personal organization row is created lazily; the seed helpers below
  // insert rows that reference it.
  await ensurePersonalOrganization(createDb(env.DB), { userId });
  return userId;
}

async function enrollTwoFactor(jar: Jar): Promise<string> {
  const enable = await call("POST", "/api/auth/two-factor/enable", {
    body: { password: PASSWORD },
    jar,
  });
  expect(enable.status).toBe(200);
  const totpURI = enable.json?.totpURI as string;
  const verify = await call("POST", "/api/auth/two-factor/verify-totp", {
    body: { code: (OTPAuth.URI.parse(totpURI) as OTPAuth.TOTP).generate() },
    jar,
  });
  expect(verify.status).toBe(200);
  return totpURI;
}

/**
 * A completed scan attached to a release set (no gate yet) — the state a
 * maintainer decides in when CI pushed the release during the build.
 */
async function seedReleaseSetScan(
  organizationId: string,
  ownerUserId: string,
): Promise<{ scanId: string; releaseSetId: string }> {
  const db = createDb(env.DB);
  const now = new Date();
  const installation = await db
    .insert(schema.githubAppInstallations)
    .values({
      id: crypto.randomUUID(),
      organizationId,
      installationId: `${Math.floor(Math.random() * 1e9)}`,
      accountLogin: "octo",
      accountType: "Organization",
      targetType: "Organization",
      status: "active",
      installedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: schema.githubAppInstallations.id });

  const releaseSetId = crypto.randomUUID();
  await db.insert(schema.ciReleaseSets).values({
    id: releaseSetId,
    organizationId,
    installationRowId: installation[0].id,
    repositoryId: Math.floor(Math.random() * 1e6) + 1,
    repositoryFullName: "octo/example",
    runId: Math.floor(Math.random() * 1e6) + 1,
    runAttempt: 1,
    releaseKey: "",
    status: "reviewed",
    createdAt: now,
    updatedAt: now,
  });

  const scanId = `scan_${crypto.randomUUID()}`;
  const stageId = `ci-release:${releaseSetId}:npm:pkg`;
  await createScanJob(db, {
    id: scanId,
    stageId,
    organizationId,
    ownerUserId,
    source: "ci_release",
    releaseSetId,
  });
  await persistScan(db, {
    id: scanId,
    stageId,
    organizationId,
    ownerUserId,
    packageJson: { name: "pkg", version: "1.0.0" },
    previousPackageJson: null,
    risk: "low",
    status: "complete",
    summary: { diff: [] },
    ai: null,
    files: [],
    previousFiles: [],
    diff: [],
    findings: [],
  });
  return { scanId, releaseSetId };
}

/** A staged-publish scan: deciding it records an opinion and publishes nothing. */
async function seedStagedScan(organizationId: string, ownerUserId: string): Promise<string> {
  const db = createDb(env.DB);
  const scanId = `scan_${crypto.randomUUID()}`;
  await createScanJob(db, {
    id: scanId,
    stageId: `stage-${crypto.randomUUID()}`,
    organizationId,
    ownerUserId,
    source: "manual",
  });
  await persistScan(db, {
    id: scanId,
    stageId: `stage-${scanId}`,
    organizationId,
    ownerUserId,
    packageJson: { name: "pkg", version: "1.0.0" },
    previousPackageJson: null,
    risk: "low",
    status: "complete",
    summary: { diff: [] },
    ai: null,
    files: [],
    previousFiles: [],
    diff: [],
    findings: [],
  });
  return scanId;
}

describe("release-set decision 2FA step-up", () => {
  test("an enrolled maintainer must present a fresh code", { timeout: 30_000 }, async () => {
    const jar: Jar = new Map();
    const userId = await signUp(jar);
    const totpURI = await enrollTwoFactor(jar);
    const organizationId = personalOrganizationId(userId);
    const { scanId } = await seedReleaseSetScan(organizationId, userId);

    const withoutCode = await call("POST", `/api/v1/scans/${scanId}/decision`, {
      body: { decision: "publish" },
      jar,
    });
    expect(withoutCode.status).toBe(401);
    expect(withoutCode.json?.code).toBe("two_factor_required");

    const withCode = await call("POST", `/api/v1/scans/${scanId}/decision`, {
      body: {
        decision: "publish",
        totpCode: (OTPAuth.URI.parse(totpURI) as OTPAuth.TOTP).generate(),
      },
      jar,
    });
    expect(withCode.status).toBe(200);
  });

  test("an invalid code is refused", { timeout: 30_000 }, async () => {
    const jar: Jar = new Map();
    const userId = await signUp(jar);
    await enrollTwoFactor(jar);
    const organizationId = personalOrganizationId(userId);
    const { scanId } = await seedReleaseSetScan(organizationId, userId);

    const result = await call("POST", `/api/v1/scans/${scanId}/decision`, {
      body: { decision: "publish", totpCode: "000000" },
      jar,
    });
    expect(result.status).toBe(401);
    expect(result.json?.code).toBe("two_factor_invalid");
  });

  test("an org policy blocks an unenrolled maintainer outright", { timeout: 30_000 }, async () => {
    const jar: Jar = new Map();
    const userId = await signUp(jar);
    const organizationId = personalOrganizationId(userId);
    await setRequireTwoFactorForReleaseDecisions(createDb(env.DB), organizationId, true);
    const { scanId } = await seedReleaseSetScan(organizationId, userId);

    const result = await call("POST", `/api/v1/scans/${scanId}/decision`, {
      body: { decision: "publish" },
      jar,
    });
    expect(result.status).toBe(403);
    expect(result.json?.code).toBe("two_factor_enrollment_required");
  });

  test(
    "a maintainer without 2FA decides an unenforced release without a code",
    { timeout: 30_000 },
    async () => {
      const jar: Jar = new Map();
      const userId = await signUp(jar);
      const organizationId = personalOrganizationId(userId);
      const { scanId } = await seedReleaseSetScan(organizationId, userId);

      const result = await call("POST", `/api/v1/scans/${scanId}/decision`, {
        body: { decision: "publish" },
        jar,
      });
      expect(result.status).toBe(200);
    },
  );

  test("a staged-publish decision still needs no step-up", { timeout: 30_000 }, async () => {
    const jar: Jar = new Map();
    const userId = await signUp(jar);
    await enrollTwoFactor(jar);
    const organizationId = personalOrganizationId(userId);
    const scanId = await seedStagedScan(organizationId, userId);

    // Nothing publishes off the back of this decision, so requiring a code
    // here would be friction without a corresponding risk.
    const result = await call("POST", `/api/v1/scans/${scanId}/decision`, {
      body: { decision: "publish" },
      jar,
    });
    expect(result.status).toBe(200);
  });
});
