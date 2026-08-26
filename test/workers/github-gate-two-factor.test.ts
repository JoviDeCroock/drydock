import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as OTPAuth from "otpauth";
import worker from "../../server";
import { createDb } from "../../server/db/client";
import {
  ensurePersonalOrganization,
  setRequireTwoFactorForReleaseDecisions,
} from "../../server/db/organizations";
import { createScanJob } from "../../server/db/scans";
import * as schema from "../../server/db/schema";
import { createReleaseTarget, upsertInstallation } from "../../server/lib/github-app/persistence";
import { getGateForOrganization } from "../../server/lib/github-app/webhook-gates";
import { personalOrganizationId } from "../../server/lib/auth/ownership";
import { persistScanWithArtifacts } from "./helpers/persist-scan";

// 2FA gate-decision step-up is the trust boundary in issue #162: a maintainer
// who enrolled in two-factor auth must prove a *fresh* second factor before a
// held GitHub deployment is released or blocked. These specs drive the real
// worker end to end (real session cookies + Better Auth TOTP enrollment) so the
// step-up is exercised exactly as the browser hits it. The staged-publish
// decision (`/api/v1/scans/:id/decision`) intentionally never requires this and
// is covered separately.

const ORIGIN = "http://example.com";
const PASSWORD = "correct horse battery staple";
const originalFetch = globalThis.fetch;

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
  env?: typeof env;
}

async function call(method: string, path: string, opts: CallOptions = {}) {
  const ctx = createExecutionContext();
  const headers = new Headers();
  if (opts.body !== undefined) headers.set("content-type", "application/json");
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) headers.set("origin", ORIGIN);
  if (opts.jar && opts.jar.size) headers.set("cookie", cookieHeader(opts.jar));
  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
  const res = await worker.fetch(new Request(`${ORIGIN}${path}`, init), opts.env ?? env, ctx);
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

let testPrivateKeyPem: string | null = null;
async function getTestPrivateKeyPem(): Promise<string> {
  if (testPrivateKeyPem) return testPrivateKeyPem;
  const keyPair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
  let binary = "";
  for (const byte of new Uint8Array(pkcs8)) binary += String.fromCharCode(byte);
  const base64 = btoa(binary);
  const lines = base64.match(/.{1,64}/g)?.join("\n") ?? base64;
  testPrivateKeyPem = `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----`;
  return testPrivateKeyPem;
}

// The GitHub App env the decision-delivery path needs to mint an installation
// token and POST the deployment callback. Shares BETTER_AUTH_SECRET/URL with the
// base test env so session cookies minted during sign-up stay valid.
async function githubEnv(): Promise<typeof env> {
  return {
    ...env,
    GITHUB_APP_ID: "12345",
    GITHUB_APP_SLUG: "drydock-test",
    GITHUB_APP_CLIENT_ID: "client-id",
    GITHUB_APP_CLIENT_SECRET: "client-secret",
    GITHUB_APP_PRIVATE_KEY: await getTestPrivateKeyPem(),
    GITHUB_APP_WEBHOOK_SECRET: "webhook-secret-value-1234567890",
    GITHUB_APP_STATE_SECRET: "0123456789abcdef0123456789abcdef",
  } as typeof env;
}

function totpFor(totpURI: string): string {
  const parsed = OTPAuth.URI.parse(totpURI) as OTPAuth.TOTP;
  return parsed.generate();
}

async function signUp(jar: Jar): Promise<string> {
  const email = `gate2fa-${crypto.randomUUID()}@example.test`;
  const up = await call("POST", "/api/auth/sign-up/email", {
    body: { name: "Gate Tester", email, password: PASSWORD },
    jar,
  });
  expect(up.res.status).toBe(200);
  const session = await call("GET", "/api/auth/get-session", { jar });
  const userId = (session.json?.user as { id?: string } | undefined)?.id;
  expect(typeof userId).toBe("string");
  return userId as string;
}

// Enroll the signed-in user in TOTP 2FA and return the otpauth URI so the spec
// can mint fresh codes at decision time.
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

