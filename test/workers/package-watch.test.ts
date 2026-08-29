import { env } from "cloudflare:test";
import { Hono } from "hono";
import { afterEach, describe, expect, test, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createDb } from "../../server/db/client";
import { ensurePersonalOrganization } from "../../server/db/organizations";
import { createScanJob } from "../../server/db/scans";
import * as schema from "../../server/db/schema";
import { sweepOutOfBandPublishes } from "../../server/lib/ecosystems/npm/out-of-band-watch";
import { packageWatchRoutes } from "../../server/routes/package-watch";
import type { Bindings, Variables } from "../../server/types";

const REGISTRY_URL = "https://registry.npmjs.org";
const TOKEN = "npm_watch_token_0123456789";
const PACKAGE = "watched-pkg";

async function seedOrgWithScan(): Promise<{ organizationId: string; userId: string }> {
  const db = createDb(env.DB);
  const now = new Date();
  const userId = `user_${crypto.randomUUID()}`;
  await db.insert(schema.user).values({
    id: userId,
    name: "Watcher",
    email: `${userId}@example.com`,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  const organizationId = await ensurePersonalOrganization(db, { userId });
  await createScanJob(db, {
    id: `scan_${crypto.randomUUID()}`,
    stageId: `stage-${crypto.randomUUID()}`,
    organizationId,
    ownerUserId: userId,
    source: "auto_discovery",
    packageName: PACKAGE,
    stagedVersion: "1.0.0",
    registryUrl: REGISTRY_URL,
  });
  return { organizationId, userId };
}

function stubRegistry(input: {
  versions: string[];
  statusByVersion?: Record<string, string>;
  statusHttp?: number;
}) {
  const fetchMock = vi.fn(async (request: Request | string | URL) => {
    const url = String(request instanceof Request ? request.url : request);
    const statusMatch = url.match(/\/-\/package\/([^/]+)\/version\/([^/]+)\/status$/);
    if (statusMatch) {
      const version = decodeURIComponent(statusMatch[2]!);
      const status = input.statusByVersion?.[version];
      if (!status) return new Response("nope", { status: input.statusHttp ?? 404 });
      return Response.json({
        packageName: decodeURIComponent(statusMatch[1]!),
        version,
        status,
      });
    }
    expect(url).toBe(`${REGISTRY_URL}/${PACKAGE}`);
    return Response.json({
      name: PACKAGE,
      versions: Object.fromEntries(input.versions.map((version) => [version, {}])),
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function sweepInput(organizationId: string, userId: string, sendEmail?: { send: unknown }) {
  return {
    db: createDb(env.DB),
    env: { ...env, ...(sendEmail ? { SEND_EMAIL: sendEmail } : {}) } as unknown as Cloudflare.Env,
    organizationId,
    actorUserId: userId,
    connection: { token: TOKEN, registryUrl: REGISTRY_URL },
  };
}

async function alarmsFor(organizationId: string) {
  return createDb(env.DB)
    .select()
    .from(schema.outOfBandPublishes)
    .where(eq(schema.outOfBandPublishes.organizationId, organizationId));
}

describe("out-of-band publish sweep", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("first sweep baselines the public history without alarming", async () => {
    const org = await seedOrgWithScan();
    stubRegistry({ versions: ["0.9.0", "1.0.0"] });

    const first = await sweepOutOfBandPublishes(sweepInput(org.organizationId, org.userId));
    expect(first).toMatchObject({ enabled: true, checked: 1, detected: 0 });

    // The unreviewed 0.9.0 predates the watch; a second sweep still stays quiet.
    const second = await sweepOutOfBandPublishes(sweepInput(org.organizationId, org.userId));
    expect(second.detected).toBe(0);
    expect(await alarmsFor(org.organizationId)).toHaveLength(0);
  });

  test("an unreviewed published version alarms exactly once, with email", async () => {
    const org = await seedOrgWithScan();
    stubRegistry({ versions: ["1.0.0"] });
    await sweepOutOfBandPublishes(sweepInput(org.organizationId, org.userId));

    stubRegistry({ versions: ["1.0.0", "9.9.9"], statusByVersion: { "9.9.9": "published" } });
    const send = vi.fn(async () => undefined);
    const result = await sweepOutOfBandPublishes(
      sweepInput(org.organizationId, org.userId, { send }),
    );
    expect(result.detected).toBe(1);

    const alarms = await alarmsFor(org.organizationId);
    expect(alarms).toHaveLength(1);
    expect(alarms[0]).toMatchObject({
      packageName: PACKAGE,
      version: "9.9.9",
      statusConfirmed: true,
      acknowledgedAt: null,
    });
    expect(send).toHaveBeenCalledTimes(1);

    const events = await createDb(env.DB)
      .select({ type: schema.scanEvents.type })
      .from(schema.scanEvents)
      .where(eq(schema.scanEvents.organizationId, org.organizationId));
    expect(events.map((event) => event.type)).toContain("package_watch.out_of_band_publish");

    // Third sweep: the release is accounted; no duplicate alarm, no new email.
    stubRegistry({ versions: ["1.0.0", "9.9.9"] });
    const third = await sweepOutOfBandPublishes(
      sweepInput(org.organizationId, org.userId, { send }),
    );
    expect(third.detected).toBe(0);
    expect(await alarmsFor(org.organizationId)).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  test("a version with a Drydock review never alarms", async () => {
    const org = await seedOrgWithScan();
    stubRegistry({ versions: ["1.0.0"] });
    await sweepOutOfBandPublishes(sweepInput(org.organizationId, org.userId));

    await createScanJob(createDb(env.DB), {
      id: `scan_${crypto.randomUUID()}`,
      stageId: `stage-${crypto.randomUUID()}`,
      organizationId: org.organizationId,
      ownerUserId: org.userId,
      source: "auto_discovery",
      packageName: PACKAGE,
      stagedVersion: "2.0.0",
      registryUrl: REGISTRY_URL,
    });
    const fetchMock = stubRegistry({ versions: ["1.0.0", "2.0.0"] });
    const result = await sweepOutOfBandPublishes(sweepInput(org.organizationId, org.userId));
    expect(result.detected).toBe(0);
    expect(await alarmsFor(org.organizationId)).toHaveLength(0);
    // Reviewed releases must not even spend a status lookup.
    const statusCalls = fetchMock.mock.calls.filter((call) => String(call[0]).includes("/status"));
    expect(statusCalls).toHaveLength(0);
  });

  test("a validating version defers, then alarms once npm reports it published", async () => {
    const org = await seedOrgWithScan();
    stubRegistry({ versions: ["1.0.0"] });
    await sweepOutOfBandPublishes(sweepInput(org.organizationId, org.userId));

    stubRegistry({ versions: ["1.0.0", "3.0.0"], statusByVersion: { "3.0.0": "validating" } });
    const deferred = await sweepOutOfBandPublishes(sweepInput(org.organizationId, org.userId));
    expect(deferred.detected).toBe(0);
    expect(await alarmsFor(org.organizationId)).toHaveLength(0);

    stubRegistry({ versions: ["1.0.0", "3.0.0"], statusByVersion: { "3.0.0": "published" } });
    const published = await sweepOutOfBandPublishes(sweepInput(org.organizationId, org.userId));
    expect(published.detected).toBe(1);
  });

  test("an unavailable status lookup still alarms, marked unconfirmed", async () => {
    const org = await seedOrgWithScan();
    stubRegistry({ versions: ["1.0.0"] });
    await sweepOutOfBandPublishes(sweepInput(org.organizationId, org.userId));

    stubRegistry({ versions: ["1.0.0", "4.0.0"], statusHttp: 503 });
    const result = await sweepOutOfBandPublishes(sweepInput(org.organizationId, org.userId));
    expect(result.detected).toBe(1);
    const alarms = await alarmsFor(org.organizationId);
    expect(alarms[0]).toMatchObject({ version: "4.0.0", statusConfirmed: false });
  });

  test("the operator killswitch disables the sweep entirely", async () => {
    const org = await seedOrgWithScan();
    const fetchMock = stubRegistry({ versions: ["1.0.0"] });
    const flags = { getBooleanValue: vi.fn(async () => false) };
    const input = sweepInput(org.organizationId, org.userId);
    const result = await sweepOutOfBandPublishes({
      ...input,
      env: { ...input.env, FLAGS: flags } as unknown as Cloudflare.Env,
    });
    expect(result).toMatchObject({ enabled: false, watched: 0, checked: 0, detected: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("package watch routes", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function buildTestApp(session: { userId: string }) {
    const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
    app.use("*", async (c, next) => {
      c.set("authSession", { userId: session.userId });
      await next();
    });
    app.route("/api/v1/package-watch", packageWatchRoutes);
    return app;
  }

  test("lists open alarms and acknowledges them with an audit event", async () => {
    const org = await seedOrgWithScan();
    stubRegistry({ versions: ["1.0.0"] });
    await sweepOutOfBandPublishes(sweepInput(org.organizationId, org.userId));
    stubRegistry({ versions: ["1.0.0", "9.9.9"], statusByVersion: { "9.9.9": "published" } });
    await sweepOutOfBandPublishes(sweepInput(org.organizationId, org.userId));

    const app = buildTestApp({ userId: org.userId });
    const listRes = await app.fetch(
      new Request("http://test.local/api/v1/package-watch/out-of-band"),
      env as unknown as Bindings,
    );
    expect(listRes.status).toBe(200);
    const body = (await listRes.json()) as {
      alarms: Array<{ id: string; packageName: string; version: string }>;
    };
    expect(body.alarms).toHaveLength(1);
    expect(body.alarms[0]).toMatchObject({ packageName: PACKAGE, version: "9.9.9" });

    const ackRes = await app.fetch(
      new Request(
        `http://test.local/api/v1/package-watch/out-of-band/${body.alarms[0]!.id}/acknowledge`,
        { method: "POST" },
      ),
      env as unknown as Bindings,
    );
    expect(ackRes.status).toBe(200);

    const afterAck = await app.fetch(
      new Request("http://test.local/api/v1/package-watch/out-of-band"),
      env as unknown as Bindings,
    );
    expect(((await afterAck.json()) as { alarms: unknown[] }).alarms).toHaveLength(0);

    const repeatAck = await app.fetch(
      new Request(
        `http://test.local/api/v1/package-watch/out-of-band/${body.alarms[0]!.id}/acknowledge`,
        { method: "POST" },
      ),
      env as unknown as Bindings,
    );
    expect(repeatAck.status).toBe(404);

    const events = await createDb(env.DB)
      .select({ type: schema.scanEvents.type })
      .from(schema.scanEvents)
      .where(eq(schema.scanEvents.organizationId, org.organizationId));
    expect(events.map((event) => event.type)).toContain("package_watch.out_of_band_acknowledged");
  });

  test("an alarm is invisible to another organization", async () => {
    const org = await seedOrgWithScan();
    stubRegistry({ versions: ["1.0.0"] });
    await sweepOutOfBandPublishes(sweepInput(org.organizationId, org.userId));
    stubRegistry({ versions: ["1.0.0", "9.9.9"], statusByVersion: { "9.9.9": "published" } });
    await sweepOutOfBandPublishes(sweepInput(org.organizationId, org.userId));
    const [alarm] = await alarmsFor(org.organizationId);

    const outsider = await seedOrgWithScan();
    const app = buildTestApp({ userId: outsider.userId });
    const listRes = await app.fetch(
      new Request("http://test.local/api/v1/package-watch/out-of-band"),
      env as unknown as Bindings,
    );
    const body = (await listRes.json()) as { alarms: Array<{ id: string }> };
    expect(body.alarms.some((row) => row.id === alarm!.id)).toBe(false);

    const ackRes = await app.fetch(
      new Request(`http://test.local/api/v1/package-watch/out-of-band/${alarm!.id}/acknowledge`, {
        method: "POST",
      }),
      env as unknown as Bindings,
    );
    expect(ackRes.status).toBe(404);
  });
});
