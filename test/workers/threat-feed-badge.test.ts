import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { listOrganizationAuditEvents } from "../../server/db/audit-log";
import { createDb } from "../../server/db/client";
import { ensurePersonalOrganization } from "../../server/db/organizations";
import { createScanJob, persistScan } from "../../server/db/scans";
import * as schema from "../../server/db/schema";
import { describeAuditEvent } from "../../server/lib/auth/audit-events";
import { publicFeedCacheKey } from "../../server/lib/public-feed";
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
    // A gate scan with no provenance snapshot at all: a legacy pre-provenance
    // record, or one whose redaction failed. Its ecosystem is unknowable.
    withoutProvenance?: boolean;
  } = {},
): Promise<string> {
  const db = createDb(env.DB);
  const scanId = `scan_${crypto.randomUUID()}`;
  const stageId = `stage-${scanId.slice(-12)}`;
  const packageName = options.packageName ?? "@org/pkg";
  const version = options.version ?? "1.1.0";
  const risk = options.risk ?? "low";
  // Gate scans persist a provenance snapshot; staged-publish scans do not.
  const gateEcosystem = options.withoutProvenance
    ? null
    : options.ecosystem && options.ecosystem !== "npm"
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
  nextCursor: string | null;
  entries: Array<{
    package: string | null;
    version: string | null;
    ecosystem: string | null;
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
// Mirrors the route module's keying so the helper purges the entry the Worker
// actually wrote: badge paths collapse onto their canonical package key.
// The canonical origin, not the request origin: the Worker keys cache entries
// off canonicalOrigin so the badge write and the dashboard-side purge land on
// the same entry even when the two arrive on different hostnames.
const CANONICAL_TEST_ORIGIN = new URL(env.BETTER_AUTH_URL as string).origin;

function coloCacheKey(path: string): Request {
  const bare = path.split("?")[0];
  return publicFeedCacheKey(CANONICAL_TEST_ORIGIN, bare.replace(/^\/public/, ""));
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
    // A gate-only claim still answers the badge — but says so. The registry
    // never proved this org can publish under that name.
    expect((await fetchBadge(app, "npm", gateOnlyName)).body).toMatchObject({
      label: "drydock (unverified)",
      message: "2.0.0 reviewed · low risk",
      color: "lightgrey",
    });
  });

  test("PyPI and VS Code badges are always labelled unverified", async () => {
    // Only npm has a staged adapter, so every PyPI and VS Code review is a
    // workflow gate and can never be registry-verified. The "verified wins"
    // tiebreak has nothing to prefer there, which makes the label the only
    // thing separating a maintainer's review from anyone's claim on the name.
    for (const ecosystem of ["pypi", "vscode"] as const) {
      const claimant = await seedUser();
      const claimantApp = buildTestApp(claimant);
      const packageName = `pkg-${crypto.randomUUID().slice(0, 8)}`;
      const scanId = await seedCompletedScan(claimant, {
        packageName,
        version: "2.99.0",
        ecosystem,
        source: "workflow_gate",
      });
      await share(claimantApp, scanId, { threatFeed: true });

      const badge = await fetchBadge(claimantApp, ecosystem, packageName);
      expect(badge.body.label).toBe("drydock (unverified)");
      expect(badge.body.color).toBe("lightgrey");
    }
  });

  test("a hostile version string cannot reshape the rendered badge", async () => {
    // Versions come from a package manifest, and for gate scans that manifest
    // is attacker-shaped. shields renders the message into SVG text, so a
    // right-to-left override would reverse the visible run.
    const owner = await seedUser();
    const app = buildTestApp(owner);
    const packageName = `pkg-${crypto.randomUUID().slice(0, 8)}`;
    const scanId = await seedCompletedScan(owner, {
      packageName,
      version: "1.0.0\u202E ksir hgih\u0007",
    });
    await share(app, scanId, { threatFeed: true });

    const badge = await fetchBadge(app, "npm", packageName);
    expect(badge.body.message).toBe("1.0.0 ksir hgih reviewed · low risk");
    expect(badge.body.message).not.toMatch(/[\u200B-\u200F\u2028-\u202E\uFEFF]/);
    // eslint-disable-next-line no-control-regex -- asserting control chars are gone
    expect(badge.body.message).not.toMatch(/[\u0000-\u001F\u007F-\u009F]/);
  });

  test("manifest-claimed scans cannot crowd a verified review out of the candidate page", async () => {
    const owner = await seedUser();
    const app = buildTestApp(owner);
    const packageName = `pkg-${crypto.randomUUID().slice(0, 8)}`;
    const staged = await seedCompletedScan(owner, { packageName, version: "1.0.0", risk: "low" });
    await share(app, staged, { threatFeed: true });
    await env.DB.prepare("UPDATE scans SET completed_at = 1 WHERE id = ?").bind(staged).run();

    const spoofer = await seedUser();
    const spooferApp = buildTestApp(spoofer);
    for (let index = 0; index < 21; index += 1) {
      const gate = await seedCompletedScan(spoofer, {
        packageName,
        version: `9.9.${index}`,
        risk: "high",
        source: "workflow_gate",
      });
      await share(spooferApp, gate, { threatFeed: true });
    }

    const badge = await fetchBadge(app, "npm", packageName);
    expect(badge.body.message).toBe("1.0.0 reviewed · low risk");
  });

  test("badge and feed responses are served from the colo cache", async () => {
    const owner = await seedUser();
    const app = buildTestApp(owner);
    const packageName = `pkg-${crypto.randomUUID().slice(0, 8)}`;
    const scanId = await seedCompletedScan(owner, { packageName, version: "5.0.0" });
    await share(app, scanId, { threatFeed: true });

    const first = await fetchBadge(app, "npm", packageName);
    expect(first.body.message).toBe("5.0.0 reviewed · low risk");

    // Query strings never bypass the cache — the key is the canonical path.
    const busted = await request(app, `/public/badge/npm/${packageName}?bust=${Math.random()}`);
    expect(((await busted.json()) as BadgeBody).message).toBe("5.0.0 reviewed · low risk");

    // Revoking purges both derived surfaces, so the withdrawn review stops
    // being asserted immediately rather than lingering for the cache TTL.
    await request(app, `/api/v1/scans/${scanId}/share`, { method: "DELETE" });
    const afterRevoke = await fetchBadge(app, "npm", packageName, { cached: true });
    expect(afterRevoke.body.message).toBe("not reviewed");
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

  test("a gate scan with no provenance snapshot claims no ecosystem's badge", async () => {
    const owner = await seedUser();
    const app = buildTestApp(owner);
    const packageName = `demo-${crypto.randomUUID().slice(0, 8)}`;
    const scanId = await seedCompletedScan(owner, {
      packageName,
      source: "workflow_gate",
      withoutProvenance: true,
    });
    await share(app, scanId, { threatFeed: true });

    // Defaulting an unknowable ecosystem to npm would hand a PyPI or VS Code
    // release the npm badge for its own name — the one ecosystem where a real
    // registry-verified review exists to be displaced.
    for (const ecosystem of ["npm", "pypi", "vscode"] as const) {
      expect((await fetchBadge(app, ecosystem, packageName)).body.message).toBe("not reviewed");
    }

    // Listing still works; it is only the name-keyed badge that abstains, and
    // the feed reports the unknown rather than inventing a value.
    const feed = await fetchFeed(app);
    const entry = feed.entries.find((item) => item.package === packageName);
    expect(entry).toBeDefined();
    expect(entry?.ecosystem).toBeNull();
  });

  test("canonical ecosystem aliases resolve to the same public badge", async () => {
    const owner = await seedUser();
    const app = buildTestApp(owner);

    const pypiScan = await seedCompletedScan(owner, {
      packageName: "Demo_Package.Name",
      ecosystem: "pypi",
    });
    await share(app, pypiScan, { threatFeed: true });
    expect((await fetchBadge(app, "pypi", "demo-package-name")).body.message).toContain("reviewed");

    const vscodeScan = await seedCompletedScan(owner, {
      packageName: "Publisher.PowerShell",
      ecosystem: "vscode",
    });
    await share(app, vscodeScan, { threatFeed: true });
    expect((await fetchBadge(app, "vscode", "publisher.powershell")).body.message).toContain(
      "reviewed",
    );
  });

  test("accepts valid VS Code identities beyond the npm and PyPI length limit", async () => {
    const owner = await seedUser();
    const app = buildTestApp(owner);
    const packageName = `${"p".repeat(120)}.${"e".repeat(120)}`;
    expect(packageName.length).toBeGreaterThan(214);

    const scanId = await seedCompletedScan(owner, { packageName, ecosystem: "vscode" });
    await share(app, scanId, { threatFeed: true });

    const badge = await fetchBadge(app, "vscode", packageName);
    expect(badge.status).toBe(200);
    expect(badge.body.message).toContain("reviewed");
  });

  test("rejects unknown ecosystems and malformed names", async () => {
    const app = buildTestApp(null);
    expect((await request(app, "/public/badge/cargo/serde")).status).toBe(404);
    expect((await request(app, `/public/badge/npm/${"a".repeat(300)}`)).status).toBe(400);
  });

  test("a throttled badge says unavailable, never not-reviewed", async () => {
    const owner = await seedUser();
    const app = buildTestApp(owner);
    // A package Drydock explicitly blocked. Its badge must never be throttled
    // into the same payload as a package nobody reviewed: shields honours the
    // `cacheSeconds` field and enforces a 300s floor of its own, so a "not
    // reviewed" fallback would render neutral grey over a blocked release in
    // every README embedding it — and badge proxies multiplex unrelated
    // packages through shared egress addresses, so an unrelated burst is
    // enough to trigger it.
    const packageName = `blocked-${crypto.randomUUID().slice(0, 8)}`;
    const scanId = await seedCompletedScan(owner, { packageName, version: "3.0.0", risk: "high" });
    await share(app, scanId, { threatFeed: true });
    await request(app, `/api/v1/scans/${scanId}/decision`, {
      method: "POST",
      body: JSON.stringify({ decision: "no_publish", reason: "malicious" }),
    });
    expect((await fetchBadge(app, "npm", packageName)).body.message).toBe("3.0.0 blocked");

    const ip = `10.1.0.${Math.floor(Math.random() * 200) + 1}`;
    const headers = { "cf-connecting-ip": ip };
    let throttled: BadgeBody | null = null;
    // Distinct package names so every request misses the colo cache and pays
    // the D1 lookup the limiter protects. The limiter counts inside fixed
    // wall-clock windows (floor(now / windowMs), see server/db/rate-limit.ts),
    // so a run that starts near the end of a minute straddles the boundary and
    // loses its progress — under CI load, 125 consecutive requests are not
    // guaranteed to land in one window. The cap leaves room to fill a fresh
    // window (> 2 × the 120 limit) after a straddle wastes the first.
    for (let i = 0; i < 400; i += 1) {
      const res = await request(app, `/public/badge/npm/miss-${i}`, { headers });
      expect(res.status).toBe(200);
      if (res.headers.has("retry-after")) {
        expect(res.headers.get("cache-control")).toBe("no-store");
        throttled = (await res.json()) as BadgeBody;
        break;
      }
    }
    expect(throttled).not.toBeNull();
    // Still a valid shields payload — proxies must not render an error badge.
    expect(throttled?.schemaVersion).toBe(1);
    expect(throttled?.message).toBe("unavailable");
    expect(throttled?.message).not.toBe("not reviewed");

    // And the throttled fallback for the blocked package is distinguishable
    // from its real badge rather than silently replacing it.
    const blockedUnderThrottle = await request(
      app,
      `/public/badge/npm/${encodeURIComponent(packageName)}`,
      { headers },
    );
    expect(((await blockedUnderThrottle.json()) as BadgeBody).message).not.toBe("not reviewed");
    // The timeout is tied to the loop cap above: a straddled run pays for a
    // wasted window before filling a fresh one, so the worst case is hundreds of
    // sequential D1-backed requests. The 5s default covers the fast path (~250ms
    // locally) but not that worst case on a loaded runner, which is a timeout
    // rather than a limiter bug. Raise both together or neither.
  }, 30_000);

  test("badge misses are not written to the colo cache", async () => {
    const app = buildTestApp(null);
    // Every invented name would otherwise add an entry to the same
    // caches.default namespace that holds published-tarball bytes.
    const missName = `never-scanned-${crypto.randomUUID().slice(0, 8)}`;
    const res = await request(app, `/public/badge/npm/${missName}`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as BadgeBody).message).toBe("not reviewed");
    // The internal opt-out marker must not leak to clients.
    expect(res.headers.get("x-drydock-colo-cache-skip")).toBeNull();

    const cache = (caches as unknown as { default: Cache }).default;
    expect(await cache.match(coloCacheKey(`/public/badge/npm/${missName}`))).toBeUndefined();
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

    const { events } = await listOrganizationAuditEvents(createDb(env.DB), owner.organizationId);
    const feedEvents = events.filter((event) => event.type.startsWith("scan.feed_"));
    expect(feedEvents.map((event) => event.type).sort()).toEqual([
      "scan.feed_listed",
      "scan.feed_unlisted",
    ]);
    for (const event of feedEvents) {
      const descriptor = describeAuditEvent(event.type, event.metadataJson);
      expect(descriptor?.category).toBe("security");
      expect(descriptor?.detail).toMatch(/^feed-.+@1\.1\.0$/);
    }
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

  test("unlisting a revoked share does not republish it", async () => {
    const owner = await seedUser();
    const app = buildTestApp(owner);
    const packageName = `feed-${crypto.randomUUID().slice(0, 8)}`;
    const scanId = await seedCompletedScan(owner, { packageName });
    await share(app, scanId, { threatFeed: true });

    // Another admin (or the same user in another tab) revokes the link.
    const revoke = await request(app, `/api/v1/scans/${scanId}/share`, { method: "DELETE" });
    expect(revoke.status).toBe(200);

    // The stale dialog still shows the checkbox; unchecking it must not turn a
    // withdrawal into a fresh publication.
    const unlist = await request(app, `/api/v1/scans/${scanId}/share`, {
      method: "POST",
      body: JSON.stringify({ threatFeed: false }),
    });
    expect(unlist.status).toBe(409);
    expect(await unlist.text()).not.toContain("/reports/");

    // Still revoked: no token was minted on the way through.
    const detail = (await (await request(app, `/api/v1/scans/${scanId}`)).json()) as {
      scan: { publicShareUrl: string | null; publicShareToken: string | null };
    };
    expect(detail.scan.publicShareUrl).toBeNull();
    expect(detail.scan.publicShareToken).toBeNull();
    expect((await fetchFeed(app)).entries.some((entry) => entry.package === packageName)).toBe(
      false,
    );
  });

  test("unlisting a live share still works and leaves the link alone", async () => {
    const owner = await seedUser();
    const app = buildTestApp(owner);
    const packageName = `feed-${crypto.randomUUID().slice(0, 8)}`;
    const scanId = await seedCompletedScan(owner, { packageName });
    const { share: listed } = await share(app, scanId, { threatFeed: true });

    const { share: unlisted } = await share(app, scanId, { threatFeed: false });
    expect(unlisted.token).toBe(listed.token);
    expect(unlisted.threatFeedListedAt).toBeNull();
    expect((await fetchFeed(app)).entries.some((entry) => entry.package === packageName)).toBe(
      false,
    );
  });

  test("the feed pages backwards so a burst of listings cannot hide older entries", async () => {
    const owner = await seedUser();
    const app = buildTestApp(owner);
    const packageNames = [] as string[];
    for (let i = 0; i < 3; i += 1) {
      const packageName = `page-${crypto.randomUUID().slice(0, 8)}`;
      packageNames.push(packageName);
      const scanId = await seedCompletedScan(owner, { packageName });
      await share(app, scanId, { threatFeed: true });
    }

    // One entry per page, so the cursor is exercised rather than everything
    // fitting in the first response.
    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    for (let page = 0; page < 50; page += 1) {
      const suffix: string = cursor ? `&after=${encodeURIComponent(cursor)}` : "";
      const res = await request(app, `/public/threat-feed.json?limit=1${suffix}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as FeedBody;
      expect(body.entries.length).toBeLessThanOrEqual(1);
      pages += 1;
      for (const entry of body.entries) if (entry.package) seen.add(entry.package);
      cursor = body.nextCursor;
      if (!cursor) break;
    }
    expect(pages).toBeGreaterThan(1);
    // Every listing is reachable by walking the cursor, in order.
    for (const packageName of packageNames) expect(seen.has(packageName)).toBe(true);

    // A malformed cursor is ignored rather than erroring or emptying the feed.
    const malformed = await request(app, "/public/threat-feed.json?after=not-a-cursor");
    expect(malformed.status).toBe(200);
    expect(((await malformed.json()) as FeedBody).entries.length).toBeGreaterThan(0);
  });
});
