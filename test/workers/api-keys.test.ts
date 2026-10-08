import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, test, vi } from "vitest";
import worker from "../../server";
import { createDb } from "../../server/db/client";
import { addOrganizationMember } from "../../server/db/invitations";
import {
  updateNpmConnectionValidation,
  upsertNpmConnection,
} from "../../server/db/npm-connections";
import * as schema from "../../server/db/schema";
import { API_KEY_ROUTES, API_KEY_SCAN_ROUTES, hashApiKey } from "../../server/lib/auth/api-keys";
import { encryptNpmToken } from "../../server/lib/ecosystems/npm/connection";
import type { QueueMessage } from "../../server/lib/scan/job";
import { personalOrganizationId } from "../../server/lib/auth/ownership";
import { type Jar, callWorker, signUpUserId } from "./helpers/auth-http";
import { seedCompletedScan, seedUser } from "./helpers/seed";
import {
  exhaustedRateLimitBindings,
  rateLimitBindingOverrides,
  rateLimiterDouble,
} from "./rate-limit-doubles";

interface Account {
  jar: Jar;
  userId: string;
  organizationId: string;
}

async function signedUpAccount(): Promise<Account> {
  const jar: Jar = new Map();
  const userId = await signUpUserId(jar);
  // The personal organization is created on the first organization-scoped read.
  expect((await callWorker("GET", "/api/v1/organizations", { jar })).res.status).toBe(200);
  return { jar, userId, organizationId: personalOrganizationId(userId) };
}

function orgHeaders(organizationId: string): Record<string, string> {
  return { "x-organization-id": organizationId };
}

async function createKey(
  account: Account,
  organizationId = account.organizationId,
  body: Record<string, unknown> = { name: "ci" },
): Promise<{ id: string; token: string; prefix: string }> {
  const created = await callWorker("POST", "/api/v1/api-keys", {
    jar: account.jar,
    body,
    headers: orgHeaders(organizationId),
  });
  expect(created.res.status).toBe(201);
  const key = created.json?.key as { id: string; prefix: string };
  return { id: key.id, prefix: key.prefix, token: created.json?.token as string };
}

function withKey(token: string, extra: Record<string, string> = {}) {
  return { headers: { authorization: `Bearer ${token}`, ...extra } };
}

