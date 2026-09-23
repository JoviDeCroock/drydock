/**
 * Seeding for the post-release review suites: a registry-verified publisher's
 * staged release, the monitor's alert on a published release, a completed
 * published-pair review of it, and the link the Scan action writes.
 */
import { env } from "cloudflare:test";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { expect } from "vitest";
import { createDb } from "../../../server/db/client";
import { savePublicationObservation } from "../../../server/db/publication-alerts";
import { createPublicationWatch } from "../../../server/db/publication-watches";
import * as schema from "../../../server/db/schema";
import { publicFeedCacheKey } from "../../../server/lib/public-feed";
import { npmPublicationWatchRoutes } from "../../../server/routes/npm-publication-watches";
import { packagesRoutes } from "../../../server/routes/packages";
import { publicReportsRoutes } from "../../../server/routes/public-reports";
import { scansRoutes } from "../../../server/routes/scans";
import { buildTestApp, call, type TestApp } from "./app";
import { type SeededUser, seedCompletedScan } from "./seed";

export const PUBLIC_NPM = "https://registry.npmjs.org";
export const publishedBytes = new TextEncoder().encode("the bytes npm published; inert, never run");
export const PUBLISHED = {
  sha1: createHash("sha1").update(publishedBytes).digest("hex"),
  sha256: createHash("sha256").update(publishedBytes).digest("hex"),
};
export const OTHER = { sha1: "e".repeat(40), sha256: "e".repeat(64) };
// The digest a seeded staged review verified its (staged) bytes against.
const STAGED_SHA1 = "a".repeat(40);

export const appFor = (session: { userId: string } | null) =>
  buildTestApp(
    (app) => {
      app.route("/public", publicReportsRoutes);
      if (session) {
        app.route("/api/v1/scans", scansRoutes);
        app.route("/api/v1/publication-watches", npmPublicationWatchRoutes);
        app.route("/api/v1/packages", packagesRoutes);
      }
    },
    session,
    { authPath: "/api/*" },
  );

export const newPackage = () => `pkg-${crypto.randomUUID().slice(0, 8)}`;

// A staged review that makes its organization a registry-verified publisher:
// npm let the organization's token read a public-npm stage of this exact name.
// Approved and published, it answers the badge by default.
export async function seedStagedRelease(
  owner: SeededUser,
  app: TestApp,
  packageName: string,
  version: string,
  options: { decision?: "publish" | "no_publish" | null; tag?: string } = {},
) {
  const scanId = await seedCompletedScan(owner, {
    job: { source: "manual", packageName, stagedVersion: version, registryUrl: PUBLIC_NPM },
    jobColumns: { registryPackageName: packageName, registryUrl: PUBLIC_NPM },
    packageJson: { name: packageName, version },
    summary: {
      report: { version: 1, digest: "abc123", digestAlgorithm: "sha256" },
      stagedPublish: {
        access: "public",
        ...(options.tag ? { tag: options.tag } : {}),
        artifactIntegrity: {
          algorithm: "sha1",
          status: "verified",
          declared: STAGED_SHA1,
          computed: STAGED_SHA1,
        },
      },
    },
    files: [],
    diff: [],
  });
  await createDb(env.DB)
    .update(schema.scans)
    .set({ registryVersionStatus: "published", registryVersionStatusAt: new Date() })
    .where(eq(schema.scans.id, scanId));
  const decision = options.decision === undefined ? "publish" : options.decision;
  if (decision) await decide(app, scanId, decision, owner.organizationId);
  return scanId;
}

