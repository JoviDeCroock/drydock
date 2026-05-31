import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { Hono } from "hono";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createDb, ensurePersonalOrganization } from "../../server/db";
import * as schema from "../../server/db/schema";
import { eq } from "drizzle-orm";
import {
  createReleaseTarget,
  getGateByDeliveryId,
  getGateForOrganization,
  markGateDecided,
  markGateErrored,
  upsertInstallation,
} from "../../server/lib/github-app";
import { githubWebhookRoutes } from "../../server/routes/github-webhooks";
import type { Bindings, Variables } from "../../server/types";

const WEBHOOK_SECRET = "webhook-secret-value-1234567890";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function seedUser() {
  const db = createDb(env.DB);
  const now = new Date();
  const userId = `user_${crypto.randomUUID()}`;
  await db.insert(schema.user).values({
    id: userId,
    name: "Tester",
    email: `${userId}@example.com`,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  const organizationId = await ensurePersonalOrganization(db, { userId });
  return { userId, organizationId };
}

async function seedMappedRepository(opts: {
  installationExternalId: string;
  repositoryId: number;
  environment?: string;
}) {
  const { organizationId } = await seedUser();
  const db = createDb(env.DB);
  const installation = await upsertInstallation(db, {
    organizationId,
    installationId: opts.installationExternalId,
    accountLogin: "octo",
    accountType: "Organization",
    targetType: "Organization",
    status: "active",
    createdByUserId: null,
  });
  const releaseTarget = await createReleaseTarget(db, {
    organizationId,
    installationRowId: installation.id,
    ecosystem: "pypi",
    repositoryId: opts.repositoryId,
    repositoryFullName: "octo/example",
    environment: opts.environment ?? "pypi",
    createdByUserId: null,
  });
  return { organizationId, installation, releaseTarget };
}

function buildApp() {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/webhooks", githubWebhookRoutes);
  return app;
}

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return [...sig].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

interface SendArgs {
  eventName: string;
  body: unknown;
  deliveryId?: string;
  signOverride?: string | null;
  headers?: Record<string, string>;
}

async function sendWebhook(args: SendArgs) {
  const rawBody = typeof args.body === "string" ? args.body : JSON.stringify(args.body);
  const deliveryId = args.deliveryId ?? crypto.randomUUID();
  const signature =
    args.signOverride !== undefined
      ? args.signOverride
      : `sha256=${await hmacHex(WEBHOOK_SECRET, rawBody)}`;

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-github-event": args.eventName,
    "x-github-delivery": deliveryId,
    ...args.headers,
  };
  if (signature) headers["x-hub-signature-256"] = signature;

  const ctx = createExecutionContext();
  const routeEnv: Bindings = {
    ...env,
    GITHUB_APP_ID: "12345",
    GITHUB_APP_SLUG: "drydock-test",
    GITHUB_APP_CLIENT_ID: "client-id",
    GITHUB_APP_CLIENT_SECRET: "client-secret",
    GITHUB_APP_PRIVATE_KEY: "----- placeholder -----",
    GITHUB_APP_WEBHOOK_SECRET: WEBHOOK_SECRET,
    GITHUB_APP_STATE_SECRET: "0123456789abcdef0123456789abcdef",
    BETTER_AUTH_SECRET: "fallback-secret-with-enough-entropy-aaaaaaaa",
  };
  const app = buildApp();
  const res = await app.fetch(
    new Request("http://test.local/webhooks/github", {
      method: "POST",
      headers,
      body: rawBody,
    }),
    routeEnv,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return { res, deliveryId };
}

function buildRequestedPayload(opts: {
  installationId: string;
  repositoryId: number;
  environment?: string;
  runId?: number;
}) {
  const runId = opts.runId ?? 77;
  return {
    action: "requested",
    environment: opts.environment ?? "pypi",
    deployment_callback_url: `https://api.github.com/repos/octo/example/actions/runs/${runId}/deployment_protection_rule`,
    deployment: { id: 909 },
    installation: { id: Number(opts.installationId) },
    repository: { id: opts.repositoryId, full_name: "octo/example" },
  };
}

describe("POST /webhooks/github", () => {
  test("creates a pending gate when the mapping resolves", async () => {
    const { organizationId, installation, releaseTarget } = await seedMappedRepository({
      installationExternalId: "1010",
      repositoryId: 4242,
    });
    const payload = buildRequestedPayload({
      installationId: "1010",
      repositoryId: 4242,
    });

    const { res, deliveryId } = await sendWebhook({
      eventName: "deployment_protection_rule",
      body: payload,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: string; gateId: string; created: boolean };
    expect(body.result).toBe("gate_pending");
    expect(body.created).toBe(true);

    const gate = await getGateByDeliveryId(createDb(env.DB), deliveryId);
    expect(gate).not.toBeNull();
    expect(gate?.organizationId).toBe(organizationId);
    expect(gate?.installationRowId).toBe(installation.id);
    expect(gate?.releaseTargetId).toBe(releaseTarget.id);
    expect(gate?.runId).toBe(77);
    expect(gate?.status).toBe("pending");
    expect(gate?.deploymentCallbackUrl).toBe(payload.deployment_callback_url);

    const events = await createDb(env.DB)
      .select()
      .from(schema.scanEvents)
      .where(eq(schema.scanEvents.organizationId, organizationId));
    expect(events.some((event) => event.type === "github_workflow_gate.requested")).toBe(true);
  });

  test("is idempotent for the same X-GitHub-Delivery id", async () => {
    await seedMappedRepository({ installationExternalId: "2020", repositoryId: 5151 });
    const payload = buildRequestedPayload({
      installationId: "2020",
      repositoryId: 5151,
    });
    const deliveryId = crypto.randomUUID();
    const first = await sendWebhook({
      eventName: "deployment_protection_rule",
      body: payload,
      deliveryId,
    });
    const second = await sendWebhook({
      eventName: "deployment_protection_rule",
      body: payload,
      deliveryId,
    });
    expect(first.res.status).toBe(200);
    expect(second.res.status).toBe(200);
    const firstBody = (await first.res.json()) as { created: boolean };
    const secondBody = (await second.res.json()) as { created: boolean };
    expect(firstBody.created).toBe(true);
    expect(secondBody.created).toBe(false);
  });

  test("returns 401 when the signature does not match the body", async () => {
    const { res } = await sendWebhook({
      eventName: "deployment_protection_rule",
      body: { action: "requested" },
      signOverride: "sha256=00",
    });
    expect(res.status).toBe(401);
  });

  test("returns 401 when the signature header is missing", async () => {
    const { res } = await sendWebhook({
      eventName: "deployment_protection_rule",
      body: { action: "requested" },
      signOverride: null,
    });
    expect(res.status).toBe(401);
  });

  test("returns 400 for malformed deployment_protection_rule payloads", async () => {
    const { res } = await sendWebhook({
      eventName: "deployment_protection_rule",
      body: { action: "requested", environment: "pypi" },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/invalid webhook payload/);
  });

  test("returns 400 when required headers are missing", async () => {
    const ctx = createExecutionContext();
    const app = buildApp();
    const routeEnv: Bindings = {
      ...env,
      GITHUB_APP_ID: "12345",
      GITHUB_APP_SLUG: "drydock-test",
      GITHUB_APP_CLIENT_ID: "client-id",
      GITHUB_APP_CLIENT_SECRET: "client-secret",
      GITHUB_APP_PRIVATE_KEY: "----- placeholder -----",
      GITHUB_APP_WEBHOOK_SECRET: WEBHOOK_SECRET,
      GITHUB_APP_STATE_SECRET: "0123456789abcdef0123456789abcdef",
      BETTER_AUTH_SECRET: "fallback-secret-with-enough-entropy-aaaaaaaa",
    };
    const res = await app.fetch(
      new Request("http://test.local/webhooks/github", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
      routeEnv,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(400);
  });

  test("returns 413 before reading when content-length exceeds the webhook cap", async () => {
    const { res } = await sendWebhook({
      eventName: "deployment_protection_rule",
      body: { action: "requested" },
      headers: { "content-length": String(1024 * 1024 + 1) },
    });
    expect(res.status).toBe(413);
  });

  test("returns 413 when a streamed body crosses the webhook cap", async () => {
    const { res } = await sendWebhook({
      eventName: "deployment_protection_rule",
      body: { action: "requested", padding: "x".repeat(1024 * 1024) },
    });
    expect(res.status).toBe(413);
  });

  test("returns 503 when GitHub App is not configured", async () => {
    const ctx = createExecutionContext();
    const app = buildApp();
    const res = await app.fetch(
      new Request("http://test.local/webhooks/github", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "deployment_protection_rule",
          "x-github-delivery": "abc",
          "x-hub-signature-256": "sha256=00",
        },
        body: "{}",
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(503);
  });

  test("acks unsupported events without touching the database", async () => {
    const { res } = await sendWebhook({
      eventName: "push",
      body: { ref: "main" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ignored: string };
    expect(body.ignored).toBe("unsupported_event");
  });

  test("returns 'ignored' when the installation/environment is not mapped", async () => {
    const payload = buildRequestedPayload({
      installationId: "404404",
      repositoryId: 6262,
    });
    const { res } = await sendWebhook({
      eventName: "deployment_protection_rule",
      body: payload,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: string };
    expect(body.result).toBe("ignored");
  });

  test("installation suspend events move the installation into suspended state", async () => {
    const { organizationId } = await seedMappedRepository({
      installationExternalId: "3030",
      repositoryId: 7070,
    });
    const { res } = await sendWebhook({
      eventName: "installation",
      body: { action: "suspend", installation: { id: 3030 } },
    });
    expect(res.status).toBe(200);
    const [row] = await createDb(env.DB)
      .select()
      .from(schema.githubAppInstallations)
      .where(eq(schema.githubAppInstallations.installationId, "3030"));
    expect(row?.status).toBe("suspended");
    // status change is reflected in the org's installations
    expect(row?.organizationId).toBe(organizationId);
  });
});

describe("markGateDecided", () => {
  test("transitions a pending gate exactly once", async () => {
    const { releaseTarget, installation, organizationId } = await seedMappedRepository({
      installationExternalId: "5050",
      repositoryId: 8080,
    });
    const payload = buildRequestedPayload({
      installationId: "5050",
      repositoryId: 8080,
    });
    const { deliveryId } = await sendWebhook({
      eventName: "deployment_protection_rule",
      body: payload,
    });
    const db = createDb(env.DB);
    const gate = await getGateByDeliveryId(db, deliveryId);
    expect(gate).not.toBeNull();

    const first = await markGateDecided(db, {
      gateId: gate!.id,
      decision: "approved",
      comment: "Drydock review passed (release-target=" + releaseTarget.id + ")",
      reportUrl: "https://drydock.local/scans/abc",
    });
    expect(first?.status).toBe("approved");
    expect(first?.decision).toBe("approved");
    expect(first?.decisionComment).toMatch(/Drydock/);
    expect(first?.reportUrl).toBe("https://drydock.local/scans/abc");

    const second = await markGateDecided(db, {
      gateId: gate!.id,
      decision: "rejected",
      comment: "should not overwrite",
    });
    expect(second).toBeNull();

    const fetched = await getGateForOrganization(db, organizationId, gate!.id);
    expect(fetched?.status).toBe("approved");
    expect(fetched?.installationRowId).toBe(installation.id);
  });

  test("markGateErrored records the failure reason without consuming the gate", async () => {
    await seedMappedRepository({
      installationExternalId: "5151",
      repositoryId: 8181,
    });
    const payload = buildRequestedPayload({
      installationId: "5151",
      repositoryId: 8181,
    });
    const { deliveryId } = await sendWebhook({
      eventName: "deployment_protection_rule",
      body: payload,
    });
    const db = createDb(env.DB);
    const gate = await getGateByDeliveryId(db, deliveryId);
    expect(gate).not.toBeNull();

    const reason = "x".repeat(800);
    const updated = await markGateErrored(db, gate!.id, reason);
    expect(updated?.status).toBe("pending");
    expect(updated?.failureReason?.length).toBe(500);

    const decided = await markGateDecided(db, {
      gateId: gate!.id,
      decision: "rejected",
      comment: "Drydock review failed",
    });
    expect(decided?.status).toBe("rejected");
    expect(decided?.failureReason?.length).toBe(500);
  });

  test("markGateErrored does not overwrite a decided gate", async () => {
    await seedMappedRepository({
      installationExternalId: "5252",
      repositoryId: 8282,
    });
    const payload = buildRequestedPayload({
      installationId: "5252",
      repositoryId: 8282,
    });
    const { deliveryId } = await sendWebhook({
      eventName: "deployment_protection_rule",
      body: payload,
    });
    const db = createDb(env.DB);
    const gate = await getGateByDeliveryId(db, deliveryId);
    expect(gate).not.toBeNull();

    const decided = await markGateDecided(db, {
      gateId: gate!.id,
      decision: "approved",
      comment: "Drydock review passed",
    });
    expect(decided?.status).toBe("approved");

    const errored = await markGateErrored(db, gate!.id, "late failure");
    expect(errored).toBeNull();

    const fetched = await getGateByDeliveryId(db, deliveryId);
    expect(fetched?.status).toBe("approved");
    expect(fetched?.failureReason).toBeNull();
  });
});

describe("postDeploymentProtectionDecision integration via mock fetch", () => {
  test("rejects when the stored callback URL is no longer github-controlled", async () => {
    const { postDeploymentProtectionDecision } = await import("../../server/lib/github-app");
    const { readGithubAppConfig } = await import("../../server/lib/github-app");
    const config = readGithubAppConfig({
      GITHUB_APP_ID: "12345",
      GITHUB_APP_SLUG: "drydock-test",
      GITHUB_APP_CLIENT_ID: "client-id",
      GITHUB_APP_CLIENT_SECRET: "client-secret",
      GITHUB_APP_PRIVATE_KEY: "----- placeholder -----",
      GITHUB_APP_WEBHOOK_SECRET: WEBHOOK_SECRET,
      GITHUB_APP_STATE_SECRET: "0123456789abcdef0123456789abcdef",
      BETTER_AUTH_SECRET: "fallback-secret-with-enough-entropy-aaaaaaaa",
    });
    await expect(
      postDeploymentProtectionDecision({
        config,
        installationExternalId: "1010",
        callbackUrl:
          "https://evil.example.com/repos/octo/example/actions/runs/77/deployment_protection_rule",
        environment: "pypi",
        state: "approved",
        comment: "noop",
      }),
    ).rejects.toThrow(/non-GitHub callback/);
  });

  test("posts to the callback URL with installation token + structured body", async () => {
    const { postDeploymentProtectionDecision } = await import("../../server/lib/github-app");
    const tokenFetch = vi.fn(async () =>
      Response.json({ token: "ghs_install_token", expires_at: "2099-01-01T00:00:00Z" }),
    );
    const callbackFetch = vi.fn(async () => new Response(null, { status: 204 }));
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/access_tokens")) return tokenFetch(input, init);
      return callbackFetch(input, init);
    }) as unknown as typeof fetch;

    const { generateKeyPairSync } = await import("node:crypto");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const privateKeyPem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

    const { readGithubAppConfig } = await import("../../server/lib/github-app");
    const config = readGithubAppConfig({
      GITHUB_APP_ID: "12345",
      GITHUB_APP_SLUG: "drydock-test",
      GITHUB_APP_CLIENT_ID: "client-id",
      GITHUB_APP_CLIENT_SECRET: "client-secret",
      GITHUB_APP_PRIVATE_KEY: privateKeyPem,
      GITHUB_APP_WEBHOOK_SECRET: WEBHOOK_SECRET,
      GITHUB_APP_STATE_SECRET: "0123456789abcdef0123456789abcdef",
      BETTER_AUTH_SECRET: "fallback-secret-with-enough-entropy-aaaaaaaa",
    });

    await postDeploymentProtectionDecision({
      config,
      installationExternalId: "1010",
      callbackUrl:
        "https://api.github.com/repos/octo/example/actions/runs/77/deployment_protection_rule",
      environment: "pypi",
      state: "approved",
      comment: "Drydock review passed",
    });

    expect(callbackFetch).toHaveBeenCalledOnce();
    const [callbackUrl, callbackInit] = callbackFetch.mock.calls[0];
    expect(callbackUrl).toBe(
      "https://api.github.com/repos/octo/example/actions/runs/77/deployment_protection_rule",
    );
    expect(callbackInit?.method).toBe("POST");
    expect((callbackInit?.headers as Record<string, string>)?.Authorization).toBe(
      "Bearer ghs_install_token",
    );
    const body = JSON.parse(callbackInit?.body as string);
    expect(body).toEqual({
      state: "approved",
      environment_name: "pypi",
      comment: "Drydock review passed",
    });
  });
});