describe("organization API key management", () => {
  test("an owner creates a key whose secret is returned once and never listed", async () => {
    const owner = await signedUpAccount();
    const created = await callWorker("POST", "/api/v1/api-keys", {
      jar: owner.jar,
      body: { name: "release bot", expiresInDays: 30 },
    });
    expect(created.res.status).toBe(201);
    expect(created.res.headers.get("cache-control")).toBe("no-store");
    const token = created.json?.token as string;
    expect(token).toMatch(/^ddk_[A-Za-z0-9_-]{43}$/);
    const key = created.json?.key as { id: string; prefix: string; expiresAt: string };
    expect(token.startsWith(key.prefix)).toBe(true);
    const ttlDays = (new Date(key.expiresAt).getTime() - Date.now()) / 86_400_000;
    expect(ttlDays).toBeGreaterThan(29.9);
    expect(ttlDays).toBeLessThanOrEqual(30);

    const listed = await callWorker("GET", "/api/v1/api-keys", { jar: owner.jar });
    expect(listed.res.status).toBe(200);
    expect(listed.text).not.toContain(token);
    expect(listed.text).not.toContain(await hashApiKey(token));
    expect(listed.json?.keys).toEqual([
      expect.objectContaining({ id: key.id, name: "release bot", prefix: key.prefix }),
    ]);

    const db = createDb(env.DB);
    const [row] = await db
      .select()
      .from(schema.organizationApiKeys)
      .where(eq(schema.organizationApiKeys.id, key.id));
    expect(row.keyHash).toBe(await hashApiKey(token));
    expect(JSON.stringify(row)).not.toContain(token);

    const events = await db
      .select({ type: schema.scanEvents.type, metadata: schema.scanEvents.metadataJson })
      .from(schema.scanEvents)
      .where(eq(schema.scanEvents.organizationId, owner.organizationId));
    const createdEvent = events.find((event) => event.type === "organization.api_key_created");
    expect(createdEvent?.metadata).toMatchObject({ name: "release bot", prefix: key.prefix });
    expect(JSON.stringify(events)).not.toContain(token);
  });

  test("rejects invalid names and expiry choices", async () => {
    const owner = await signedUpAccount();
    for (const body of [
      { name: "" },
      { name: "x".repeat(65) },
      { name: "bad\u0000name" },
      { name: "ok", expiresInDays: 7 },
      { name: "ok", expiresInDays: null },
    ]) {
      const res = await callWorker("POST", "/api/v1/api-keys", { jar: owner.jar, body });
      expect(res.res.status, JSON.stringify(body)).toBe(400);
    }
  });

  test("caps an organization at ten keys", async () => {
    const owner = await signedUpAccount();
    for (let index = 0; index < 10; index += 1) {
      await createKey(owner, owner.organizationId, { name: `key ${index}` });
    }
    const res = await callWorker("POST", "/api/v1/api-keys", {
      jar: owner.jar,
      body: { name: "one too many" },
    });
    expect(res.res.status).toBe(409);
  });

  test("plain members cannot list, create, or revoke keys", async () => {
    const owner = await signedUpAccount();
    const member = await signedUpAccount();
    const db = createDb(env.DB);
    await addOrganizationMember(db, {
      organizationId: owner.organizationId,
      userId: member.userId,
      role: "member",
    });
    const key = await createKey(owner);
    const headers = orgHeaders(owner.organizationId);

    expect(
      (await callWorker("GET", "/api/v1/api-keys", { jar: member.jar, headers })).res.status,
    ).toBe(403);
    expect(
      (
        await callWorker("POST", "/api/v1/api-keys", {
          jar: member.jar,
          headers,
          body: { name: "sneaky" },
        })
      ).res.status,
    ).toBe(403);
    expect(
      (await callWorker("DELETE", `/api/v1/api-keys/${key.id}`, { jar: member.jar, headers })).res
        .status,
    ).toBe(403);
  });

  test("revoking a key stops it immediately and is audited", async () => {
    const owner = await signedUpAccount();
    const key = await createKey(owner);
    expect((await callWorker("GET", "/api/v1/scans", withKey(key.token))).res.status).toBe(200);

    const revoked = await callWorker("DELETE", `/api/v1/api-keys/${key.id}`, { jar: owner.jar });
    expect(revoked.res.status).toBe(200);
    const after = await callWorker("GET", "/api/v1/scans", withKey(key.token));
    expect(after.res.status).toBe(401);
    expect(after.json).toMatchObject({ code: "invalid_api_key" });

    const db = createDb(env.DB);
    const events = await db
      .select({ type: schema.scanEvents.type })
      .from(schema.scanEvents)
      .where(eq(schema.scanEvents.organizationId, owner.organizationId));
    expect(events.map((event) => event.type)).toContain("organization.api_key_revoked");
  });

  test("a key cannot be revoked from another organization", async () => {
    const owner = await signedUpAccount();
    const stranger = await signedUpAccount();
    const key = await createKey(owner);
    const res = await callWorker("DELETE", `/api/v1/api-keys/${key.id}`, { jar: stranger.jar });
    expect(res.res.status).toBe(404);
    expect((await callWorker("GET", "/api/v1/scans", withKey(key.token))).res.status).toBe(200);
  });

  test("a key stops working once its creator is no longer a member, however the membership ended", async () => {
    const owner = await signedUpAccount();
    const admin = await signedUpAccount();
    const created = await callWorker("POST", "/api/v1/organizations", {
      jar: owner.jar,
      body: { name: "membership-checked" },
    });
    const organizationId = (created.json as { organization: { id: string } }).organization.id;
    const db = createDb(env.DB);
    await addOrganizationMember(db, { organizationId, userId: admin.userId, role: "admin" });
    const key = await createKey(admin, organizationId, { name: "orphaned" });
    expect((await callWorker("GET", "/api/v1/scans", withKey(key.token))).res.status).toBe(200);

    // Skips `removeOrganizationMember`, the way a removal racing the key's
    // creation can: the key row survives, so the lookup itself must refuse it.
    await db
      .delete(schema.organizationMembers)
      .where(eq(schema.organizationMembers.userId, admin.userId));
    expect((await callWorker("GET", "/api/v1/scans", withKey(key.token))).res.status).toBe(401);
  });

  test("expired keys stay listed but do not hold a slot", async () => {
    const owner = await signedUpAccount();
    for (let index = 0; index < 10; index += 1) {
      await createKey(owner, owner.organizationId, { name: `key ${index}` });
    }
    const db = createDb(env.DB);
    const [oldest] = await db
      .select({ id: schema.organizationApiKeys.id })
      .from(schema.organizationApiKeys)
      .where(eq(schema.organizationApiKeys.organizationId, owner.organizationId))
      .limit(1);
    await db
      .update(schema.organizationApiKeys)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.organizationApiKeys.id, oldest.id));
    await createKey(owner, owner.organizationId, { name: "replacement" });
    const listed = await callWorker("GET", "/api/v1/api-keys", { jar: owner.jar });
    expect((listed.json as { keys: unknown[] }).keys).toHaveLength(11);
  });

  test("removing a member deletes the keys they created", async () => {
    const owner = await signedUpAccount();
    const admin = await signedUpAccount();
    const created = await callWorker("POST", "/api/v1/organizations", {
      jar: owner.jar,
      body: { name: "keyed-org" },
    });
    const organizationId = (created.json as { organization: { id: string } }).organization.id;
    const db = createDb(env.DB);
    await addOrganizationMember(db, { organizationId, userId: admin.userId, role: "admin" });
    const adminKey = await createKey(admin, organizationId, { name: "admin key" });
    const ownerKey = await createKey(owner, organizationId, { name: "owner key" });

    const removed = await callWorker("DELETE", `/api/v1/organizations/members/${admin.userId}`, {
      jar: owner.jar,
      headers: orgHeaders(organizationId),
    });
    expect(removed.res.status).toBe(200);

    expect((await callWorker("GET", "/api/v1/scans", withKey(adminKey.token))).res.status).toBe(
      401,
    );
    expect((await callWorker("GET", "/api/v1/scans", withKey(ownerKey.token))).res.status).toBe(
      200,
    );
  });
});

