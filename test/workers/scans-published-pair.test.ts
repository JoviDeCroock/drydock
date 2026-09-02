import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createDb } from "../../server/db/client";
import { getNpmConnection } from "../../server/db/npm-connections";
import { ensurePersonalOrganization } from "../../server/db/organizations";
import * as schema from "../../server/db/schema";
import { scansRoutes } from "../../server/routes/scans";
import type { Bindings, ScanInput, Variables } from "../../server/types";

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
    name: "Tester",
    email: `${userId}@example.com`,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  const organizationId = await ensurePersonalOrganization(db, { userId });
  return { userId, organizationId };
}

function buildTestApp(session: { userId: string }) {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.use("*", async (c, next) => {
    c.set("authSession", { userId: session.userId, emailVerified: true });
    await next();
  });
  app.route("/api/v1/scans", scansRoutes);
  return app;
}

// Only the packument is served: the route resolves the pair before it queues,
// and the queue double stops the job (and therefore the tarball fetch) from
// running at all.
function stubPackument(packageName: string, versions: string[]) {
  const fetchMock = vi.fn(async (url: string | URL | Request) => {
    if (String(url) === `https://registry.npmjs.org/${packageName}`) {
      return new Response(
        JSON.stringify({
          "dist-tags": { latest: versions[versions.length - 1] },
          versions: Object.fromEntries(
            versions.map((version) => [
              version,
              { dist: { tarball: `https://registry.npmjs.org/${packageName}/-/x-${version}.tgz` } },
            ]),
          ),
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`unexpected fetch: ${String(url)}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function postScan(
  app: ReturnType<typeof buildTestApp>,
  queue: { send: unknown },
  body: unknown,
) {
  const ctx = createExecutionContext();
  const res = await app.request(
    "/api/v1/scans",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    { ...env, SCAN_QUEUE: queue },
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

describe("published-pair scans", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("creates a scan for a published pair without any npm connection", async () => {
    const owner = await seedUser();
    const packageName = `pkg-${crypto.randomUUID()}`;
    const requests = stubPackument(packageName, ["1.0.0", "1.1.0"]);
    const queue = { send: vi.fn(async () => undefined) };

    const res = await postScan(buildTestApp(owner), queue, {
      ecosystem: "npm",
      packageName,
      version: "1.1.0",
    });

    expect(res.status).toBe(202);
    const body = (await res.json()) as { scan: { id: string } };
    const db = createDb(env.DB);
    expect(await getNpmConnection(db, owner.organizationId)).toBeNull();

    const [row] = await db
      .select({
        source: schema.scans.source,
        stageId: schema.scans.stageId,
        packageName: schema.scans.packageName,
        stagedVersion: schema.scans.stagedVersion,
        registryUrl: schema.scans.registryUrl,
        registryPackageName: schema.scans.registryPackageName,
      })
      .from(schema.scans)
      .where(eq(schema.scans.id, body.scan.id));
    expect(row?.source).toBe("published");
    expect(row?.stageId).toBe(`published:npm:${packageName}@1.1.0`);
    expect(row?.packageName).toBe(packageName);
    expect(row?.stagedVersion).toBe("1.1.0");
    // A published review claims no registry coordinates: those belong to the
    // staged-release status machinery, which must not adopt this scan.
    expect(row?.registryUrl).toBeNull();
    expect(row?.registryPackageName).toBeNull();

    // Credential-free by construction: no request on this path may carry auth.
    for (const [, init] of requests.mock.calls) {
      const headers = new Headers((init as RequestInit | undefined)?.headers);
      expect(headers.get("authorization")).toBeNull();
    }
  });

  test("queues a message naming the resolved pair and its predecessor baseline", async () => {
    const owner = await seedUser();
    const packageName = `pkg-${crypto.randomUUID()}`;
    stubPackument(packageName, ["1.0.0", "1.1.0", "2.0.0"]);
    const queue = { send: vi.fn(async () => undefined) };

    const res = await postScan(buildTestApp(owner), queue, {
      ecosystem: "npm",
      packageName,
      version: "1.1.0",
    });

    expect(res.status).toBe(202);
    expect(queue.send).toHaveBeenCalledTimes(1);
    const message = queue.send.mock.calls[0][0] as ScanInput & { source: string };
    expect(message.source).toBe("published");
    expect(message.published).toEqual({
      ecosystem: "npm",
      packageName,
      version: "1.1.0",
      baselineVersion: "1.0.0",
    });
  });

  test("honors an explicitly requested baseline version", async () => {
    const owner = await seedUser();
    const packageName = `pkg-${crypto.randomUUID()}`;
    stubPackument(packageName, ["1.0.0", "1.1.0", "2.0.0"]);
    const queue = { send: vi.fn(async () => undefined) };

    const res = await postScan(buildTestApp(owner), queue, {
      ecosystem: "npm",
      packageName,
      version: "2.0.0",
      baselineVersion: "1.0.0",
    });

    expect(res.status).toBe(202);
    const message = queue.send.mock.calls[0][0] as ScanInput;
    expect(message.published?.baselineVersion).toBe("1.0.0");
  });

  test("rejects unpublished versions and malformed coordinates", async () => {
    const owner = await seedUser();
    const packageName = `pkg-${crypto.randomUUID()}`;
    stubPackument(packageName, ["1.0.0", "1.1.0"]);
    const queue = { send: vi.fn(async () => undefined) };
    const app = buildTestApp(owner);

    const unknownVersion = await postScan(app, queue, {
      ecosystem: "npm",
      packageName,
      version: "9.9.9",
    });
    expect(unknownVersion.status).toBe(404);

    const badEcosystem = await postScan(app, queue, {
      ecosystem: "vscode",
      packageName,
      version: "1.1.0",
    });
    expect(badEcosystem.status).toBe(400);

    const badName = await postScan(app, queue, {
      ecosystem: "npm",
      packageName: "../etc/passwd",
      version: "1.1.0",
    });
    expect(badName.status).toBe(400);

    // A pkg.pr.new preview ref is a valid `/diff` side but a mutable one, so a
    // persisted review must not be pinned to it.
    const previewRef = await postScan(app, queue, {
      ecosystem: "npm",
      packageName,
      version: `https://pkg.pr.new/${packageName}@abc1234`,
    });
    expect(previewRef.status).toBe(400);

    const missingVersion = await postScan(app, queue, { ecosystem: "npm", packageName });
    expect(missingVersion.status).toBe(400);

    expect(queue.send).not.toHaveBeenCalled();
  });

  test("leaves the staged input path unchanged", async () => {
    const owner = await seedUser();
    const queue = { send: vi.fn(async () => undefined) };

    // No npm connection, so the staged path still refuses before any registry call.
    const res = await postScan(buildTestApp(owner), queue, { stageId: "stage-published-000001" });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Connect an organization npm token before scanning staged publishes.",
    });
    expect(queue.send).not.toHaveBeenCalled();
  });
});