// What the monitor records for a release npm served that the organization's
// reviews do not vouch for: the observation, and its alert.
export async function seedAlert(
  owner: SeededUser,
  packageName: string,
  version: string,
  options: {
    status?: "published_without_approval" | "artifact_mismatch";
    digests?: { sha1: string | null; sha256: string | null };
    previousVersion?: string | null;
    distTags?: string[] | null;
  } = {},
) {
  const db = createDb(env.DB);
  const watch = await createPublicationWatch(db, owner.organizationId, packageName);
  const observationId = crypto.randomUUID();
  const now = new Date();
  await savePublicationObservation(
    db,
    {
      id: observationId,
      watchId: watch.id,
      organizationId: owner.organizationId,
      version,
      publishedAt: now,
      firstSeenAt: now,
      checkedAt: now,
      status: options.status ?? "published_without_approval",
      reason: null,
      sha1: options.digests === undefined ? PUBLISHED.sha1 : options.digests.sha1,
      sha256: options.digests === undefined ? PUBLISHED.sha256 : options.digests.sha256,
      scanId: null,
      previousVersion: options.previousVersion === undefined ? "1.0.0" : options.previousVersion,
      distTags: options.distTags === undefined ? ["latest"] : options.distTags,
    },
    packageName,
  );
  return { watchId: watch.id, observationId };
}

// A completed published-pair review of the release, as the pipeline persists
// it: the registry it read and the digests of the tarball it reviewed.
export async function seedPublishedReview(
  owner: SeededUser,
  packageName: string,
  version: string,
  options: { digests?: { sha1: string | null; sha256: string | null }; registryUrl?: string } = {},
) {
  return seedCompletedScan(owner, {
    job: { source: "published", packageName, stagedVersion: version, registryUrl: null },
    packageJson: { name: packageName, version },
    summary: {
      report: { version: 1, digest: "abc123", digestAlgorithm: "sha256" },
      stagedPublish: {
        mode: "published_pair",
        ecosystem: "npm",
        packageName,
        version,
        baselineVersion: "1.0.0",
        registryUrl: options.registryUrl ?? PUBLIC_NPM,
        notices: [],
        artifactDigest: options.digests ?? PUBLISHED,
      },
    },
    files: [],
    diff: [],
  });
}

// The link the Scan action writes; seeded directly so a completed review can
// be decided without running the pipeline.
export async function linkReview(
  owner: SeededUser,
  packageName: string,
  version: string,
  scanId: string,
) {
  await createDb(env.DB)
    .update(schema.publicationAlerts)
    .set({ reviewScanId: scanId, reviewRequestedAt: new Date(), reviewRequestedBy: owner.userId })
    .where(
      and(
        eq(schema.publicationAlerts.organizationId, owner.organizationId),
        eq(schema.publicationAlerts.packageName, packageName),
        eq(schema.publicationAlerts.version, version),
      ),
    );
}

export async function decide(
  app: TestApp,
  scanId: string,
  decision: "publish" | "no_publish",
  organizationId?: string,
) {
  const res = await call(app, "POST", `/api/v1/scans/${scanId}/decision`, {
    body: { decision, reason: "read the diff" },
    activeOrganizationId: organizationId,
  });
  expect(res.status).toBe(200);
  return res.json<{ postRelease: Record<string, unknown> | null }>();
}

export async function alertRow(organizationId: string, packageName: string, version: string) {
  const [row] = await createDb(env.DB)
    .select()
    .from(schema.publicationAlerts)
    .where(
      and(
        eq(schema.publicationAlerts.organizationId, organizationId),
        eq(schema.publicationAlerts.packageName, packageName),
        eq(schema.publicationAlerts.version, version),
      ),
    );
  return row;
}

const CANONICAL_TEST_ORIGIN = new URL(env.BETTER_AUTH_URL as string).origin;

export async function fetchBadge(app: TestApp, packageName: string, tag?: string) {
  const search = tag === undefined ? "" : `?tag=${encodeURIComponent(tag)}`;
  const cache = (caches as unknown as { default: Cache }).default;
  await cache.delete(
    publicFeedCacheKey(CANONICAL_TEST_ORIGIN, `/badge/npm/${packageName}`, search),
  );
  const res = await call(app, "GET", `/public/badge/npm/${packageName}${search}`);
  expect(res.status).toBe(200);
  return res.json<{ label: string; message: string; color: string }>();
}

// npm, as the published-pair resolver and the monitor's collector read it.