describe("API key authentication", () => {
  test("reads only the key's own organization", async () => {
    const owner = await signedUpAccount();
    const other = await seedUser();
    const ownScan = await seedCompletedScan({
      userId: owner.userId,
      organizationId: owner.organizationId,
    });
    const foreignScan = await seedCompletedScan(other);
    const key = await createKey(owner);

    const list = await callWorker("GET", "/api/v1/scans?filter=all", withKey(key.token));
    expect(list.res.status).toBe(200);
    const ids = (list.json as { scans: Array<{ id: string }> }).scans.map((scan) => scan.id);
    expect(ids).toContain(ownScan);
    expect(ids).not.toContain(foreignScan);

    expect(
      (await callWorker("GET", `/api/v1/scans/${ownScan}`, withKey(key.token))).res.status,
    ).toBe(200);
    expect(
      (await callWorker("GET", `/api/v1/scans/${foreignScan}`, withKey(key.token))).res.status,
    ).toBe(404);
    expect(
      (
        await callWorker(
          "GET",
          `/api/v1/scans/${foreignScan}/report.json?organizationId=${other.organizationId}`,
          withKey(key.token),
        )
      ).res.status,
    ).toBe(404);
  });

  test("refuses an organization selector that names another organization", async () => {
    const owner = await signedUpAccount();
    const other = await seedUser();
    const key = await createKey(owner);
    const res = await callWorker(
      "GET",
      "/api/v1/scans",
      withKey(key.token, orgHeaders(other.organizationId)),
    );
    expect(res.res.status).toBe(403);
    expect(res.json).toMatchObject({ code: "api_key_organization_mismatch" });
    const same = await callWorker(
      "GET",
      "/api/v1/scans",
      withKey(key.token, orgHeaders(owner.organizationId)),
    );
    expect(same.res.status).toBe(200);
  });

  test("every allowlisted endpoint answers a key without a session", async () => {
    const owner = await signedUpAccount();
    const scanId = await seedCompletedScan(
      { userId: owner.userId, organizationId: owner.organizationId },
      { packageJson: { name: "@acme/keyed", version: "1.0.0" } },
    );
    const key = await createKey(owner);
    const concrete: Record<string, string> = {
      "GET /api/v1/api-keys/current": "/api/v1/api-keys/current",
      "GET /api/v1/openapi.json": "/api/v1/openapi.json",
      "GET /api/v1/scans": "/api/v1/scans",
      "GET /api/v1/scans/overview": "/api/v1/scans/overview",
      "GET /api/v1/scans/:id": `/api/v1/scans/${scanId}`,
      "GET /api/v1/scans/:id/status": `/api/v1/scans/${scanId}/status`,
      "GET /api/v1/scans/:id/report.json": `/api/v1/scans/${scanId}/report.json`,
      "GET /api/v1/scans/:id/release-receipt.json": `/api/v1/scans/${scanId}/release-receipt.json`,
      "GET /api/v1/packages/:name{.+}/releases": "/api/v1/packages/@acme/keyed/releases",
      // No gate exists for this scan; the route still runs and answers 404.
      "GET /api/v1/github-app/workflow-gates/by-scan/:scanId": `/api/v1/github-app/workflow-gates/by-scan/${scanId}`,
    };
    expect(Object.keys(concrete).sort()).toEqual([...API_KEY_ROUTES].sort());

    for (const [route, path] of Object.entries(concrete)) {
      const res = await callWorker("GET", path, withKey(key.token));
      const expected = route.endsWith("by-scan/:scanId") ? 404 : 200;
      expect(res.res.status, `${route} → ${res.text.slice(0, 200)}`).toBe(expected);
    }

    const whoami = await callWorker("GET", "/api/v1/api-keys/current", withKey(key.token));
    expect(whoami.json).toMatchObject({
      organization: { id: owner.organizationId },
      key: { id: key.id, name: "ci", prefix: key.prefix },
      access: "read",
    });
  });

  test("answers 403 on every endpoint outside the allowlist", async () => {
    const owner = await signedUpAccount();
    const scanId = await seedCompletedScan({
      userId: owner.userId,
      organizationId: owner.organizationId,
    });
    const key = await createKey(owner);
    const denied: Array<[string, string, unknown?]> = [
      ["GET", "/api/health"],
      ["GET", "/api/v1/organizations"],
      ["GET", "/api/v1/api-keys"],
      ["POST", "/api/v1/api-keys", { name: "escalate" }],
      ["DELETE", `/api/v1/api-keys/${key.id}`],
      ["GET", "/api/v1/audit-events"],
      ["GET", "/api/v1/npm-connection"],
      // Matches `/scans/:id` by shape but is answered by the batch-approval route.
      ["GET", "/api/v1/scans/batch-approval"],
      ["POST", "/api/v1/scans/batch-approval", { scanIds: [scanId] }],
      ["POST", `/api/v1/scans/${scanId}/decision`, { decision: "publish" }],
      ["POST", `/api/v1/scans/${scanId}/share`, {}],
      ["GET", `/api/v1/scans/${scanId}/file?path=package.json`],
      ["GET", `/api/v1/scans/${scanId}/versions`],
      ["GET", "/api/v1/publication-watches"],
      ["GET", "/api/v1/packages/@acme/keyed/badge"],
      ["GET", "/api/v1/no-such-endpoint"],
    ];
    for (const [method, path, body] of denied) {
      const res = await callWorker(method, path, { ...withKey(key.token), body });
      expect(res.res.status, `${method} ${path}`).toBe(403);
      expect(res.json, `${method} ${path}`).toMatchObject({ code: "api_key_endpoint_not_allowed" });
    }
  });

  test("an unknown, malformed, or expired key is 401 and never falls back to the cookie", async () => {
    const owner = await signedUpAccount();
    const key = await createKey(owner);
    const db = createDb(env.DB);
    await db
      .update(schema.organizationApiKeys)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.organizationApiKeys.id, key.id));

    for (const token of [key.token, "ddk_short", `ddk_${"A".repeat(43)}`]) {
      const res = await callWorker("GET", "/api/v1/scans", { jar: owner.jar, ...withKey(token) });
      expect(res.res.status, token.slice(0, 12)).toBe(401);
      expect(res.res.headers.get("www-authenticate")).toContain("Bearer");
    }
  });

  test("a header that mentions a key but is not exactly Bearer ddk_… is a malformed key", async () => {
    const owner = await signedUpAccount();
    const key = await createKey(owner);
    for (const authorization of [
      `Bearer ${key.token} extra`,
      `Bearer ${key.token}, Basic eA==`,
      `Token ${key.token}`,
    ]) {
      const res = await callWorker("GET", "/api/v1/organizations", {
        jar: owner.jar,
        headers: { authorization },
      });
      expect(res.res.status, authorization.replace(key.token, "<key>")).toBe(401);
    }
  });

  test("other Authorization schemes keep the cookie session path", async () => {
    const owner = await signedUpAccount();
    for (const authorization of ["Basic dXNlcjpwYXNz", "Bearer not-a-drydock-key"]) {
      const res = await callWorker("GET", "/api/v1/scans", {
        jar: owner.jar,
        headers: { authorization },
      });
      expect(res.res.status, authorization).toBe(200);
    }
  });

  test("the current-key endpoint needs a key, not a session", async () => {
    const owner = await signedUpAccount();
    const res = await callWorker("GET", "/api/v1/api-keys/current", { jar: owner.jar });
    expect(res.res.status).toBe(400);
    expect(res.json).toMatchObject({ code: "api_key_required" });
  });

  test("an over-budget address is refused before any key lookup reaches D1", async () => {
    const forbidden = () => {
      throw new Error("a refused API-key attempt must not read D1");
    };
    const { overrides } = exhaustedRateLimitBindings();
    const res = await callWorker("GET", "/api/v1/scans", {
      ...withKey(`ddk_${"B".repeat(43)}`),
      ip: "10.77.0.1",
      env: {
        ...env,
        ...overrides,
        DB: {
          prepare: forbidden,
          batch: forbidden,
          exec: forbidden,
          dump: forbidden,
          withSession: forbidden,
        } as unknown as D1Database,
      },
    });
    expect(res.res.status).toBe(429);
  });

  test("charges the address and the key separately", async () => {
    const owner = await signedUpAccount();
    const key = await createKey(owner);
    const limiter = rateLimiterDouble(true);
    const res = await callWorker("GET", "/api/v1/scans", {
      ...withKey(key.token),
      ip: "10.77.0.2",
      env: { ...env, ...rateLimitBindingOverrides(limiter) },
    });
    expect(res.res.status).toBe(200);
    expect(limiter.keys).toEqual(
      expect.arrayContaining(["api-key-ip:10.77.0.2", `api-key:${key.id}`]),
    );
  });

  test("stamps last use without writing on every request", async () => {
    const owner = await signedUpAccount();
    const key = await createKey(owner);
    const db = createDb(env.DB);
    const read = async () =>
      (
        await db
          .select({ lastUsedAt: schema.organizationApiKeys.lastUsedAt })
          .from(schema.organizationApiKeys)
          .where(eq(schema.organizationApiKeys.id, key.id))
      )[0].lastUsedAt;

    expect(await read()).toBeNull();
    await callWorker("GET", "/api/v1/scans", withKey(key.token));
    const first = await read();
    expect(first).toBeInstanceOf(Date);
    await callWorker("GET", "/api/v1/scans", withKey(key.token));
    expect((await read())?.getTime()).toBe(first?.getTime());
  });
});

