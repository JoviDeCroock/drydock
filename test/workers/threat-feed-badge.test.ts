import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { listOrganizationAuditEvents } from "../../server/db/audit-log";
import { createDb } from "../../server/db/client";
import { createScanJob } from "../../server/db/scans";
import * as schema from "../../server/db/schema";
import { describeAuditEvent } from "../../server/lib/auth/audit-events";
import { publicFeedCacheKey } from "../../server/lib/public-feed";
import type { RiskLevel } from "../../server/lib/review/types";
import { publicReportsRoutes } from "../../server/routes/public-reports";
import { scansRoutes } from "../../server/routes/scans";
import { buildTestApp, type TestApp } from "./helpers/app";
import { type SeededUser, seedUser } from "./helpers/seed";
import { type ScanOwner, seedCompletedScan } from "./helpers/seed";

function seedBadgeScan(
  owner: ScanOwner,
  options: {
    packageName?: string;
    version?: string;
    risk?: RiskLevel;
    releaseRisk?: RiskLevel;
    ecosystem?: "npm" | "pypi" | "vscode";
    source?: "manual" | "auto_discovery" | "workflow_gate" | "published";
    registryUrl?: string;
    // The dist-tag the release was staged under. Only npm staged-publish scans
    // carry one; omitted means a review that was never staged under a tag.
    tag?: string;
    // A gate scan with no provenance snapshot at all: a legacy pre-provenance
    // record, or one whose redaction failed. Its ecosystem is unknowable.
    withoutProvenance?: boolean;
  } = {},
): Promise<string> {
  const packageName = options.packageName ?? "@org/pkg";
  const version = options.version ?? "1.1.0";
  const risk = options.risk ?? "low";
  // Gate scans persist a provenance snapshot; staged-publish scans do not.
  const gateEcosystem =
    options.source === "published" || options.withoutProvenance
      ? null
      : options.ecosystem && options.ecosystem !== "npm"
        ? options.ecosystem
        : options.source === "workflow_gate"
          ? "npm"
          : null;
  const source = options.source ?? (gateEcosystem ? "workflow_gate" : "manual");
  // A published-pair review names its own registry in the summary and holds no
  // provenance snapshot: nothing about it was staged.
  const publishedPair =
    source === "published"
      ? {
          mode: "published_pair",
          ecosystem: options.ecosystem ?? "npm",
          packageName,
          version,
          baselineVersion: "1.0.0",
          registryUrl: "https://registry.npmjs.org",
          notices: [],
        }
      : null;
  return seedCompletedScan(owner, {
    job: {
      source,
      packageName:
        source === "published" || (source !== "workflow_gate" && options.registryUrl)
          ? packageName
          : null,
      stagedVersion:
        source === "published" || (source !== "workflow_gate" && options.registryUrl)
          ? version
          : null,
      // A published-pair review claims no registry coordinates: the release it
      // reviews is already public and belongs to whoever published it.
      registryUrl:
        source === "manual" || source === "auto_discovery" ? (options.registryUrl ?? null) : null,
    },
    packageJson: { name: packageName, version },
    risk,
    summary: {
      report: { version: 1, digest: "abc123", digestAlgorithm: "sha256" },
      ...(publishedPair ? { stagedPublish: publishedPair } : {}),
      ...(!gateEcosystem && !publishedPair && options.tag
        ? { stagedPublish: { tag: options.tag } }
        : {}),
      ...(gateEcosystem
        ? {
            stagedPublish: {
              ...(options.tag ? { tag: options.tag } : {}),
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
    files: [],
    diff: [],
    persist: {
      riskSummary: {
        artifactRisk: risk,
        releaseRisk: options.releaseRisk ?? risk,
        contextRisk: "low",
        releaseFindingCount: 0,
        contextFindingCount: 0,
        unknownFindingCount: 0,
        priorApprovedContextFindingCount: 0,
      },
    },
  });
}

// Anonymous `/public` is always mounted; the session (and the scans API) only when signed in.
const publicApp = (session: SeededUser | null) =>
  buildTestApp(
    (app) => {
      app.route("/public", publicReportsRoutes);
      if (session) app.route("/api/v1/scans", scansRoutes);
    },
    session,
    { authPath: "/api/*" },
  );

async function request(app: TestApp, path: string, options: RequestInit = {}) {
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
    tag: string | null;
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

// The badge key varies by dist-tag, so the query has to be carried through:
// purging with the bare path would clear the `latest` entry while the test
// asserts on a `?tag=beta` one.
function coloCacheKey(path: string): Request {
  const [bare, search] = path.split("?");
  return publicFeedCacheKey(
    CANONICAL_TEST_ORIGIN,
    bare.replace(/^\/public/, ""),
    search ? `?${search}` : "",
  );
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
  options: { cached?: boolean; tag?: string } = {},
): Promise<{ status: number; body: BadgeBody }> {
  const path =
    `/public/badge/${ecosystem}/${name}` +
    (options.tag === undefined ? "" : `?tag=${encodeURIComponent(options.tag)}`);
  if (!options.cached) await purgeColoCache(path);
  const res = await request(app, path);
  return { status: res.status, body: (await res.json()) as BadgeBody };
}

describe("shields badge endpoint", () => {
  test("only feed-listed reviews surface; sharing alone stays not reviewed", async () => {
    const owner = await seedUser();
    const app = publicApp(owner);
    const packageName = `pkg-${crypto.randomUUID().slice(0, 8)}`;

    const before = await fetchBadge(app, "npm", packageName);
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({
      schemaVersion: 1,
      label: "drydock",
      message: "not reviewed",
      color: "lightgrey",
    });

    const scanId = await seedBadgeScan(owner, { packageName, version: "2.0.0", risk: "low" });
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

  test("restaging retires the obsolete public report, badge, and feed entry", async () => {
    const owner = await seedUser();
    const app = publicApp(owner);
    const packageName = `pkg-${crypto.randomUUID().slice(0, 8)}`;
    const version = "2.0.0";
    const registryUrl = "https://registry.npmjs.org";
    const scanId = await seedBadgeScan(owner, {
      packageName,
      version,
      registryUrl,
    });
    const decision = await request(app, `/api/v1/scans/${scanId}/decision`, {
      method: "POST",
      body: JSON.stringify({ decision: "publish", reason: "intended changes" }),
    });
    expect(decision.status).toBe(200);
    const { share: publicShare } = await share(app, scanId, { threatFeed: true });
    expect((await fetchBadge(app, "npm", packageName)).body.message).toBe(`${version} approved`);

    const db = createDb(env.DB);
    await createScanJob(db, {
      id: `scan_${crypto.randomUUID()}`,
      stageId: `stage-${crypto.randomUUID()}`,
      organizationId: owner.organizationId,
      ownerUserId: owner.userId,
      packageName,
      stagedVersion: version,
      registryUrl,
    });

    const [superseded] = await db
      .select({
        registryStatusSupersededAt: schema.scans.registryStatusSupersededAt,
        publicShareToken: schema.scans.publicShareToken,
        publicSharedAt: schema.scans.publicSharedAt,
        publicSharedByUserId: schema.scans.publicSharedByUserId,
        publicFeedListedAt: schema.scans.publicFeedListedAt,
        publicPackageKey: schema.scans.publicPackageKey,
      })
      .from(schema.scans)
      .where(eq(schema.scans.id, scanId))
      .limit(1);
    expect(superseded).toMatchObject({
      registryStatusSupersededAt: expect.any(Date),
      publicShareToken: null,
      publicSharedAt: null,
      publicSharedByUserId: null,
      publicFeedListedAt: null,
      publicPackageKey: null,
    });
    expect((await request(app, `/public/reports/${publicShare.token}`)).status).toBe(404);
    expect(
      (
        await request(app, `/api/v1/scans/${scanId}/share`, {
          method: "POST",
          body: "{}",
        })
      ).status,
    ).toBe(409);
    expect((await fetchBadge(app, "npm", packageName)).body.message).toBe("not reviewed");
    expect((await fetchFeed(app)).entries.some((entry) => entry.package === packageName)).toBe(
      false,
    );
  });

  test("registry-verified reviews outrank newer manifest-claimed gate scans", async () => {
    const owner = await seedUser();
    const app = publicApp(owner);
    const packageName = `pkg-${crypto.randomUUID().slice(0, 8)}`;

    const staged = await seedBadgeScan(owner, { packageName, version: "1.0.0", risk: "low" });
    await share(app, staged, { threatFeed: true });

    // A later workflow-gate scan claims the same npm name (manifest-claimed
    // identity) — it must not override the registry-verified badge.
    const spoofer = await seedUser();
    const gate = await seedBadgeScan(spoofer, {
      packageName,
      version: "9.9.9",
      risk: "high",
      releaseRisk: "high",
      source: "workflow_gate",
    });
    await share(publicApp(spoofer), gate, { threatFeed: true });

    const badge = await fetchBadge(app, "npm", packageName);
    expect(badge.body.message).toBe("1.0.0 reviewed · low risk");

    // With no verified review, the gate scan is what the org published — shown.
    const gateOnlyName = `pkg-${crypto.randomUUID().slice(0, 8)}`;
    const gateOnly = await seedBadgeScan(spoofer, {
      packageName: gateOnlyName,
      version: "2.0.0",
      source: "workflow_gate",
    });
    await share(publicApp(spoofer), gateOnly, { threatFeed: true });
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
      const claimantApp = publicApp(claimant);
      const packageName = `pkg-${crypto.randomUUID().slice(0, 8)}`;
      const scanId = await seedBadgeScan(claimant, {
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
    const app = publicApp(owner);
    const packageName = `pkg-${crypto.randomUUID().slice(0, 8)}`;
    const scanId = await seedBadgeScan(owner, {
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
    const app = publicApp(owner);
    const packageName = `pkg-${crypto.randomUUID().slice(0, 8)}`;
    const staged = await seedBadgeScan(owner, { packageName, version: "1.0.0", risk: "low" });
    await share(app, staged, { threatFeed: true });
    await env.DB.prepare("UPDATE scans SET completed_at = 1 WHERE id = ?").bind(staged).run();

    const spoofer = await seedUser();
    const spooferApp = publicApp(spoofer);
    for (let index = 0; index < 21; index += 1) {
      const gate = await seedBadgeScan(spoofer, {
        packageName,
        version: `9.9.${index}`,
        risk: "high",
        source: "workflow_gate",
      });
      await share(spooferApp, gate, { threatFeed: true });
    }

    const badge = await fetchBadge(app, "npm", packageName);
    expect(badge.body.message).toBe("1.0.0 reviewed · low risk");
    // Crowding the 20-row candidate page requires 21 complete scan-and-share
    // setups. Loaded CI runners can exceed Vitest's 5s default even though the
    // assertion is deterministic, so budget the deliberate D1 workload here.
  }, 15_000);

  test("badge and feed responses are served from the colo cache", async () => {
    const owner = await seedUser();
    const app = publicApp(owner);
    const packageName = `pkg-${crypto.randomUUID().slice(0, 8)}`;
    const scanId = await seedBadgeScan(owner, { packageName, version: "5.0.0" });
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
    const app = publicApp(owner);
    const packageName = `pkg-${crypto.randomUUID().slice(0, 8)}`;
    const longVersion = `1.0.0-${"x".repeat(200)}`;
    const scanId = await seedBadgeScan(owner, { packageName, version: longVersion });
    await share(app, scanId, { threatFeed: true });

    const badge = await fetchBadge(app, "npm", packageName);
    expect(badge.body.message.length).toBeLessThan(100);
    expect(badge.body.message).toContain("reviewed · low risk");
  });

  test("scoped npm names with slashes resolve through the wildcard route", async () => {
    const owner = await seedUser();
    const app = publicApp(owner);
    const packageName = `@scope-${crypto.randomUUID().slice(0, 6)}/pkg`;
    const scanId = await seedBadgeScan(owner, { packageName });
    await share(app, scanId, { threatFeed: true });

    const badge = await fetchBadge(app, "npm", packageName);
    expect(badge.body.message).toContain("reviewed");

    const encoded = await fetchBadge(app, "npm", encodeURIComponent(packageName));
    expect(encoded.body.message).toContain("reviewed");
  });

  test("high risk and blocked releases surface as red badges", async () => {
    const owner = await seedUser();
    const app = publicApp(owner);
    const packageName = `pkg-${crypto.randomUUID().slice(0, 8)}`;
    const scanId = await seedBadgeScan(owner, {
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

  test("an approved release reads approved, not its pre-decision risk grade", async () => {
    const owner = await seedUser();
    const app = publicApp(owner);
    const packageName = `pkg-${crypto.randomUUID().slice(0, 8)}`;
    const scanId = await seedBadgeScan(owner, {
      packageName,
      version: "4.0.0",
      risk: "medium",
      releaseRisk: "medium",
    });
    await share(app, scanId, { threatFeed: true });
    // Before the decision, the badge reports the evidence.
    expect((await fetchBadge(app, "npm", packageName)).body).toMatchObject({
      message: "4.0.0 reviewed · medium risk",
      color: "yellow",
    });

    const decide = await request(app, `/api/v1/scans/${scanId}/decision`, {
      method: "POST",
      body: JSON.stringify({ decision: "publish", reason: "intended changes" }),
    });
    expect(decide.status).toBe(200);
    // After sign-off the decision is the message; the grade stays in the
    // report behind the badge.
    expect((await fetchBadge(app, "npm", packageName)).body).toMatchObject({
      label: "drydock",
      message: "4.0.0 approved",
      color: "brightgreen",
    });

    // A publish → no_publish flip must not keep serving the cached
    // "approved" payload: the decision route purges the badge entry, so even
    // a cached read reflects the reversal immediately in this colo.
    const reverse = await request(app, `/api/v1/scans/${scanId}/decision`, {
      method: "POST",
      body: JSON.stringify({ decision: "no_publish", reason: "compromised" }),
    });
    expect(reverse.status).toBe(200);
    expect((await fetchBadge(app, "npm", packageName, { cached: true })).body).toMatchObject({
      message: "4.0.0 blocked",
      color: "red",
    });
  });

  test("an approved prerelease stays on its own release line", async () => {
    // Where the approved-badge state and the tag axis meet: the decision must
    // not launder a prerelease onto the default badge, and the purge the
    // decision route fires has to address the line the badge actually occupies.
    const owner = await seedUser();
    const app = publicApp(owner);
    const packageName = `pkg-${crypto.randomUUID().slice(0, 8)}`;
    const stable = await seedBadgeScan(owner, { packageName, version: "1.0.0", tag: "latest" });
    await share(app, stable, { threatFeed: true });
    const rc = await seedBadgeScan(owner, {
      packageName,
      version: "2.0.0-rc.0",
      risk: "medium",
      releaseRisk: "medium",
      tag: "rc",
    });
    await share(app, rc, { threatFeed: true });
    // Warm both entries so the purge below has something to invalidate.
    expect((await fetchBadge(app, "npm", packageName)).body.message).toBe(
      "1.0.0 reviewed · low risk",
    );
    expect((await fetchBadge(app, "npm", packageName, { tag: "rc" })).body.message).toBe(
      "2.0.0-rc.0 reviewed · medium risk",
    );

    const decide = await request(app, `/api/v1/scans/${rc}/decision`, {
      method: "POST",
      body: JSON.stringify({ decision: "publish", reason: "intended changes" }),
    });
    expect(decide.status).toBe(200);

    // The rc entry was purged, so even a cached read shows the sign-off — and
    // it is still labelled as the rc line, not as the package's headline.
    expect(
      (await fetchBadge(app, "npm", packageName, { tag: "rc", cached: true })).body,
    ).toMatchObject({
      label: "drydock (rc)",
      message: "2.0.0-rc.0 approved",
      color: "brightgreen",
    });
    // The stable badge is untouched by a decision on another line.
    expect((await fetchBadge(app, "npm", packageName, { cached: true })).body.message).toBe(
      "1.0.0 reviewed · low risk",
    );
  });

  test("an approved manifest-claimed release stays visibly unverified", async () => {
    const owner = await seedUser();
    const app = publicApp(owner);
    const packageName = `pkg-${crypto.randomUUID().slice(0, 8)}`;
    const scanId = await seedBadgeScan(owner, {
      packageName,
      version: "2.0.0",
      source: "workflow_gate",
    });
    await share(app, scanId, { threatFeed: true });
    // The badge reads the persisted row, not any route: write the decision
    // directly so the assertion stays independent of which decision flow
    // (gate or staged) recorded it.
    await env.DB.prepare("UPDATE scans SET decision = 'publish' WHERE id = ?").bind(scanId).run();
    expect((await fetchBadge(app, "npm", packageName)).body).toMatchObject({
      label: "drydock (unverified)",
      message: "2.0.0 approved",
      color: "lightgrey",
    });
  });

  test("a published-pair review never answers the package's badge", async () => {
    // Nothing about this org relates to the package: a published-pair scan
    // needs no npm credential and runs against any already-public release.
    const stranger = await seedUser();
    const app = publicApp(stranger);
    const packageName = `pkg-${crypto.randomUUID().slice(0, 8)}`;
    const scanId = await seedBadgeScan(stranger, {
      packageName,
      version: "3.0.0",
      source: "published",
    });
    await share(app, scanId, { threatFeed: true });
    const decide = await request(app, `/api/v1/scans/${scanId}/decision`, {
      method: "POST",
      body: JSON.stringify({ decision: "publish", reason: "vetted for internal use" }),
    });
    expect(decide.status).toBe(200);

    // No approval badge is mintable for a name the reviewer has no claim on.
    expect((await fetchBadge(app, "npm", packageName)).body).toMatchObject({
      label: "drydock",
      message: "not reviewed",
      color: "lightgrey",
    });
    // Listing gave it no badge key at all, so no cached entry can exist either.
    const db = createDb(env.DB);
    const [row] = await db
      .select({
        publicPackageKey: schema.scans.publicPackageKey,
        publicFeedListedAt: schema.scans.publicFeedListedAt,
      })
      .from(schema.scans)
      .where(eq(schema.scans.id, scanId));
    expect(row).toMatchObject({
      publicPackageKey: null,
      publicFeedListedAt: expect.any(Date),
    });
  });

  test("a published-pair review cannot displace a registry-verified badge", async () => {
    const maintainer = await seedUser();
    const app = publicApp(maintainer);
    const packageName = `pkg-${crypto.randomUUID().slice(0, 8)}`;
    const staged = await seedBadgeScan(maintainer, {
      packageName,
      version: "1.0.0",
      risk: "low",
    });
    await share(app, staged, { threatFeed: true });

    const attacker = await seedUser();
    const attackerApp = publicApp(attacker);
    const forged = await seedBadgeScan(attacker, {
      packageName,
      version: "9.9.9",
      source: "published",
    });
    await share(attackerApp, forged, { threatFeed: true });
    await env.DB.prepare("UPDATE scans SET decision = 'publish' WHERE id = ?").bind(forged).run();

    expect((await fetchBadge(app, "npm", packageName)).body.message).toBe(
      "1.0.0 reviewed · low risk",
    );
  });

  test("a badge-ineligible source is excluded even if it already holds a badge key", async () => {
    // Second lock: a row that acquired a key before its source was classified
    // ineligible must still never be picked.
    const stranger = await seedUser();
    const app = publicApp(stranger);
    const packageName = `pkg-${crypto.randomUUID().slice(0, 8)}`;
    const scanId = await seedBadgeScan(stranger, {
      packageName,
      version: "3.0.0",
      source: "published",
    });
    await share(app, scanId, { threatFeed: true });
    await env.DB.prepare("UPDATE scans SET public_package_key = ? WHERE id = ?")
      .bind(`npm:${packageName}`, scanId)
      .run();

    expect((await fetchBadge(app, "npm", packageName)).body.message).toBe("not reviewed");
  });

  test("the badge is ecosystem-scoped", async () => {
    const owner = await seedUser();
    const app = publicApp(owner);
    const packageName = `demo-${crypto.randomUUID().slice(0, 8)}`;
    const scanId = await seedBadgeScan(owner, { packageName, ecosystem: "pypi" });
    await share(app, scanId, { threatFeed: true });

    expect((await fetchBadge(app, "pypi", packageName)).body.message).toContain("reviewed");
    expect((await fetchBadge(app, "npm", packageName)).body.message).toBe("not reviewed");
  });

  test("a gate scan with no provenance snapshot claims no ecosystem's badge", async () => {
    const owner = await seedUser();
    const app = publicApp(owner);
    const packageName = `demo-${crypto.randomUUID().slice(0, 8)}`;
    const scanId = await seedBadgeScan(owner, {
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
    const app = publicApp(owner);

    const pypiScan = await seedBadgeScan(owner, {
      packageName: "Demo_Package.Name",
      ecosystem: "pypi",
    });
    await share(app, pypiScan, { threatFeed: true });
    expect((await fetchBadge(app, "pypi", "demo-package-name")).body.message).toContain("reviewed");

    const vscodeScan = await seedBadgeScan(owner, {
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
    const app = publicApp(owner);
    const packageName = `${"p".repeat(120)}.${"e".repeat(120)}`;
    expect(packageName.length).toBeGreaterThan(214);

    const scanId = await seedBadgeScan(owner, { packageName, ecosystem: "vscode" });
    await share(app, scanId, { threatFeed: true });

    const badge = await fetchBadge(app, "vscode", packageName);
    expect(badge.status).toBe(200);
    expect(badge.body.message).toContain("reviewed");
  });

  test("rejects unknown ecosystems and malformed names", async () => {
    const app = publicApp(null);
    expect((await request(app, "/public/badge/cargo/serde")).status).toBe(404);
    expect((await request(app, `/public/badge/npm/${"a".repeat(300)}`)).status).toBe(400);
  });

  test("a throttled badge says unavailable, never not-reviewed", async () => {
    const owner = await seedUser();
    const app = publicApp(owner);
    // A package Drydock explicitly blocked. Its badge must never be throttled
    // into the same payload as a package nobody reviewed: shields honours the
    // `cacheSeconds` field and enforces a 300s floor of its own, so a "not
    // reviewed" fallback would render neutral grey over a blocked release in
    // every README embedding it — and badge proxies multiplex unrelated
    // packages through shared egress addresses, so an unrelated burst is
    // enough to trigger it.
    const packageName = `blocked-${crypto.randomUUID().slice(0, 8)}`;
    const scanId = await seedBadgeScan(owner, { packageName, version: "3.0.0", risk: "high" });
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
    // wall-clock windows (floor(now / windowMs), see
    // server/lib/platform/rate-limit.ts),
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

  test("a listed prerelease review never displaces the default badge", async () => {
    // The regression this exists for: the badge used to be version-agnostic and
    // resolved to the newest listed review, so listing an rc repointed every
    // embedded badge — including the one sitting next to `npm i <pkg>` — at a
    // release nobody installs by default.
    const owner = await seedUser();
    const app = publicApp(owner);
    const packageName = `pkg-${crypto.randomUUID().slice(0, 8)}`;

    const stable = await seedBadgeScan(owner, {
      packageName,
      version: "10.29.8",
      tag: "latest",
    });
    await share(app, stable, { threatFeed: true });
    await env.DB.prepare("UPDATE scans SET completed_at = 1 WHERE id = ?").bind(stable).run();

    // Newer in every ordering the query applies, and still not the default.
    const rc = await seedBadgeScan(owner, {
      packageName,
      version: "11.0.0-rc.0",
      risk: "medium",
      releaseRisk: "medium",
      tag: "rc",
    });
    await share(app, rc, { threatFeed: true });

    expect((await fetchBadge(app, "npm", packageName)).body).toMatchObject({
      label: "drydock",
      message: "10.29.8 reviewed · low risk",
    });
    // The prerelease line has its own badge, and its label names the tag so a
    // README carrying both rows can be read apart.
    expect((await fetchBadge(app, "npm", packageName, { tag: "rc" })).body).toMatchObject({
      label: "drydock (rc)",
      message: "11.0.0-rc.0 reviewed · medium risk",
    });
    // An explicit `latest` is the same request as the default.
    expect((await fetchBadge(app, "npm", packageName, { tag: "latest" })).body.message).toBe(
      "10.29.8 reviewed · low risk",
    );
    // A tag nobody listed is "not reviewed", not the stable review under
    // another name — but still says which line it answered for.
    expect((await fetchBadge(app, "npm", packageName, { tag: "next" })).body).toMatchObject({
      label: "drydock (next)",
      message: "not reviewed",
    });
  });

  test("npm-valid URI-safe punctuation remains addressable as a release line", async () => {
    // npm accepts dist-tags made from characters encodeURIComponent leaves
    // intact. Treating `~` as malformed made the persisted non-null tag miss
    // both the default SQL population and every explicitly queryable line.
    const owner = await seedUser();
    const app = publicApp(owner);
    const packageName = `pkg-${crypto.randomUUID().slice(0, 8)}`;
    const scanId = await seedBadgeScan(owner, {
      packageName,
      version: "2.0.0-beta.1",
      tag: "beta~edge",
    });
    await share(app, scanId, { threatFeed: true });

    expect((await fetchBadge(app, "npm", packageName, { tag: "beta~edge" })).body).toMatchObject({
      label: "drydock (beta~edge)",
      message: "2.0.0-beta.1 reviewed · low risk",
    });
    expect((await fetchBadge(app, "npm", packageName)).body.message).toBe("not reviewed");
  });

  test("tags do not share a colo cache entry", async () => {
    // The cache key ignores the query string by design (cache-busting must not
    // force a D1 read); the tag is the one parameter that changes the body, so
    // it has to be folded into the key or `?tag=beta` is served the `latest`
    // body for the rest of the TTL.
    const owner = await seedUser();
    const app = publicApp(owner);
    const packageName = `pkg-${crypto.randomUUID().slice(0, 8)}`;

    const stable = await seedBadgeScan(owner, { packageName, version: "1.0.0", tag: "latest" });
    await share(app, stable, { threatFeed: true });
    const beta = await seedBadgeScan(owner, {
      packageName,
      version: "2.0.0-beta.1",
      tag: "beta",
    });
    await share(app, beta, { threatFeed: true });

    // Warm the default entry first, then read the beta one through the cache.
    expect((await fetchBadge(app, "npm", packageName)).body.message).toBe(
      "1.0.0 reviewed · low risk",
    );
    expect(
      (await fetchBadge(app, "npm", packageName, { tag: "beta", cached: true })).body.message,
    ).toBe("2.0.0-beta.1 reviewed · low risk");
    // Still cached per tag, and still ignoring everything else in the query.
    const busted = await request(app, `/public/badge/npm/${packageName}?tag=beta&bust=1`);
    expect(((await busted.json()) as BadgeBody).message).toBe("2.0.0-beta.1 reviewed · low risk");

    // Unlisting the beta review purges the entry it actually occupied, and
    // leaves the default badge alone.
    await share(app, beta, { threatFeed: false });
    expect(
      (await fetchBadge(app, "npm", packageName, { tag: "beta", cached: true })).body.message,
    ).toBe("not reviewed");
    expect((await fetchBadge(app, "npm", packageName, { cached: true })).body.message).toBe(
      "1.0.0 reviewed · low risk",
    );
  });

  test("untagged reviews answer only the default badge", async () => {
    // Two populations have no dist-tag: ecosystems that have none at all, and
    // staged scans predating tag capture. Both describe the release a consumer
    // installs by default, so they must keep working — without answering a
    // question about some other release line.
    const owner = await seedUser();
    const app = publicApp(owner);
    const packageName = `pkg-${crypto.randomUUID().slice(0, 8)}`;
    const legacy = await seedBadgeScan(owner, { packageName, version: "4.0.0" });
    await share(app, legacy, { threatFeed: true });

    expect((await fetchBadge(app, "npm", packageName)).body.message).toBe(
      "4.0.0 reviewed · low risk",
    );
    expect((await fetchBadge(app, "npm", packageName, { tag: "beta" })).body.message).toBe(
      "not reviewed",
    );

    // Same for an ecosystem with no dist-tag concept at all.
    const pypiName = `pkg-${crypto.randomUUID().slice(0, 8)}`;
    const pypi = await seedBadgeScan(owner, {
      packageName: pypiName,
      version: "1.2.3",
      ecosystem: "pypi",
      source: "workflow_gate",
    });
    await share(app, pypi, { threatFeed: true });
    expect((await fetchBadge(app, "pypi", pypiName)).body.message).toBe(
      "1.2.3 reviewed · low risk",
    );
    expect((await fetchBadge(app, "pypi", pypiName, { tag: "rc" })).body.message).toBe(
      "not reviewed",
    );
  });

  test("a prerelease line cannot crowd the stable review out of the candidate page", async () => {
    // An active prerelease line publishes far more often than the stable one,
    // so the tag has to be filtered in SQL: a page taken before the filter
    // would be all `rc` rows and the default badge would read "not reviewed"
    // with a listed stable review sitting just past the limit.
    const owner = await seedUser();
    const app = publicApp(owner);
    const packageName = `pkg-${crypto.randomUUID().slice(0, 8)}`;
    const stable = await seedBadgeScan(owner, { packageName, version: "1.0.0", tag: "latest" });
    await share(app, stable, { threatFeed: true });
    await env.DB.prepare("UPDATE scans SET completed_at = 1 WHERE id = ?").bind(stable).run();

    for (let index = 0; index < 21; index += 1) {
      const rc = await seedBadgeScan(owner, {
        packageName,
        version: `2.0.0-rc.${index}`,
        tag: "rc",
      });
      await share(app, rc, { threatFeed: true });
    }

    expect((await fetchBadge(app, "npm", packageName)).body.message).toBe(
      "1.0.0 reviewed · low risk",
    );
  });

  test("a malformed tag is rejected rather than resolved to latest", async () => {
    const owner = await seedUser();
    const app = publicApp(owner);
    const packageName = `pkg-${crypto.randomUUID().slice(0, 8)}`;
    const scanId = await seedBadgeScan(owner, { packageName, version: "1.0.0", tag: "latest" });
    await share(app, scanId, { threatFeed: true });
    // Warm the default entry: a malformed tag must not be answered out of it.
    expect((await fetchBadge(app, "npm", packageName)).body.message).toBe(
      "1.0.0 reviewed · low risk",
    );

    // Silently falling back would answer a typo'd parameter with a badge about
    // a different release line, and the embedder would never find out.
    for (const bad of ["", "   ", "../latest", "beta rc", "a".repeat(65), "‮rtsl"]) {
      const res = await request(
        app,
        `/public/badge/npm/${packageName}?tag=${encodeURIComponent(bad)}`,
      );
      expect(res.status).toBe(400);
      // Badge errors are fetched cross-origin by the same proxies as the 200s.
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
    }
  });

  test("badge misses are not written to the colo cache", async () => {
    const app = publicApp(null);
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
    const app = publicApp(owner);
    const packageName = `feed-${crypto.randomUUID().slice(0, 8)}`;
    const scanId = await seedBadgeScan(owner, {
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
    const app = publicApp(owner);
    const packageName = `feed-${crypto.randomUUID().slice(0, 8)}`;
    const scanId = await seedBadgeScan(owner, { packageName });
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
    const app = publicApp(owner);
    const scanId = await seedBadgeScan(owner, {
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
    const app = publicApp(owner);
    const first = `feed-${crypto.randomUUID().slice(0, 8)}`;
    const second = `feed-${crypto.randomUUID().slice(0, 8)}`;
    const gateScan = await seedBadgeScan(owner, {
      packageName: first,
      source: "workflow_gate",
    });
    await share(app, gateScan, { threatFeed: true });
    // Ensure a strictly later listing timestamp for a deterministic order.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const stagedScan = await seedBadgeScan(owner, { packageName: second });
    await share(app, stagedScan, { threatFeed: true });

    const feed = await fetchFeed(app);
    const gateIndex = feed.entries.findIndex((entry) => entry.package === first);
    const stagedIndex = feed.entries.findIndex((entry) => entry.package === second);
    expect(feed.entries[gateIndex]?.packageIdentity).toBe("manifest-claimed");
    expect(feed.entries[stagedIndex]?.packageIdentity).toBe("registry-verified");
    // Listed later → appears first.
    expect(stagedIndex).toBeLessThan(gateIndex);
  });

  test("published-pair reviews are listed as public-review under their own ecosystem", async () => {
    const owner = await seedUser();
    const app = publicApp(owner);
    const npmName = `feed-${crypto.randomUUID().slice(0, 8)}`;
    const pypiName = `feed-${crypto.randomUUID().slice(0, 8)}`;
    const npmScan = await seedBadgeScan(owner, { packageName: npmName, source: "published" });
    await share(app, npmScan, { threatFeed: true });
    const pypiScan = await seedBadgeScan(owner, {
      packageName: pypiName,
      source: "published",
      ecosystem: "pypi",
    });
    await share(app, pypiScan, { threatFeed: true });

    const feed = await fetchFeed(app);
    // Still listed: a review of an already-public release is the point of the
    // feed. The entry names the identity so a consumer can weigh it.
    expect(feed.entries.find((entry) => entry.package === npmName)).toMatchObject({
      packageIdentity: "public-review",
      ecosystem: "npm",
    });
    // A published PyPI review carries no provenance snapshot, and the npm
    // fallback that covers pre-provenance staged rows must not reach it — that
    // would file it under the npm badge key for the same name.
    expect(feed.entries.find((entry) => entry.package === pypiName)).toMatchObject({
      packageIdentity: "public-review",
      ecosystem: "pypi",
    });
    expect((await fetchBadge(app, "pypi", pypiName)).body.message).toBe("not reviewed");
    expect((await fetchBadge(app, "npm", pypiName)).body.message).toBe("not reviewed");
  });

  test("feed entries carry the dist-tag, null when the release was never staged under one", async () => {
    // The tag is the axis the badge is queried on, so a partner walking
    // feed → badge has to see the same value the badge filters by.
    const owner = await seedUser();
    const app = publicApp(owner);
    const tagged = `feed-${crypto.randomUUID().slice(0, 8)}`;
    const untagged = `feed-${crypto.randomUUID().slice(0, 8)}`;
    await share(app, await seedBadgeScan(owner, { packageName: tagged, tag: "beta" }), {
      threatFeed: true,
    });
    await share(app, await seedBadgeScan(owner, { packageName: untagged }), {
      threatFeed: true,
    });

    const feed = await fetchFeed(app);
    expect(feed.entries.find((entry) => entry.package === tagged)?.tag).toBe("beta");
    // Null, never "latest": nothing established a tag for this one.
    expect(feed.entries.find((entry) => entry.package === untagged)?.tag).toBeNull();
  });

  test("a null JSON body shares without touching the listing", async () => {
    const owner = await seedUser();
    const app = publicApp(owner);
    const scanId = await seedBadgeScan(owner, {
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
    const app = publicApp(owner);
    const packageName = `feed-${crypto.randomUUID().slice(0, 8)}`;
    const scanId = await seedBadgeScan(owner, { packageName });
    await share(app, scanId);

    const outsider = await seedUser();
    const res = await request(publicApp(outsider), `/api/v1/scans/${scanId}/share`, {
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
    const app = publicApp(owner);
    const packageName = `feed-${crypto.randomUUID().slice(0, 8)}`;
    const scanId = await seedBadgeScan(owner, { packageName });
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
    const app = publicApp(owner);
    const packageName = `feed-${crypto.randomUUID().slice(0, 8)}`;
    const scanId = await seedBadgeScan(owner, { packageName });
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
    const app = publicApp(owner);
    const packageNames = [] as string[];
    for (let i = 0; i < 3; i += 1) {
      const packageName = `page-${crypto.randomUUID().slice(0, 8)}`;
      packageNames.push(packageName);
      const scanId = await seedBadgeScan(owner, { packageName });
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

/**
 * A README badge is permanent and name-keyed, while listing is per scan. These
 * cover the two halves of keeping those consistent: the badge refusing to
 * vouch for a version the registry has already moved past, and the standing
 * grant that keeps it current without a manual step per release.
 */
async function markRegistryPublished(scanId: string, registryVersion: string): Promise<void> {
  const db = createDb(env.DB);
  await db
    .update(schema.scans)
    .set({
      registryVersionStatus: "published",
      registryVersionStatusAt: new Date(),
      // The badge names *this* string, never the manifest's version: only the
      // registry's answer is safe to render on an anonymous surface.
      registryVersion,
    })
    .where(eq(schema.scans.id, scanId));
}

// Seeded scans can land in the same millisecond, and "newer" is a strict
// comparison; pin the order rather than race the clock.
async function backdateScan(scanId: string, msAgo: number): Promise<void> {
  const db = createDb(env.DB);
  await db
    .update(schema.scans)
    .set({ completedAt: new Date(Date.now() - msAgo) })
    .where(eq(schema.scans.id, scanId));
}

async function decide(
  app: ReturnType<typeof buildTestApp>,
  scanId: string,
  decision: "publish" | "no_publish",
  // A user who is not the owner resolves their own personal organization
  // unless the request names one, the same as the dashboard's org switcher.
  organizationId?: string,
) {
  const res = await request(app, `/api/v1/scans/${scanId}/decision`, {
    method: "POST",
    body: JSON.stringify({ decision, reason: "reviewed" }),
    headers: organizationId ? { "x-organization-id": organizationId } : undefined,
  });
  expect(res.status).toBe(200);
  return res;
}

async function shareState(scanId: string) {
  const db = createDb(env.DB);
  const [row] = await db
    .select({
      token: schema.scans.publicShareToken,
      listedAt: schema.scans.publicFeedListedAt,
      includesFiles: schema.scans.publicShareIncludesFiles,
    })
    .from(schema.scans)
    .where(eq(schema.scans.id, scanId));
  return row;
}

async function seedApprovedListedRelease(
  owner: SeededUser,
  app: ReturnType<typeof buildTestApp>,
  packageName: string,
  version: string,
  options: { tag?: string } = {},
): Promise<string> {
  const scanId = await seedCompletedScan(owner, { packageName, version, ...options });
  await backdateScan(scanId, 60_000);
  await decide(app, scanId, "publish");
  await share(app, scanId, { threatFeed: true });
  return scanId;
}

describe("badge staleness", () => {
  test("a published release with no listed review takes the badge off the older one", async () => {
    const owner = await seedUser();
    const app = buildTestApp(owner);
    const packageName = `pkg-${crypto.randomUUID().slice(0, 8)}`;
    await seedApprovedListedRelease(owner, app, packageName, "3.0.0");
    expect((await fetchBadge(app, "npm", packageName)).body.message).toBe("3.0.0 approved");

    const newer = await seedCompletedScan(owner, { packageName, version: "3.0.1" });
    await markRegistryPublished(newer, "3.0.1");

    // The badge answers about the version a consumer would install, and says
    // only that nothing is listed for it — never the newer scan's decision.
    const badge = await fetchBadge(app, "npm", packageName);
    expect(badge.body).toMatchObject({
      label: "drydock",
      message: "3.0.1 not reviewed",
      color: "lightgrey",
    });
  });

  test("a newer release npm has not published never reaches the badge", async () => {
    const owner = await seedUser();
    const app = buildTestApp(owner);
    const packageName = `pkg-${crypto.randomUUID().slice(0, 8)}`;
    await seedApprovedListedRelease(owner, app, packageName, "3.0.0");

    // Staged but not published: the version number is not public yet, so the
    // badge must not disclose that a release is in flight.
    await seedCompletedScan(owner, { packageName, version: "3.0.1" });
    expect((await fetchBadge(app, "npm", packageName)).body.message).toBe("3.0.0 approved");
  });

  test("another organization's release cannot grey out a maintainer's badge", async () => {
    const owner = await seedUser();
    const app = buildTestApp(owner);
    const packageName = `pkg-${crypto.randomUUID().slice(0, 8)}`;
    await seedApprovedListedRelease(owner, app, packageName, "3.0.0");

    const stranger = await seedUser();
    const strangerScan = await seedCompletedScan(stranger, { packageName, version: "3.0.1" });
    await markRegistryPublished(strangerScan, "3.0.1");

    expect((await fetchBadge(app, "npm", packageName)).body.message).toBe("3.0.0 approved");
  });

  test("listing the newer release makes the badge current again", async () => {
    const owner = await seedUser();
    const app = buildTestApp(owner);
    const packageName = `pkg-${crypto.randomUUID().slice(0, 8)}`;
    await seedApprovedListedRelease(owner, app, packageName, "3.0.0");
    const newer = await seedCompletedScan(owner, { packageName, version: "3.0.1" });
    await markRegistryPublished(newer, "3.0.1");
    expect((await fetchBadge(app, "npm", packageName)).body.message).toBe("3.0.1 not reviewed");

    await decide(app, newer, "publish");
    await share(app, newer, { threatFeed: true });
    expect((await fetchBadge(app, "npm", packageName)).body.message).toBe("3.0.1 approved");
  });

  test("a release on another line leaves the default badge alone", async () => {
    const owner = await seedUser();
    const app = buildTestApp(owner);
    const packageName = `pkg-${crypto.randomUUID().slice(0, 8)}`;
    await seedApprovedListedRelease(owner, app, packageName, "3.0.0");

    const prerelease = await seedCompletedScan(owner, {
      packageName,
      version: "3.1.0-rc.1",
      tag: "beta",
      registryUrl: "https://registry.npmjs.org",
    });
    await markRegistryPublished(prerelease, "3.1.0-rc.1");

    expect((await fetchBadge(app, "npm", packageName)).body.message).toBe("3.0.0 approved");
  });
});

describe("the badge renders registry facts, not package bytes", () => {
  test("a manifest cannot put its own string on the badge", async () => {
    const owner = await seedUser();
    const app = buildTestApp(owner);
    const packageName = `pkg-${crypto.randomUUID().slice(0, 8)}`;
    await seedApprovedListedRelease(owner, app, packageName, "3.0.0");

    // `staged_version` is replaced with the inspected tarball's manifest after
    // a scan, so it is reviewed package bytes; npm's answer is what may be
    // rendered on an anonymous surface.
    const hostile = await seedCompletedScan(owner, {
      packageName,
      version: "99.0.0-CONTACT-attacker.example",
    });
    await markRegistryPublished(hostile, "3.0.1");

    expect((await fetchBadge(app, "npm", packageName)).body.message).toBe("3.0.1 not reviewed");
  });

  test("re-reviewing the quoted release does not take the badge off it", async () => {
    const owner = await seedUser();
    const app = buildTestApp(owner);
    const packageName = `pkg-${crypto.randomUUID().slice(0, 8)}`;
    await seedApprovedListedRelease(owner, app, packageName, "3.0.0");

    // A second review of 3.0.0 completes later than the listed one, but it is
    // not a newer release.
    const rereview = await seedCompletedScan(owner, { packageName, version: "3.0.0" });
    await markRegistryPublished(rereview, "3.0.0");
    expect((await fetchBadge(app, "npm", packageName)).body.message).toBe("3.0.0 approved");

    // Nor is a late review of an older one.
    const older = await seedCompletedScan(owner, { packageName, version: "2.9.0" });
    await markRegistryPublished(older, "2.9.0");
    expect((await fetchBadge(app, "npm", packageName)).body.message).toBe("3.0.0 approved");
  });
});

/**
 * Badges answer for an OSS package with no opt-in. These pin the three things
 * that make that safe — the maintainer's own credential, a public name, and a
 * release npm has actually served — and the two the maintainer never
 * consented to publish.
 */
async function seedPublicRelease(
  owner: SeededUser,
  packageName: string,
  version: string,
  options: { tag?: string; source?: "manual" | "workflow_gate" } = {},
): Promise<string> {
  const scanId = await seedCompletedScan(owner, {
    packageName,
    version,
    registryUrl: "https://registry.npmjs.org",
    ...options,
  });
  await markRegistryPublished(scanId, version);
  return scanId;
}

describe("an OSS package needs no opt-in", () => {
  test("an approved public release answers the badge unshared and unlisted", async () => {
    const owner = await seedUser();
    const app = buildTestApp(owner);
    const packageName = `pkg-${crypto.randomUUID().slice(0, 8)}`;
    const scanId = await seedPublicRelease(owner, packageName, "3.0.1");
    expect((await fetchBadge(app, "npm", packageName)).body.message).toBe("not reviewed");

    await decide(app, scanId, "publish");
    const badge = await fetchBadge(app, "npm", packageName);
    expect(badge.body).toMatchObject({
      label: "drydock",
      message: "3.0.1 approved",
      color: "brightgreen",
    });

    // Still no share link and no feed entry: the badge is a verdict, the
    // report is evidence, and only the second one took an opt-in.
    expect(await shareState(scanId)).toMatchObject({ token: null, listedAt: null });
    const feed = await fetchFeed(app);
    expect(feed.entries.some((entry) => entry.package === packageName)).toBe(false);
  });

  test("the queried release line answers on its own", async () => {
    const owner = await seedUser();
    const app = buildTestApp(owner);
    const packageName = `pkg-${crypto.randomUUID().slice(0, 8)}`;
    const stable = await seedPublicRelease(owner, packageName, "3.0.1");
    const beta = await seedPublicRelease(owner, packageName, "4.0.0-beta.1", { tag: "beta" });
    await decide(app, stable, "publish");
    await decide(app, beta, "publish");

    expect((await fetchBadge(app, "npm", packageName)).body.message).toBe("3.0.1 approved");
    const betaBadge = await fetchBadge(app, "npm", packageName, { tag: "beta" });
    expect(betaBadge.body).toMatchObject({
      label: "drydock (beta)",
      message: "4.0.0-beta.1 approved",
    });
  });

  test("a rejected or undecided release is simply absent", async () => {
    const owner = await seedUser();
    const app = buildTestApp(owner);
    const packageName = `pkg-${crypto.randomUUID().slice(0, 8)}`;
    const scanId = await seedPublicRelease(owner, packageName, "3.0.1");

    // Undecided: reviewed, but the organization has not acted on it.
    expect((await fetchBadge(app, "npm", packageName)).body.message).toBe("not reviewed");
    await decide(app, scanId, "no_publish");
    // Rejected: a verdict about their own release that nobody chose to publish.
    expect((await fetchBadge(app, "npm", packageName)).body.message).toBe("not reviewed");

    // Listing it is how a maintainer publishes that verdict deliberately.
    await share(app, scanId, { threatFeed: true });
    expect((await fetchBadge(app, "npm", packageName)).body.message).toBe("3.0.1 blocked");
  });

  test("a scoped package keeps the opt-in", async () => {
    const owner = await seedUser();
    const app = buildTestApp(owner);
    // npm only allows a private package under a scope, so a scoped name proves
    // nothing about publicness and must not answer by default.
    const packageName = `@acme/pkg-${crypto.randomUUID().slice(0, 8)}`;
    const scanId = await seedPublicRelease(owner, packageName, "3.0.1");
    await decide(app, scanId, "publish");
    expect((await fetchBadge(app, "npm", packageName)).body.message).toBe("not reviewed");

    await share(app, scanId, { threatFeed: true });
    expect((await fetchBadge(app, "npm", packageName)).body.message).toBe("3.0.1 approved");
  });

  test("a manifest claim cannot mint an approval for a name it does not own", async () => {
    const owner = await seedUser();
    const app = buildTestApp(owner);
    const packageName = `pkg-${crypto.randomUUID().slice(0, 8)}`;
    // A gate review only *claims* the name in a tarball manifest. Anyone can
    // build one, so it never answers without a deliberate listing.
    const scanId = await seedPublicRelease(owner, packageName, "3.0.1", {
      source: "workflow_gate",
    });
    await decide(app, scanId, "publish");
    expect((await fetchBadge(app, "npm", packageName)).body.message).toBe("not reviewed");
  });

  test("an approved release npm has not published yet stays quiet", async () => {
    const owner = await seedUser();
    const app = buildTestApp(owner);
    const packageName = `pkg-${crypto.randomUUID().slice(0, 8)}`;
    // Staged and approved, but npm has not served it. Announcing it here would
    // leak the version number and the timing of a release that has not shipped.
    const scanId = await seedCompletedScan(owner, {
      packageName,
      version: "3.0.1",
      registryUrl: "https://registry.npmjs.org",
    });
    await decide(app, scanId, "publish");
    expect((await fetchBadge(app, "npm", packageName)).body.message).toBe("not reviewed");

    await markRegistryPublished(scanId, "3.0.1");
    expect((await fetchBadge(app, "npm", packageName)).body.message).toBe("3.0.1 approved");
  });

  test("a mirror or private registry never qualifies", async () => {
    const owner = await seedUser();
    const app = buildTestApp(owner);
    const packageName = `pkg-${crypto.randomUUID().slice(0, 8)}`;
    const scanId = await seedCompletedScan(owner, {
      packageName,
      version: "3.0.1",
      registryUrl: "https://npm.internal.example.com",
    });
    await markRegistryPublished(scanId, "3.0.1");
    await decide(app, scanId, "publish");
    expect((await fetchBadge(app, "npm", packageName)).body.message).toBe("not reviewed");
  });

  test("a newer public release the badge cannot speak for still supersedes it", async () => {
    const owner = await seedUser();
    const app = buildTestApp(owner);
    const packageName = `pkg-${crypto.randomUUID().slice(0, 8)}`;
    const first = await seedPublicRelease(owner, packageName, "3.0.0");
    await backdateScan(first, 60_000);
    await decide(app, first, "publish");
    expect((await fetchBadge(app, "npm", packageName)).body.message).toBe("3.0.0 approved");

    // Published, reviewed, never approved — so it answers no badge itself, and
    // must not leave the older green one vouching for what people install.
    await seedPublicRelease(owner, packageName, "3.0.1");
    expect((await fetchBadge(app, "npm", packageName)).body.message).toBe("3.0.1 not reviewed");
  });
});

describe("release order decides the badge, not scan order", () => {
  test("a newer release that finished scanning first still wins", async () => {
    const owner = await seedUser();
    const app = buildTestApp(owner);
    const packageName = `pkg-${crypto.randomUUID().slice(0, 8)}`;

    // Two releases staged together; the 3.0.1 tarball happens to finish first.
    // Ordering candidates by completion would pin the badge to 3.0.0 forever,
    // and the staleness probe cannot catch it — a newer release that is itself
    // a candidate is not "a release the badge cannot speak for".
    const newer = await seedPublicRelease(owner, packageName, "3.0.1");
    await backdateScan(newer, 60_000);
    const older = await seedPublicRelease(owner, packageName, "3.0.0");
    await decide(app, newer, "publish");
    await decide(app, older, "publish");

    expect((await fetchBadge(app, "npm", packageName)).body.message).toBe("3.0.1 approved");
  });

  test("the badge names the registry's version, never the tarball manifest's", async () => {
    const owner = await seedUser();
    const app = buildTestApp(owner);
    const packageName = `pkg-${crypto.randomUUID().slice(0, 8)}`;
    const scanId = await seedCompletedScan(owner, {
      packageName,
      version: "99.0.0-CONTACT-attacker.example",
      registryUrl: "https://registry.npmjs.org",
    });
    await markRegistryPublished(scanId, "3.0.1");
    await decide(app, scanId, "publish");

    // The approved branch renders too — not only the superseded one.
    expect((await fetchBadge(app, "npm", packageName)).body.message).toBe("3.0.1 approved");
  });
});
