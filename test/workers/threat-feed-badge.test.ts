import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { createDb } from "../../server/db/client";
import { ensurePersonalOrganization } from "../../server/db/organizations";
import { createScanJob, persistScan } from "../../server/db/scans";
import * as schema from "../../server/db/schema";
import { publicReportsRoutes } from "../../server/routes/public-reports";
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
    name: "Tester",
    email: `${userId}@example.com`,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  const organizationId = await ensurePersonalOrganization(db, { userId });
  return { userId, organizationId };
}

function buildTestApp(session: { userId: string } | null) {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/public", publicReportsRoutes);
  if (session) {
    app.use("/api/*", async (c, next) => {
      c.set("authSession", { userId: session.userId });
      await next();
    });
    app.route("/api/v1/scans", scansRoutes);
  }
  return app;
}

async function request(
  app: Hono<{ Bindings: Bindings; Variables: Variables }>,
  path: string,
  options: RequestInit = {},
) {
  const ctx = createExecutionContext();
  const headers = new Headers(options.headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  const res = await app.fetch(
    new Request(`http://test.local${path}`, { ...options, headers }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

async function seedCompletedScan(
  owner: SeededUser,
  options: {
    packageName?: string;
    version?: string;
    risk?: string;
    releaseRisk?: string;
    ecosystem?: "npm" | "pypi" | "vscode";
    source?: "manual" | "workflow_gate";
  } = {},
): Promise<string> {
  const db = createDb(env.DB);
  const scanId = `scan_${crypto.randomUUID()}`;
  const stageId = `stage-${scanId.slice(-12)}`;
  const packageName = options.packageName ?? "@org/pkg";
  const version = options.version ?? "1.1.0";
  const risk = options.risk ?? "low";
  // Gate scans persist a provenance snapshot; staged-publish scans do not.
  const gateEcosystem =
    options.ecosystem && options.ecosystem !== "npm"
      ? options.ecosystem
      : options.source === "workflow_gate"
        ? "npm"
        : null;
  await createScanJob(db, {
    id: scanId,
    stageId,
    organizationId: owner.organizationId,
    ownerUserId: owner.userId,
    source: options.source ?? (gateEcosystem ? "workflow_gate" : "manual"),
  });
  await persistScan(db, {
    id: scanId,
    stageId,
    organizationId: owner.organizationId,
    ownerUserId: owner.userId,
    packageJson: { name: packageName, version },
    risk,
    status: "complete",
    summary: {
      report: { version: 1, digest: "abc123", digestAlgorithm: "sha256" },
      ...(gateEcosystem
        ? {
            stagedPublish: {
              provenance: {
                ecosystem: gateEcosystem,
                mode: "workflow_gate",
                artifacts: [
                  gateEcosystem === "npm"
                    ? { path: "pkg.tgz", kind: "tarball", sha256: "a".repeat(64) }
                    : { path: "dist/a.whl", kind: "wheel", sha256: "a".repeat(64) },
                ],
              },
            },
          }
        : {}),
    },
    ai: null,
    files: [],
    diff: [],
    findings: [],
    riskSummary: {
      artifactRisk: risk,
      releaseRisk: options.releaseRisk ?? risk,
      contextRisk: "low",
      releaseFindingCount: 0,
      contextFindingCount: 0,
      unknownFindingCount: 0,
    },
    report: { version: 1, digest: "abc123" },
  });
  return scanId;
}

async function share(
  app: ReturnType<typeof buildTestApp>,
  scanId: string,
  body: Record<string, unknown> = {},
) {
  const res = await request(app, `/api/v1/scans/${scanId}/share`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    share: { token: string; url: string; threatFeedListedAt: string | null };
  };
}

interface FeedBody {
  schema: string;
  entries: Array<{
    package: string | null;
    version: string | null;
    ecosystem: string;
    packageIdentity: string;
    releaseRisk: string;
    decision: string | null;
    reportUrl: string;
    listedAt: string | null;
  }>;
}

// Badge and feed responses read through the colo cache (caches.default), so
// lifecycle tests that assert on fresh state purge the entry first. Tests that
// exercise the caching itself skip the purge.
function coloCacheKey(path: string): Request {
  return new Request(`http://test.local${path.split("?")[0]}`);
}

async function purgeColoCache(path: string): Promise<void> {
  const cache = (caches as unknown as { default: Cache }).default;
  await cache.delete(coloCacheKey(path));
}

async function fetchFeed(
  app: ReturnType<typeof buildTestApp>,
  options: { cached?: boolean } = {},
): Promise<FeedBody> {
  if (!options.cached) await purgeColoCache("/public/threat-feed.json");
  const res = await request(app, "/public/threat-feed.json");
  expect(res.status).toBe(200);
  return (await res.json()) as FeedBody;
}

interface BadgeBody {
  schemaVersion: number;
  label: string;
  message: string;
  color: string;
}

async function fetchBadge(
  app: ReturnType<typeof buildTestApp>,
  ecosystem: string,
  name: string,
  options: { cached?: boolean } = {},
): Promise<{ status: number; body: BadgeBody }> {
  const path = `/public/badge/${ecosystem}/${name}`;
  if (!options.cached) await purgeColoCache(path);
  const res = await request(app, path);
  return { status: res.status, body: (await res.json()) as BadgeBody };
}

describe("shields badge endpoint", () => {
  test("only feed-listed reviews surface; sharing alone stays not reviewed", async () => {
    const owner = await seedUser();
    const app = buildTestApp(owner);
    const packageName = `pkg-${crypto.randomUUID().slice(0, 8)}`;

    const before = await fetchBadge(app, "npm", packageName);
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({
      schemaVersion: 1,
      label: "drydock",
      message: "not reviewed",
      color: "lightgrey",
    });

    const scanId = await seedCompletedScan(owner, { packageName, version: "2.0.0", risk: "low" });
    // Not shared yet — still not reviewed publicly.
    expect((await fetchBadge(app, "npm", packageName)).body.message).toBe("not reviewed");

    // Shared but not listed: the link is a capability, the badge is a
    // name-discoverable index — a private share must not surface here.
    await share(app, scanId);
    expect((await fetchBadge(app, "npm", packageName)).body.message).toBe("not reviewed");

    await share(app, scanId, { threatFeed: true });
    const after = await fetchBadge(app, "npm", packageName);
    expect(after.body.message).toBe("2.0.0 reviewed · low risk");
    expect(after.body.color).toBe("brightgreen");

    // Unlisting removes the badge again even though the link stays live.
    await share(app, scanId, { threatFeed: false });
    expect((await fetchBadge(app, "npm", packageName)).body.message).toBe("not reviewed");
  });

  test("registry-verified reviews outrank newer manifest-claimed gate scans", async () => {
    const owner = await seedUser();
    const app = buildTestApp(owner);
    const packageName = `pkg-${crypto.randomUUID().slice(0, 8)}`;

    const staged = await seedCompletedScan(owner, { packageName, version: "1.0.0", risk: "low" });
    await share(app, staged, { threatFeed: true });

    // A later workflow-gate scan claims the same npm name (manifest-claimed
    // identity) — it must not override the registry-verified badge.
    const spoofer = await seedUser();
    const gate = await seedCompletedScan(spoofer, {
      packageName,
      version: "9.9.9",
      risk: "high",
      releaseRisk: "high",
      source: "workflow_gate",
    });
    await share(buildTestApp(spoofer), gate, { threatFeed: true });

    const badge = await fetchBadge(app, "npm", packageName);
    expect(badge.body.message).toBe("1.0.0 reviewed · low risk");

    // With no verified review, the gate scan is what the org published — shown.
    const gateOnlyName = `pkg-${crypto.randomUUID().slice(0, 8)}`;
    const gateOnly = await seedCompletedScan(spoofer, {
      packageName: gateOnlyName,
      version: "2.0.0",
      source: "workflow_gate",
    });
    await share(buildTestApp(spoofer), gateOnly, { threatFeed: true });
    expect((await fetchBadge(app, "npm", gateOnlyName)).body.message).toBe(
      "2.0.0 reviewed · low risk",
    );
  });

  test("badge and feed responses are served from the colo cache", async () => {
    const owner = await seedUser();
    const app = buildTestApp(owner);
    const packageName = `pkg-${crypto.randomUUID().slice(0, 8)}`;
    const scanId = await seedCompletedScan(owner, { packageName, version: "5.0.0" });
    await share(app, scanId, { threatFeed: true });

    const first = await fetchBadge(app, "npm", packageName);
    expect(first.body.message).toBe("5.0.0 reviewed · low risk");

    // Revoke, then read without purging: the colo cache still serves the old
    // payload (staleness is bounded by max-age=300 and documented).
    await request(app, `/api/v1/scans/${scanId}/share`, { method: "DELETE" });
    const cachedRead = await fetchBadge(app, "npm", packageName, { cached: true });
    expect(cachedRead.body.message).toBe("5.0.0 reviewed · low risk");

    // Query strings never bypass the cache — the key is the bare path.
    const busted = await request(app, `/public/badge/npm/${packageName}?bust=${Math.random()}`);
    expect(((await busted.json()) as BadgeBody).message).toBe("5.0.0 reviewed · low risk");

    // A purged (expired) entry recomputes from the database.
    const fresh = await fetchBadge(app, "npm", packageName);
    expect(fresh.body.message).toBe("not reviewed");
  });

  test("hostile version strings are clamped in the badge message", async () => {
    const owner = await seedUser();
    const app = buildTestApp(owner);
    const packageName = `pkg-${crypto.randomUUID().slice(0, 8)}`;
    const longVersion = `1.0.0-${"x".repeat(200)}`;
    const scanId = await seedCompletedScan(owner, { packageName, version: longVersion });
    await share(app, scanId, { threatFeed: true });

    const badge = await fetchBadge(app, "npm", packageName);
    expect(badge.body.message.length).toBeLessThan(100);
    expect(badge.body.message).toContain("reviewed · low risk");
  });

  test("scoped npm names with slashes resolve through the wildcard route", async () => {
    const owner = await seedUser();
    const app = buildTestApp(owner);
    const packageName = `@scope-${crypto.randomUUID().slice(0, 6)}/pkg`;
    const scanId = await seedCompletedScan(owner, { packageName });
    await share(app, scanId, { threatFeed: true });

    const badge = await fetchBadge(app, "npm", packageName);
    expect(badge.body.message).toContain("reviewed");

    const encoded = await fetchBadge(app, "npm", encodeURIComponent(packageName));
    expect(encoded.body.message).toContain("reviewed");
  });

  test("high risk and blocked releases surface as red badges", async () => {
    const owner = await seedUser();
    const app = buildTestApp(owner);
    const packageName = `pkg-${crypto.randomUUID().slice(0, 8)}`;
    const scanId = await seedCompletedScan(owner, {
      packageName,
      version: "3.0.0",
      risk: "high",
      releaseRisk: "high",
    });
    await share(app, scanId, { threatFeed: true });
    expect((await fetchBadge(app, "npm", packageName)).body).toMatchObject({
      message: "3.0.0 reviewed · high risk",
      color: "red",
    });

    const decide = await request(app, `/api/v1/scans/${scanId}/decision`, {
      method: "POST",
      body: JSON.stringify({ decision: "no_publish", reason: "malicious" }),
    });
    expect(decide.status).toBe(200);
    expect((await fetchBadge(app, "npm", packageName)).body).toMatchObject({
      message: "3.0.0 blocked",
      color: "red",
    });
  });

  test("the badge is ecosystem-scoped", async () => {
    const owner = await seedUser();
    const app = buildTestApp(owner);
    const packageName = `demo-${crypto.randomUUID().slice(0, 8)}`;
    const scanId = await seedCompletedScan(owner, { packageName, ecosystem: "pypi" });
    await share(app, scanId, { threatFeed: true });

    expect((await fetchBadge(app, "pypi", packageName)).body.message).toContain("reviewed");
    expect((await fetchBadge(app, "npm", packageName)).body.message).toBe("not reviewed");
  });

  test("rejects unknown ecosystems and malformed names", async () => {
    const app = buildTestApp(null);
    expect((await request(app, "/public/badge/cargo/serde")).status).toBe(404);
    expect((await request(app, `/public/badge/npm/${"a".repeat(300)}`)).status).toBe(400);
  });

  test("badge cache misses are rate limited per IP", async () => {
    const app = buildTestApp(null);
    const ip = `10.1.0.${Math.floor(Math.random() * 200) + 1}`;
    const headers = { "cf-connecting-ip": ip };
    let limited = false;
    // Distinct package names so every request misses the colo cache and pays
    // the D1 lookup the limiter protects.
    for (let i = 0; i < 125; i += 1) {
      const res = await request(app, `/public/badge/npm/miss-${i}`, { headers });
      if (res.status === 429) {
        limited = true;
        break;
      }
      expect(res.status).toBe(200);
    }
    expect(limited).toBe(true);
  });
});

describe("public threat feed", () => {
  test("sharing alone does not list; the feed opt-in does", async () => {
    const owner = await seedUser();
    const app = buildTestApp(owner);
    const packageName = `feed-${crypto.randomUUID().slice(0, 8)}`;
    const scanId = await seedCompletedScan(owner, {
      packageName,
      version: "9.9.9",
      risk: "high",
      releaseRisk: "high",
    });

    const shared = await share(app, scanId);
    expect(shared.share.threatFeedListedAt).toBeNull();
    let feed = await fetchFeed(app);
    expect(feed.entries.find((entry) => entry.package === packageName)).toBeUndefined();

    const listed = await share(app, scanId, { threatFeed: true });
    expect(listed.share.threatFeedListedAt).not.toBeNull();
    // Re-sharing without stating feed intent must not unlist.
    const resharedAgain = await share(app, scanId);
    expect(resharedAgain.share.threatFeedListedAt).not.toBeNull();

    feed = await fetchFeed(app);
    expect(feed.schema).toBe("drydock.threat-feed.v1");
    const entry = feed.entries.find((item) => item.package === packageName);
    expect(entry).toMatchObject({
      package: packageName,
      version: "9.9.9",
      ecosystem: "npm",
      packageIdentity: "registry-verified",
      releaseRisk: "high",
    });
    expect(entry?.reportUrl).toBe(`http://example.com/reports/${listed.share.token}`);

    // No org/user identifiers anywhere in the public feed.
    const rawFeed = JSON.stringify(feed);
    expect(rawFeed).not.toContain(owner.organizationId);
    expect(rawFeed).not.toContain(owner.userId);
  });

  test("unlisting and revoking both drop the entry", async () => {
    const owner = await seedUser();
    const app = buildTestApp(owner);
    const packageName = `feed-${crypto.randomUUID().slice(0, 8)}`;
    const scanId = await seedCompletedScan(owner, { packageName });
    await share(app, scanId, { threatFeed: true });
    expect((await fetchFeed(app)).entries.some((entry) => entry.package === packageName)).toBe(
      true,
    );

    const unlisted = await share(app, scanId, { threatFeed: false });
    expect(unlisted.share.threatFeedListedAt).toBeNull();
    expect((await fetchFeed(app)).entries.some((entry) => entry.package === packageName)).toBe(
      false,
    );

    await share(app, scanId, { threatFeed: true });
    const revoke = await request(app, `/api/v1/scans/${scanId}/share`, { method: "DELETE" });
    expect(revoke.status).toBe(200);
    expect((await fetchFeed(app)).entries.some((entry) => entry.package === packageName)).toBe(
      false,
    );

    // Re-sharing after a revoke starts unlisted again.
    const reshared = await share(app, scanId);
    expect(reshared.share.threatFeedListedAt).toBeNull();
  });

  test("feed listing changes are audited as scan events", async () => {
    const owner = await seedUser();
    const app = buildTestApp(owner);
    const scanId = await seedCompletedScan(owner, {
      packageName: `feed-${crypto.randomUUID().slice(0, 8)}`,
    });
    await share(app, scanId, { threatFeed: true });
    await share(app, scanId, { threatFeed: false });

    const detail = (await (await request(app, `/api/v1/scans/${scanId}`)).json()) as {
      events: Array<{ type: string }>;
    };
    const types = detail.events.map((event) => event.type);
    expect(types).toContain("scan.feed_listed");
    expect(types).toContain("scan.feed_unlisted");
  });

  test("gate scans are labeled manifest-claimed and the feed orders newest listing first", async () => {
    const owner = await seedUser();
    const app = buildTestApp(owner);
    const first = `feed-${crypto.randomUUID().slice(0, 8)}`;
    const second = `feed-${crypto.randomUUID().slice(0, 8)}`;
    const gateScan = await seedCompletedScan(owner, {
      packageName: first,
      source: "workflow_gate",
    });
    await share(app, gateScan, { threatFeed: true });
    // Ensure a strictly later listing timestamp for a deterministic order.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const stagedScan = await seedCompletedScan(owner, { packageName: second });
    await share(app, stagedScan, { threatFeed: true });

    const feed = await fetchFeed(app);
    const gateIndex = feed.entries.findIndex((entry) => entry.package === first);
    const stagedIndex = feed.entries.findIndex((entry) => entry.package === second);
    expect(feed.entries[gateIndex]?.packageIdentity).toBe("manifest-claimed");
    expect(feed.entries[stagedIndex]?.packageIdentity).toBe("registry-verified");
    // Listed later → appears first.
    expect(stagedIndex).toBeLessThan(gateIndex);
  });

  test("a null JSON body shares without touching the listing", async () => {
    const owner = await seedUser();
    const app = buildTestApp(owner);
    const scanId = await seedCompletedScan(owner, {
      packageName: `feed-${crypto.randomUUID().slice(0, 8)}`,
    });
    const res = await request(app, `/api/v1/scans/${scanId}/share`, {
      method: "POST",
      body: "null",
    });
    expect(res.status).toBe(200);
    const { share: state } = (await res.json()) as {
      share: { token: string; threatFeedListedAt: string | null };
    };
    expect(state.token).toBeTruthy();
    expect(state.threatFeedListedAt).toBeNull();
  });

  test("another organization cannot list a scan it does not own", async () => {
    const owner = await seedUser();
    const app = buildTestApp(owner);
    const packageName = `feed-${crypto.randomUUID().slice(0, 8)}`;
    const scanId = await seedCompletedScan(owner, { packageName });
    await share(app, scanId);

    const outsider = await seedUser();
    const res = await request(buildTestApp(outsider), `/api/v1/scans/${scanId}/share`, {
      method: "POST",
      body: JSON.stringify({ threatFeed: true }),
    });
    expect(res.status).toBe(404);
    expect((await fetchFeed(app)).entries.some((entry) => entry.package === packageName)).toBe(
      false,
    );
  });
});