const REGISTRY = "https://registry.npmjs.org";

async function connectNpm(account: Account): Promise<void> {
  const db = createDb(env.DB);
  await upsertNpmConnection(db, {
    organizationId: account.organizationId,
    registryUrl: REGISTRY,
    label: "npm registry",
    createdByUserId: account.userId,
    ...(await encryptNpmToken(env, "npm_api_key_scan_0123456789")),
  });
  await updateNpmConnectionValidation(db, {
    organizationId: account.organizationId,
    validationStatus: "valid",
    validatedAt: new Date(),
  });
}

/** npm answers for one staged publish: the listing, the stage record, and the access probe. */
function stubStagedRegistry(stageId: string, packageName: string, version: string): void {
  const stage = {
    id: stageId,
    packageName,
    version,
    access: "public",
    tag: "latest",
    createdAt: "2026-10-01T12:00:00.000Z",
    shasum: "c".repeat(40),
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === `${REGISTRY}/-/stage?perPage=50`) {
        return Response.json({ items: [stage], total: 1, perPage: 50, page: 1 });
      }
      if (url === `${REGISTRY}/-/stage/${stageId}/tarball`)
        return new Response("", { status: 206 });
      if (url === `${REGISTRY}/-/stage/${stageId}`) return Response.json(stage);
      return new Response("not found", { status: 404 });
    }),
  );
}