// Seed an installation + release target + a pending gate whose linked review
// scan is already complete, so the gate is decidable (approval requires it).
async function seedDecidableGate(
  organizationId: string,
  ownerUserId: string,
  options: { completeScan?: boolean } = {},
): Promise<{ gateId: string; scanId: string }> {
  const completeScan = options.completeScan ?? true;
  const db = createDb(env.DB);
  const now = new Date();
  const installation = await upsertInstallation(db, {
    organizationId,
    installationId: `${Math.floor(Math.random() * 1e9)}`,
    accountLogin: "octo",
    accountType: "Organization",
    targetType: "Organization",
    status: "active",
    createdByUserId: null,
  });
  const runId = Math.floor(Math.random() * 1e6) + 1;
  const releaseTarget = await createReleaseTarget(db, {
    organizationId,
    installationRowId: installation.id,
    ecosystem: "pypi",
    repositoryId: Math.floor(Math.random() * 1e6) + 1,
    repositoryFullName: "octo/example",
    environment: "pypi",
    createdByUserId: null,
  });
  const gateId = crypto.randomUUID();
  const scanId = `scan_${crypto.randomUUID()}`;
  // scans.gate_id references the gate and the gate's scanId references the scan,
  // so insert the gate first (scanId null), create the per-package scan linked
  // via gateId, then point the gate at it (mirroring attachScanToGate) once the
  // scan is complete — avoiding the circular foreign key.
  await db.insert(schema.githubWorkflowGates).values({
    id: gateId,
    organizationId,
    installationRowId: installation.id,
    releaseTargetId: releaseTarget.id,
    deliveryId: crypto.randomUUID(),
    repositoryId: releaseTarget.repositoryId,
    repositoryFullName: "octo/example",
    environment: "pypi",
    runId,
    deploymentId: 909,
    deploymentCallbackUrl: `https://api.github.com/repos/octo/example/actions/runs/${runId}/deployment_protection_rule`,
    eventAction: "requested",
    status: "pending",
    decision: null,
    scanId: null,
    requestedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  await createScanJob(db, {
    id: scanId,
    stageId: `workflow-gate:${gateId}`,
    organizationId,
    ownerUserId,
    source: "workflow_gate",
    gateId,
  });
  if (completeScan) {
    await persistScanWithArtifacts(db, {
      id: scanId,
      stageId: `workflow-gate:${gateId}`,
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
    await db
      .update(schema.githubWorkflowGates)
      .set({ scanId })
      .where(eq(schema.githubWorkflowGates.id, gateId));
  }
  return { gateId, scanId };
}

// Mocks the two GitHub calls the delivery path makes (install token + callback)
// and records each posted decision state.
function mockGithubDecisionFetch(decisionCalls: { state: string }[]) {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (request.url.includes("/access_tokens")) {
      return Response.json({ token: "ghs_install_token", expires_at: "2099-01-01T00:00:00Z" });
    }
    if (request.url.endsWith("/deployment_protection_rule")) {
      decisionCalls.push((await request.json()) as { state: string });
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected fetch in gate 2FA test: ${request.url}`);
  });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("workflow-gate decision 2FA step-up", () => {
  test(
    "an enrolled maintainer is not prompted for 2FA when approval is not yet allowed",
    { timeout: 30_000 },
    async () => {
      const jar: Jar = new Map();
      const userId = await signUp(jar);
      await enrollTwoFactor(jar);
      const organizationId = personalOrganizationId(userId);
      await ensurePersonalOrganization(createDb(env.DB), { userId });
      const { gateId, scanId } = await seedDecidableGate(organizationId, userId, {
        completeScan: false,
      });

      const decisionCalls: { state: string }[] = [];
      mockGithubDecisionFetch(decisionCalls);

      const res = await call("POST", `/api/v1/github-app/workflow-gates/${gateId}/decision`, {
        body: { decision: "approved", scanId },
        jar,
        env: await githubEnv(),
      });

      expect(res.res.status).toBe(409);
      expect(res.json).toMatchObject({
        error: "scanId is not a reviewable package of this gate",
      });
      const stored = await getGateForOrganization(createDb(env.DB), organizationId, gateId);
      expect(stored?.status).toBe("pending");
      expect(decisionCalls).toHaveLength(0);
    },
  );

  test(
    "an enrolled maintainer cannot decide a gate without a fresh code",
    { timeout: 30_000 },
    async () => {
      const jar: Jar = new Map();
      const userId = await signUp(jar);
      await enrollTwoFactor(jar);
      const organizationId = personalOrganizationId(userId);
      await ensurePersonalOrganization(createDb(env.DB), { userId });
      const { gateId, scanId } = await seedDecidableGate(organizationId, userId);

      const decisionCalls: { state: string }[] = [];
      mockGithubDecisionFetch(decisionCalls);

      const res = await call("POST", `/api/v1/github-app/workflow-gates/${gateId}/decision`, {
        body: { decision: "approved", scanId },
        jar,
        env: await githubEnv(),
      });

      expect(res.res.status).toBe(401);
      expect(res.json).toMatchObject({ code: "two_factor_required" });
      // The gate is untouched and GitHub was never told to release the job.
      const stored = await getGateForOrganization(createDb(env.DB), organizationId, gateId);
      expect(stored?.status).toBe("pending");
      expect(decisionCalls).toHaveLength(0);
    },
  );

  test(
    "an enrolled maintainer cannot decide a gate with an invalid code",
    { timeout: 30_000 },
    async () => {
      const jar: Jar = new Map();
      const userId = await signUp(jar);
      await enrollTwoFactor(jar);
      const organizationId = personalOrganizationId(userId);
      await ensurePersonalOrganization(createDb(env.DB), { userId });
      const { gateId, scanId } = await seedDecidableGate(organizationId, userId);

      const decisionCalls: { state: string }[] = [];
      mockGithubDecisionFetch(decisionCalls);

      const res = await call("POST", `/api/v1/github-app/workflow-gates/${gateId}/decision`, {
        body: { decision: "approved", totpCode: "000000", scanId },
        jar,
        env: await githubEnv(),
      });

      expect(res.res.status).toBe(401);
      expect(res.json).toMatchObject({ code: "two_factor_invalid" });
      const stored = await getGateForOrganization(createDb(env.DB), organizationId, gateId);
      expect(stored?.status).toBe("pending");
      expect(decisionCalls).toHaveLength(0);
    },
  );

  test(
    "a fresh TOTP step-up releases the gate and posts to GitHub once",
    { timeout: 30_000 },
    async () => {
      const jar: Jar = new Map();
      const userId = await signUp(jar);
      const totpURI = await enrollTwoFactor(jar);
      const organizationId = personalOrganizationId(userId);
      await ensurePersonalOrganization(createDb(env.DB), { userId });
      const { gateId, scanId } = await seedDecidableGate(organizationId, userId);

      const decisionCalls: { state: string }[] = [];
      mockGithubDecisionFetch(decisionCalls);

      const res = await call("POST", `/api/v1/github-app/workflow-gates/${gateId}/decision`, {
        body: { decision: "approved", totpCode: totpFor(totpURI), scanId },
        jar,
        env: await githubEnv(),
      });

      expect(res.res.status).toBe(200);
      expect(res.json).toMatchObject({ gate: { status: "approved", decision: "approved" } });
      const stored = await getGateForOrganization(createDb(env.DB), organizationId, gateId);
      expect(stored?.status).toBe("approved");
      expect(decisionCalls).toHaveLength(1);
      expect(decisionCalls[0].state).toBe("approved");
    },
  );

  test("a maintainer without 2FA decides a gate without a code", { timeout: 30_000 }, async () => {
    const jar: Jar = new Map();
    const userId = await signUp(jar);
    const organizationId = personalOrganizationId(userId);
    await ensurePersonalOrganization(createDb(env.DB), { userId });
    const { gateId, scanId } = await seedDecidableGate(organizationId, userId);

    const decisionCalls: { state: string }[] = [];
    mockGithubDecisionFetch(decisionCalls);

    const res = await call("POST", `/api/v1/github-app/workflow-gates/${gateId}/decision`, {
      body: { decision: "approved", scanId },
      jar,
      env: await githubEnv(),
    });

    expect(res.res.status).toBe(200);
    expect(res.json).toMatchObject({ gate: { status: "approved", decision: "approved" } });
    expect(decisionCalls).toHaveLength(1);
  });
});

// When the org turns on `requireTwoFactorForReleaseDecisions`, the per-user
// step-up becomes a hard requirement for *every* member: an unenrolled member is
// blocked outright (must enroll first) and enrolled members must still present a
// fresh code. This is the org-level policy on top of the per-user check above.
describe("workflow-gate decision org-enforced 2FA", () => {
  test(
    "an unenrolled member is blocked when the org requires 2FA",
    { timeout: 30_000 },
    async () => {
      const jar: Jar = new Map();
      const userId = await signUp(jar);
      const organizationId = personalOrganizationId(userId);
      await ensurePersonalOrganization(createDb(env.DB), { userId });
      await setRequireTwoFactorForReleaseDecisions(createDb(env.DB), organizationId, true);
      const { gateId, scanId } = await seedDecidableGate(organizationId, userId);

      const decisionCalls: { state: string }[] = [];
      mockGithubDecisionFetch(decisionCalls);

      const res = await call("POST", `/api/v1/github-app/workflow-gates/${gateId}/decision`, {
        body: { decision: "approved", scanId },
        jar,
        env: await githubEnv(),
      });

      expect(res.res.status).toBe(403);
      expect(res.json).toMatchObject({ code: "two_factor_enrollment_required" });
      // No enrollment, no code, no release: the gate stays held and GitHub is
      // never told to release the job.
      const stored = await getGateForOrganization(createDb(env.DB), organizationId, gateId);
      expect(stored?.status).toBe("pending");
      expect(decisionCalls).toHaveLength(0);
    },
  );

  test(
    "an enrolled member still needs a fresh code when the org requires 2FA",
    { timeout: 30_000 },
    async () => {
      const jar: Jar = new Map();
      const userId = await signUp(jar);
      await enrollTwoFactor(jar);
      const organizationId = personalOrganizationId(userId);
      await ensurePersonalOrganization(createDb(env.DB), { userId });
      await setRequireTwoFactorForReleaseDecisions(createDb(env.DB), organizationId, true);
      const { gateId, scanId } = await seedDecidableGate(organizationId, userId);

      const decisionCalls: { state: string }[] = [];
      mockGithubDecisionFetch(decisionCalls);

      const res = await call("POST", `/api/v1/github-app/workflow-gates/${gateId}/decision`, {
        body: { decision: "approved", scanId },
        jar,
        env: await githubEnv(),
      });

      expect(res.res.status).toBe(401);
      expect(res.json).toMatchObject({ code: "two_factor_required" });
      const stored = await getGateForOrganization(createDb(env.DB), organizationId, gateId);
      expect(stored?.status).toBe("pending");
      expect(decisionCalls).toHaveLength(0);
    },
  );

  test(
    "an enrolled member with a fresh code decides under the org policy",
    { timeout: 30_000 },
    async () => {
      const jar: Jar = new Map();
      const userId = await signUp(jar);
      const totpURI = await enrollTwoFactor(jar);
      const organizationId = personalOrganizationId(userId);
      await ensurePersonalOrganization(createDb(env.DB), { userId });
      await setRequireTwoFactorForReleaseDecisions(createDb(env.DB), organizationId, true);
      const { gateId, scanId } = await seedDecidableGate(organizationId, userId);

      const decisionCalls: { state: string }[] = [];
      mockGithubDecisionFetch(decisionCalls);

      const res = await call("POST", `/api/v1/github-app/workflow-gates/${gateId}/decision`, {
        body: { decision: "approved", totpCode: totpFor(totpURI), scanId },
        jar,
        env: await githubEnv(),
      });

      expect(res.res.status).toBe(200);
      expect(res.json).toMatchObject({
        gate: { status: "approved", decision: "approved", organizationRequiresTwoFactor: true },
      });
      const stored = await getGateForOrganization(createDb(env.DB), organizationId, gateId);
      expect(stored?.status).toBe("approved");
      expect(decisionCalls).toHaveLength(1);
      expect(decisionCalls[0].state).toBe("approved");
    },
  );
});
