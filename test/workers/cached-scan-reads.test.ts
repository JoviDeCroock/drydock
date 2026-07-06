import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { Hono } from "hono";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createDb } from "../../server/db/client";
import { ensurePersonalOrganization } from "../../server/db/organizations";
import { createScanJob, persistScan } from "../../server/db/scans";
import * as schema from "../../server/db/schema";
import { CachedScanReads } from "../../server/lib/cached-scan-reads";
import { scansRoutes } from "../../server/routes/scans";
import type { Bindings, Variables } from "../../server/types";

interface SeededUser {
  userId: string;
  organizationId: string;
}

async function seedUser(): Promise<SeededUser> {
  const db = createDb(env.DB);
  const now = new Date();
  const userId = `user_${crypto.randomUUID()}`;
  await db.insert(schema.user).values({
    id: userId,
    name: "Cache Tester",
    email: `${userId}@example.com`,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  const organizationId = await ensurePersonalOrganization(db, { userId });
  return { userId, organizationId };
}

async function seedCompletedScan(owner: SeededUser, packageName = "@org/pkg") {
  const db = createDb(env.DB);
  const scanId = `scan_${crypto.randomUUID()}`;
  const stageId = `stage-${scanId.slice(-12)}`;
  await createScanJob(db, {
    id: scanId,
    stageId,
    organizationId: owner.organizationId,
    ownerUserId: owner.userId,
  });
  await persistScan(db, {
    id: scanId,
    stageId,
    organizationId: owner.organizationId,
    ownerUserId: owner.userId,
    packageJson: { name: packageName, version: "1.2.3" },
    risk: "high",
    status: "complete",
    summary: {
      report: {
        version: 1,
        digest: "abc123",
        digestAlgorithm: "sha256",
        generatedAt: "2026-01-01T00:00:00.000Z",
        rulesVersion: "1.8.0",
      },
      baseline: { kind: "registry", version: "1.0.0" },
      safety: { outboundPolicy: "gateway-only" },
      packageJsonDiff: {
        name: packageName,
        previousVersion: "1.0.0",
        stagedVersion: "1.2.3",
        scripts: [{ key: "postinstall", status: "added", staged: "node install.js" }],
        dependencies: [],
        entrypointsChanged: false,
      },
      diff: [{ path: "package.json", status: "modified" }],
    },
    ai: null,
    files: [{ path: "package.json", size: 10, sha256: "a", flags: [], textSample: "{}" }],
    diff: [{ path: "package.json", status: "modified", flags: [] }],
    findings: [
      {
        severity: "high",
        file: "package.json",
        evidence: "postinstall: node install.js",
        reason: "install lifecycle hooks execute on consumer machines",
        ruleId: "install-script.lifecycle",
        ruleVersion: "1.8.0",
      },
    ],
    report: { version: 1, digest: "abc123" },
  });
  return { scanId, stageId };
}

async function seedPendingScan(owner: SeededUser) {
  const db = createDb(env.DB);
  const scanId = `scan_${crypto.randomUUID()}`;
  const stageId = `stage-${scanId.slice(-12)}`;
  await createScanJob(db, {
    id: scanId,
    stageId,
    organizationId: owner.organizationId,
    ownerUserId: owner.userId,
  });
  return { scanId, stageId };
}

function buildTestApp(session: { userId: string }) {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.use("*", async (c, next) => {
    c.set("authSession", { userId: session.userId });
    await next();
  });
  app.route("/api/v1/scans", scansRoutes);
  return app;
}

function buildExecutionContext(exportsValue?: {
  fetch?: ReturnType<typeof vi.fn>;
  invalidate?: ReturnType<typeof vi.fn>;
}) {
  const ctx = createExecutionContext() as ExecutionContext & {
    exports: {
      CachedScanReads: {
        fetch(request: Request, options: { props: { organizationId: string } }): Promise<Response>;
        invalidate(scanId: string): Promise<void>;
      };
    };
  };
  const fetch = exportsValue?.fetch ?? vi.fn(async () => new Response("ok"));
  const invalidate = exportsValue?.invalidate ?? vi.fn(async () => undefined);
  ctx.exports = {
    CachedScanReads: {
      fetch,
      invalidate,
    },
  };
  return { ctx, fetch, invalidate };
}

function buildEntrypoint(organizationId: string, cache?: { purge: ReturnType<typeof vi.fn> }) {
  const entrypoint = Object.create(CachedScanReads.prototype) as CachedScanReads & {
    env: Cloudflare.Env;
    ctx: {
      props: { organizationId: string };
      cache?: { purge?: ReturnType<typeof vi.fn> };
    };
  };
  entrypoint.env = env;
  entrypoint.ctx = { props: { organizationId }, cache };
  return entrypoint;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("CachedScanReads", () => {
  test("serves completed scan reads with cache headers and leaves pending scans private", async () => {
    const owner = await seedUser();
    const completed = await seedCompletedScan(owner);
    const pending = await seedPendingScan(owner);

    const entrypoint = buildEntrypoint(owner.organizationId);

    const detailRes = await entrypoint.fetch(
      new Request(`http://test.local/api/v1/scans/${completed.scanId}`, {
        method: "GET",
      }),
    );
    expect(detailRes.status).toBe(200);
    expect(detailRes.headers.get("cache-control")).toContain("public");
    expect(detailRes.headers.get("cache-control")).toContain("max-age=60");
    expect(detailRes.headers.get("cache-tag")).toBe(`scan:${completed.scanId}`);

    const fileRes = await entrypoint.fetch(
      new Request(`http://test.local/api/v1/scans/${completed.scanId}/file?path=package.json`, {
        method: "GET",
      }),
    );
    expect(fileRes.status).toBe(200);
    expect(fileRes.headers.get("cache-control")).toContain("public");
    expect(fileRes.headers.get("cache-control")).toContain("max-age=86400");
    expect(fileRes.headers.get("cache-tag")).toBe(`scan:${completed.scanId}`);

    const reportRes = await entrypoint.fetch(
      new Request(`http://test.local/api/v1/scans/${completed.scanId}/report.json`, {
        method: "GET",
      }),
    );
    expect(reportRes.status).toBe(200);
    expect(reportRes.headers.get("cache-control")).toContain("public");
    expect(reportRes.headers.get("cache-control")).toContain("max-age=300");
    expect(reportRes.headers.get("cache-tag")).toBe(`scan:${completed.scanId}`);

    const pendingRes = await entrypoint.fetch(
      new Request(`http://test.local/api/v1/scans/${pending.scanId}`, { method: "GET" }),
    );
    expect(pendingRes.status).toBe(200);
    expect(pendingRes.headers.get("cache-control")).toBe("private, no-store");
    expect(pendingRes.headers.get("cache-tag")).toBeNull();
  });

  test("gateway delegates through a tenant-scoped export and strips auth-bearing headers", async () => {
    const owner = await seedUser();
    const completed = await seedCompletedScan(owner);
    const app = buildTestApp(owner);
    const { ctx, fetch } = buildExecutionContext();

    const res = await app.fetch(
      new Request(`http://test.local/api/v1/scans/${completed.scanId}?poll=1`, {
        method: "GET",
        headers: {
          cookie: "session=secret",
          authorization: "Bearer secret",
        },
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
    const forwardedRequest = fetch.mock.calls[0]?.[0] as Request;
    const forwardedOptions = fetch.mock.calls[0]?.[1] as { props: { organizationId: string } };
    expect(forwardedRequest.url).toBe(`http://test.local/api/v1/scans/${completed.scanId}`);
    expect(forwardedRequest.headers.get("cookie")).toBeNull();
    expect(forwardedRequest.headers.get("authorization")).toBeNull();
    expect(forwardedOptions.props.organizationId).toBe(owner.organizationId);
  });

  test("gateway serves completed scan reads in-process when the pilot flag is off", async () => {
    const owner = await seedUser();
    const completed = await seedCompletedScan(owner);
    const app = buildTestApp(owner);
    const ctx = createExecutionContext();
    const localEnv = { ...env, WORKERS_CACHE_PILOT: undefined } as typeof env;

    const res = await app.fetch(
      new Request(`http://test.local/api/v1/scans/${completed.scanId}`, { method: "GET" }),
      localEnv,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("public");
    expect(res.headers.get("cache-tag")).toBe(`scan:${completed.scanId}`);
    const body = (await res.json()) as { scan: { id: string; status: string } };
    expect(body.scan.id).toBe(completed.scanId);
    expect(body.scan.status).toBe("complete");
  });

  test("gateway preserves file paths but strips organization and poll query params", async () => {
    const owner = await seedUser();
    const completed = await seedCompletedScan(owner);
    const app = buildTestApp(owner);
    const { ctx, fetch } = buildExecutionContext();

    const res = await app.fetch(
      new Request(
        `http://test.local/api/v1/scans/${completed.scanId}/file?path=package.json&organizationId=${owner.organizationId}&poll=1`,
        {
          method: "GET",
          headers: {
            cookie: "session=secret",
            authorization: "Bearer secret",
          },
        },
      ),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
    const forwardedRequest = fetch.mock.calls[0]?.[0] as Request;
    expect(forwardedRequest.url).toBe(
      `http://test.local/api/v1/scans/${completed.scanId}/file?path=package.json`,
    );
    expect(forwardedRequest.headers.get("cookie")).toBeNull();
    expect(forwardedRequest.headers.get("authorization")).toBeNull();
    const forwardedOptions = fetch.mock.calls[0]?.[1] as { props: { organizationId: string } };
    expect(forwardedOptions.props.organizationId).toBe(owner.organizationId);
  });

  test("cross-tenant access still fails before delegation", async () => {
    const owner = await seedUser();
    const intruder = await seedUser();
    const completed = await seedCompletedScan(owner);
    const app = buildTestApp(intruder);
    const { ctx, fetch } = buildExecutionContext();

    const res = await app.fetch(
      new Request(`http://test.local/api/v1/scans/${completed.scanId}`, { method: "GET" }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });

  test("POST /decision invalidates the cached scan tag", async () => {
    const owner = await seedUser();
    const completed = await seedCompletedScan(owner);
    const app = buildTestApp(owner);
    const invalidate = vi.fn(async () => undefined);
    const { ctx } = buildExecutionContext({ invalidate });

    const res = await app.fetch(
      new Request(`http://test.local/api/v1/scans/${completed.scanId}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "publish" }),
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    expect(invalidate).toHaveBeenCalledWith(completed.scanId);
  });

  test("invalidate no-ops safely when ctx.cache is unavailable", async () => {
    const owner = await seedUser();
    const entrypoint = buildEntrypoint(owner.organizationId);

    await expect(entrypoint.invalidate("scan_123")).resolves.toBeUndefined();
  });
});