// A script sends no Origin header; the CSRF origin check must not stand in its way.
async function postWithoutOrigin(
  path: string,
  token: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> | null; queue: QueueMessage[] }> {
  const queue: QueueMessage[] = [];
  const ctx = createExecutionContext();
  const headers = new Headers({ authorization: `Bearer ${token}` });
  if (body !== undefined) headers.set("content-type", "application/json");
  const res = await worker.fetch(
    new Request(`http://example.com${path}`, {
      method: "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { ...env, SCAN_QUEUE: { send: async (message: QueueMessage) => void queue.push(message) } },
    ctx,
  );
  await waitOnExecutionContext(ctx);
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null, queue };
}

async function auditEvents(organizationId: string, type: string) {
  return createDb(env.DB)
    .select()
    .from(schema.scanEvents)
    .where(
      and(eq(schema.scanEvents.organizationId, organizationId), eq(schema.scanEvents.type, type)),
    );
}

describe("API keys with scan access", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("access is chosen at creation, listed, reported to the key, and audited", async () => {
    const owner = await signedUpAccount();
    const readKey = await createKey(owner);
    const scanKey = await createKey(owner, owner.organizationId, { name: "ci", access: "scan" });

    const listed = await callWorker("GET", "/api/v1/api-keys", { jar: owner.jar });
    const keys = listed.json?.keys as Array<{ id: string; access: string }>;
    expect(keys.find((key) => key.id === readKey.id)?.access).toBe("read");
    expect(keys.find((key) => key.id === scanKey.id)?.access).toBe("scan");
    expect(listed.json?.accessLevels).toEqual(["read", "scan"]);

    const whoami = await callWorker("GET", "/api/v1/api-keys/current", withKey(scanKey.token));
    expect(whoami.json?.access).toBe("scan");

    const created = await auditEvents(owner.organizationId, "organization.api_key_created");
    expect(
      created.map((event) => (event.metadataJson as { access?: string }).access).sort(),
    ).toEqual(["read", "scan"]);

    const invalid = await callWorker("POST", "/api/v1/api-keys", {
      jar: owner.jar,
      body: { name: "admin", access: "write" },
    });
    expect(invalid.res.status).toBe(400);
  });

  test("a read-only key is refused every route that starts a review", async () => {
    const owner = await signedUpAccount();
    await connectNpm(owner);
    const key = await createKey(owner);
    stubStagedRegistry("stage-read-only-000001", "@acme/read-only", "1.0.0");

    for (const route of API_KEY_SCAN_ROUTES) {
      const [, path] = route.split(" ");
      const res = await postWithoutOrigin(
        path,
        key.token,
        path.endsWith("/scans")
          ? {
              stageId: "stage-read-only-000001",
            }
          : undefined,
      );
      expect(res.status, route).toBe(403);
      expect(res.json, route).toMatchObject({ code: "api_key_access_insufficient" });
      expect(res.queue, route).toEqual([]);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  test("a scan key starts a review of one stage as its creator, and the start is audited", async () => {
    const owner = await signedUpAccount();
    await connectNpm(owner);
    const key = await createKey(owner, owner.organizationId, {
      name: "release-ci",
      access: "scan",
    });
    stubStagedRegistry("stage-scan-key-000001", "@acme/scanned", "2.1.0");

    const res = await postWithoutOrigin("/api/v1/scans", key.token, {
      stageId: "stage-scan-key-000001",
    });
    expect(res.status, JSON.stringify(res.json)).toBe(202);
    const scan = res.json?.scan as { id: string; packageName: string; stagedVersion: string };
    expect(scan).toMatchObject({ packageName: "@acme/scanned", stagedVersion: "2.1.0" });
    expect(res.queue).toHaveLength(1);
    expect(res.queue[0]).toMatchObject({ scanId: scan.id, actorUserId: owner.userId });
    expect(JSON.stringify(res.queue[0])).not.toContain(key.token);

    const db = createDb(env.DB);
    const [row] = await db.select().from(schema.scans).where(eq(schema.scans.id, scan.id));
    expect(row).toMatchObject({ organizationId: owner.organizationId, ownerUserId: owner.userId });

    const [event] = await auditEvents(owner.organizationId, "organization.api_key_review_started");
    expect(event).toMatchObject({ actorUserId: owner.userId, scanId: scan.id });
    expect(event.metadataJson).toMatchObject({
      name: "release-ci",
      prefix: key.prefix,
      packageName: "@acme/scanned",
      stagedVersion: "2.1.0",
    });
    expect(JSON.stringify(event.metadataJson)).not.toContain(key.token);

    // The review reads back through the same key.
    const status = await callWorker("GET", `/api/v1/scans/${scan.id}/status`, withKey(key.token));
    expect(status.res.status).toBe(200);
  });

  test("a scan key checks npm for staged publishes, and the check is audited", async () => {
    const owner = await signedUpAccount();
    await connectNpm(owner);
    const key = await createKey(owner, owner.organizationId, { name: "nightly", access: "scan" });
    stubStagedRegistry("stage-discovered-000001", "@acme/discovered", "3.0.0");

    const res = await postWithoutOrigin("/api/v1/staged-publishes/scan", key.token);
    expect(res.status, JSON.stringify(res.json)).toBe(202);
    expect(res.json).toMatchObject({
      found: 1,
      created: 1,
      skipped: 0,
      scans: [{ stageId: "stage-discovered-000001", packageName: "@acme/discovered" }],
    });
    expect(res.queue[0]).toMatchObject({ actorUserId: owner.userId });

    const [event] = await auditEvents(owner.organizationId, "organization.api_key_discovery_ran");
    expect(event).toMatchObject({ actorUserId: owner.userId });
    expect(event.metadataJson).toMatchObject({ name: "nightly", found: 1, created: 1, skipped: 0 });

    // A second check finds the same stage already under review.
    const again = await postWithoutOrigin("/api/v1/staged-publishes/scan", key.token);
    expect(again.json).toMatchObject({ found: 1, created: 0, skipped: 1 });
  });

  test("scan access adds nothing beyond starting reviews", async () => {
    const owner = await signedUpAccount();
    const scanId = await seedCompletedScan({
      userId: owner.userId,
      organizationId: owner.organizationId,
    });
    const key = await createKey(owner, owner.organizationId, { name: "ci", access: "scan" });
    const denied: Array<[string, unknown?]> = [
      [`/api/v1/scans/${scanId}/decision`, { decision: "publish" }],
      ["/api/v1/scans/batch-approval", { scanIds: [scanId] }],
      [`/api/v1/scans/${scanId}/share`, {}],
      ["/api/v1/api-keys", { name: "escalate", access: "scan" }],
      ["/api/v1/npm-connection/validate", {}],
      ["/api/v1/publication-watches", { packageName: "@acme/watched" }],
    ];
    for (const [path, body] of denied) {
      const res = await postWithoutOrigin(path, key.token, body);
      expect(res.status, path).toBe(403);
      expect(res.json, path).toMatchObject({ code: "api_key_endpoint_not_allowed" });
    }
    const [row] = await createDb(env.DB)
      .select({ decision: schema.scans.decision })
      .from(schema.scans)
      .where(eq(schema.scans.id, scanId));
    expect(row.decision).toBeNull();
  });

  test("a session request without an Origin is still refused by the CSRF check", async () => {
    const owner = await signedUpAccount();
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request("http://example.com/api/v1/staged-publishes/scan", {
        method: "POST",
        headers: {
          cookie: [...owner.jar.entries()].map(([name, value]) => `${name}=${value}`).join("; "),
        },
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "request origin not allowed" });
  });
});
