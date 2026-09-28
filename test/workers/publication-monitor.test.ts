import { createDb } from "../../server/db/client";
import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createPublicationWatch,
  deletePublicationWatch,
  getPublicationWatch,
  listPublicationObservations,
} from "../../server/db/publication-watches";
import {
  npmPackageClaims,
  publicationAlerts,
  publicationObservations,
  publicationWatches,
  scans,
} from "../../server/db/schema";
import {
  checkNpmPublicationWatch,
  sweepNpmPublicationWatches,
} from "../../server/lib/ecosystems/npm/publication-monitor";
import type { ReviewEvidence } from "../../server/lib/ecosystems/npm/publication-verdict";
import { createHash } from "node:crypto";
import { seedUser } from "./helpers/seed";
import { seedLegacyScanJob } from "./helpers/seed-scan-job";

const name = "@drydock/publication-test";
const version = "1.0.0";
const bytes = new TextEncoder().encode("inert artifact bytes; never execute");
const sha1 = createHash("sha1").update(bytes).digest("hex");
const sha256 = createHash("sha256").update(bytes).digest("hex");
const published = new Date("2026-09-12T12:00:00Z");
// Past the tarball hashing cap (256 MiB), declared by content-length only.
const OVER_TARBALL_CAP = 300 * 1024 * 1024;
function review(overrides: Partial<ReviewEvidence> = {}): ReviewEvidence {
  return {
    id: "scan1",
    source: "auto_discovery",
    registryUrl: "https://registry.npmjs.org",
    registryPackageName: name,
    registryVersion: version,
    registryStatusSupersededAt: null,
    stagedDeclaredSha1: null,
    packageName: name,
    stagedVersion: version,
    decision: "publish",
    decidedAt: new Date(published.getTime() - 1000),
    status: "complete",
    summaryJson: {
      stagedPublish: {
        artifactIntegrity: {
          algorithm: "sha1",
          status: "verified",
          declared: sha1,
          computed: sha1,
        },
      },
    },
    ...overrides,
  };
}
async function seed() {
  const { db, organizationId, userId } = await seedUser({ name: "Watcher" });
  const watch = await createPublicationWatch(db, organizationId, name);
  return { db, organizationId, userId, watch };
}
/** Staged reviews make an organization a competing (or former) package manager. */
async function seedStagedHistory(
  db: Awaited<ReturnType<typeof seed>>["db"],
  organizationId: string,
  userId: string,
) {
  await seedLegacyScanJob(db, {
    id: crypto.randomUUID(),
    stageId: crypto.randomUUID(),
    organizationId,
    ownerUserId: userId,
    source: "auto_discovery",
    packageName: name,
    stagedVersion: "0.9.0",
    registryUrl: "https://registry.npmjs.org",
  });
}
afterEach(() => vi.restoreAllMocks());

describe("public package monitoring", () => {
  test("decides direct releases without a scan without downloading them and preserves observation on network failures", async () => {
    const { db, organizationId, watch } = await seed();
    const timestamp = new Date(watch.createdAt.getTime() + 1).toISOString();
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      expect(init?.redirect).toBe("manual");
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      return String(input).endsWith(".tgz")
        ? new Response(bytes)
        : Response.json({
            name,
            versions: {
              [version]: {
                name,
                version,
                dist: {
                  tarball:
                    "https://registry.npmjs.org/@drydock/publication-test/-/publication-test-1.0.0.tgz",
                  shasum: "f".repeat(40),
                },
              },
            },
            time: { [version]: timestamp },
          });
    });
    await checkNpmPublicationWatch(db, env, watch);
    const [observation] = await listPublicationObservations(db, organizationId, watch.id);
    expect(observation).toMatchObject({
      status: "published_without_approval",
      sha1: null,
      sha256: null,
      scanId: null,
    });
    // A release with no Drydock record needs no bytes: only metadata is read.
    expect(fetcher).toHaveBeenCalledTimes(1);
    await db
      .update(publicationWatches)
      .set({ lastCheckedAt: new Date(0) })
      .where(eq(publicationWatches.id, watch.id));
    fetcher.mockRejectedValue(new Error("private raw network error"));
    await checkNpmPublicationWatch(db, env, watch);
    expect((await listPublicationObservations(db, organizationId, watch.id))[0]).toEqual(
      observation,
    );
    expect((await getPublicationWatch(db, organizationId, watch.id))?.lastError).toBe(
      "registry_evidence_unavailable",
    );
  });
  test("missing times remain unknown; old releases excluded; malicious tarball origin never fetched", async () => {
    const { db, organizationId, watch } = await seed();
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        name,
        versions: {
          "0.1.0": {},
          "1.0.0": {},
          "2.0.0": {
            name,
            version: "2.0.0",
            dist: { tarball: "https://evil.example/package/-/package.tgz" },
          },
        },
        time: { "0.1.0": "2020-01-01T00:00:00Z", "2.0.0": watch.createdAt.toISOString() },
      }),
    );
    await checkNpmPublicationWatch(db, env, watch);
    const observations = await listPublicationObservations(db, organizationId, watch.id);
    expect(
      Object.fromEntries(observations.map((row) => [row.version, [row.status, row.reason]])),
    ).toEqual({
      "1.0.0": ["unknown", "publication_time_unavailable"],
      "2.0.0": ["published_without_approval", null],
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  test("organization ownership, duplicate enrollment, and cascade deletion", async () => {
    const { db, organizationId, watch } = await seed();
    expect((await createPublicationWatch(db, organizationId, name)).id).toBe(watch.id);
    expect(await getPublicationWatch(db, "other-org", watch.id)).toBeNull();
    expect(await deletePublicationWatch(db, "other-org", watch.id)).toBe(false);
    expect(await listPublicationObservations(db, "other-org", watch.id)).toEqual([]);
    expect(await deletePublicationWatch(db, organizationId, watch.id)).toBe(true);
  });
  test("other organizations cannot contribute approval evidence", async () => {
    const { db, organizationId, watch } = await seed();
    const other = await seed();
    await db.insert(scans).values({
      ...review(),
      id: crypto.randomUUID(),
      stageId: "other-stage",
      organizationId: other.organizationId,
      decidedAt: new Date(watch.createdAt.getTime() - 1000),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
      String(input).endsWith(".tgz")
        ? new Response(bytes)
        : Response.json({
            name,
            versions: {
              [version]: {
                name,
                version,
                dist: { tarball: "https://registry.npmjs.org/pkg/-/pkg.tgz" },
              },
            },
            time: { [version]: watch.createdAt.toISOString() },
          }),
    );
    await checkNpmPublicationWatch(db, env, watch);
    expect((await listPublicationObservations(db, organizationId, watch.id))[0]?.status).toBe(
      "published_without_approval",
    );
  });
});

test.each(["publish", "no_publish"] as const)(
  "persisted complete staged review produces the correct %s publication outcome",
  async (decision) => {
    const { db, organizationId, watch } = await seed();
    await db.insert(scans).values({
      ...review(),
      id: crypto.randomUUID(),
      stageId: "known-stage",
      organizationId,
      decision,
      decidedAt: new Date(watch.createdAt.getTime() - 1),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
      String(input).endsWith(".tgz")
        ? new Response(bytes)
        : Response.json({
            name,
            versions: {
              [version]: {
                name,
                version,
                dist: { tarball: "https://registry.npmjs.org/pkg/-/pkg.tgz" },
              },
            },
            time: { [version]: watch.createdAt.toISOString() },
          }),
    );
    await checkNpmPublicationWatch(db, env, watch);
    expect((await listPublicationObservations(db, organizationId, watch.id))[0]?.status).toBe(
      decision === "publish" ? "approved_match" : "published_despite_rejection",
    );
  },
);

function registryMetadata(watch: { createdAt: Date }, releases: readonly string[]) {
  return {
    name,
    versions: Object.fromEntries(
      releases.map((release) => [
        release,
        {
          name,
          version: release,
          dist: { tarball: `https://registry.npmjs.org/pkg/-/pkg-${release}.tgz` },
        },
      ]),
    ),
    time: Object.fromEntries(releases.map((release) => [release, watch.createdAt.toISOString()])),
  };
}

function isTarball(input: RequestInfo | URL) {
  return String(input).endsWith(".tgz");
}

async function insertReview(
  db: Awaited<ReturnType<typeof seed>>["db"],
  organizationId: string,
  overrides: Partial<typeof scans.$inferInsert> = {},
) {
  await db.insert(scans).values({
    ...review(),
    id: crypto.randomUUID(),
    stageId: `stage-${crypto.randomUUID()}`,
    organizationId,
    decidedAt: new Date(0),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });
}

async function releaseLease(db: Awaited<ReturnType<typeof seed>>["db"], watchId: string) {
  await db
    .update(publicationWatches)
    .set({ lastCheckedAt: new Date(0) })
    .where(eq(publicationWatches.id, watchId));
}

test("bounded batches drain reviewed versions three downloads at a time", async () => {
  const { db, organizationId, watch } = await seed();
  const releases = ["1.0.0", "2.0.0", "3.0.0", "4.0.0"];
  for (const release of releases) {
    await insertReview(db, organizationId, {
      stagedVersion: release,
      registryVersion: release,
    });
  }
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input) =>
      isTarball(input) ? new Response(bytes) : Response.json(registryMetadata(watch, releases)),
    );
  await checkNpmPublicationWatch(db, env, watch);
  expect(await listPublicationObservations(db, organizationId, watch.id)).toHaveLength(3);
  expect((await getPublicationWatch(db, organizationId, watch.id))?.lastError).toBe(
    "pending_release_backlog",
  );
  await releaseLease(db, watch.id);
  await checkNpmPublicationWatch(db, env, watch);
  const observations = await listPublicationObservations(db, organizationId, watch.id);
  expect(observations.map((row) => row.status)).toEqual(Array(4).fill("approved_match"));
  expect(fetcher.mock.calls.filter(([input]) => isTarball(input))).toHaveLength(4);
  expect(fetcher).toHaveBeenCalledTimes(6);
  expect((await getPublicationWatch(db, organizationId, watch.id))?.lastError).toBeNull();
});

test("releases without a Drydock record drain in bounded batches with no downloads", async () => {
  const { db, organizationId, watch } = await seed();
  const releases = Array.from({ length: 8 }, (_, index) => `${index + 1}.0.0`);
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => Response.json(registryMetadata(watch, releases)));
  await checkNpmPublicationWatch(db, env, watch);
  expect(await listPublicationObservations(db, organizationId, watch.id)).toHaveLength(6);
  expect((await getPublicationWatch(db, organizationId, watch.id))?.lastError).toBe(
    "pending_release_backlog",
  );
  await releaseLease(db, watch.id);
  await checkNpmPublicationWatch(db, env, watch);
  const observations = await listPublicationObservations(db, organizationId, watch.id);
  expect(observations).toHaveLength(8);
  expect(fetcher).toHaveBeenCalledTimes(2);
  // Each release records the version it follows, so it can open its diff.
  expect(
    Object.fromEntries(observations.map((row) => [row.version, row.previousVersion])),
  ).toMatchObject({ "1.0.0": null, "2.0.0": "1.0.0", "8.0.0": "7.0.0" });
});

test("records which dist-tags point at each release and keeps settled ones current", async () => {
  const { db, organizationId, watch } = await seed();
  const releases = ["1.0.0", "2.0.0-rc.0"];
  let distTags: Record<string, unknown> = {
    latest: "1.0.0",
    next: "2.0.0-rc.0",
    "bad tag": "1.0.0",
  };
  vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    Response.json({ ...registryMetadata(watch, releases), "dist-tags": distTags }),
  );
  const tags = async () =>
    Object.fromEntries(
      (await listPublicationObservations(db, organizationId, watch.id)).map((row) => [
        row.version,
        row.distTags,
      ]),
    );
  await checkNpmPublicationWatch(db, env, watch);
  // Malformed tag names from the packument are dropped, not stored.
  expect(await tags()).toEqual({ "1.0.0": ["latest"], "2.0.0-rc.0": ["next"] });

  // The prerelease takes `latest`; both observations are settled verdicts,
  // and their tags still follow the registry.
  distTags = { latest: "2.0.0-rc.0", next: "2.0.0-rc.0", legacy: "1.0.0" };
  await releaseLease(db, watch.id);
  await checkNpmPublicationWatch(db, env, watch);
  expect(await tags()).toEqual({ "1.0.0": ["legacy"], "2.0.0-rc.0": ["latest", "next"] });

  distTags = { latest: "2.0.0-rc.0" };
  await releaseLease(db, watch.id);
  await checkNpmPublicationWatch(db, env, watch);
  expect(await tags()).toEqual({ "1.0.0": [], "2.0.0-rc.0": ["latest"] });
});

test("an oversized tarball of a reviewed release stays unknown, says why, and is not refetched", async () => {
  const { db, organizationId, watch } = await seed();
  await insertReview(db, organizationId);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
    isTarball(input)
      ? new Response(new Uint8Array(8), {
          headers: { "content-length": String(OVER_TARBALL_CAP) },
        })
      : Response.json(registryMetadata(watch, [version])),
  );
  await checkNpmPublicationWatch(db, env, watch);
  expect(await listPublicationObservations(db, organizationId, watch.id)).toMatchObject([
    { status: "unknown", reason: "artifact_too_large", sha1: null },
  ]);
  expect((await getPublicationWatch(db, organizationId, watch.id))?.lastError).toBe(
    "artifact_too_large",
  );
  expect(warn).toHaveBeenCalledWith(
    "npm.publication_monitor.artifact_unavailable",
    expect.objectContaining({ organizationId, reason: "artifact_too_large" }),
  );
  await releaseLease(db, watch.id);
  await checkNpmPublicationWatch(db, env, watch);
  expect(fetcher.mock.calls.filter(([input]) => isTarball(input))).toHaveLength(1);
  expect((await getPublicationWatch(db, organizationId, watch.id))?.lastError).toBeNull();
});

test("a pending review of the published bytes, known by npm's stage shasum, alerts and points at the review", async () => {
  const { db, organizationId, watch } = await seed();
  await insertReview(db, organizationId, {
    status: "pending",
    decision: null,
    decidedAt: null,
    summaryJson: null,
    stagedDeclaredSha1: sha1,
  });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
    isTarball(input) ? new Response(bytes) : Response.json(registryMetadata(watch, [version])),
  );
  await checkNpmPublicationWatch(db, env, watch);
  // Staging the bytes and publishing them directly must not read as the
  // owner's own release in flight: npm cannot say it was promoted from a stage.
  const [observation] = await listPublicationObservations(db, organizationId, watch.id);
  expect(observation).toMatchObject({
    status: "published_without_approval",
    reason: "review_pending",
    sha1,
  });
  expect(observation?.scanId).toEqual(expect.any(String));
});

test("rejecting the published bytes after publication raises the rejection alert", async () => {
  const { db, organizationId, watch } = await seed();
  await insertReview(db, organizationId, {
    decision: "no_publish",
    decidedAt: new Date(watch.createdAt.getTime() + 60_000),
  });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
    isTarball(input) ? new Response(bytes) : Response.json(registryMetadata(watch, [version])),
  );
  await checkNpmPublicationWatch(db, env, watch);
  expect(await listPublicationObservations(db, organizationId, watch.id)).toMatchObject([
    { status: "published_despite_rejection", reason: "rejected_after_publication" },
  ]);
});

test("a padded tarball whose npm shasum matches no review raises the alert without hashing", async () => {
  const { db, organizationId, watch } = await seed();
  await insertReview(db, organizationId);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const metadata = registryMetadata(watch, [version]);
  const padded = {
    ...metadata,
    versions: {
      [version]: {
        ...(metadata.versions[version] as Record<string, unknown>),
        dist: {
          tarball: `https://registry.npmjs.org/pkg/-/pkg-${version}.tgz`,
          shasum: "e".repeat(40),
        },
      },
    },
  };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
    isTarball(input)
      ? new Response(new Uint8Array(8), {
          headers: { "content-length": String(OVER_TARBALL_CAP) },
        })
      : Response.json(padded),
  );
  await checkNpmPublicationWatch(db, env, watch);
  expect(await listPublicationObservations(db, organizationId, watch.id)).toMatchObject([
    { status: "artifact_mismatch", sha1: null },
  ]);
});

test("a padded tarball cannot hide a release no one reviewed", async () => {
  const { db, organizationId, watch } = await seed();
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
    isTarball(input)
      ? new Response(new Uint8Array(8), {
          headers: { "content-length": String(OVER_TARBALL_CAP) },
        })
      : Response.json(registryMetadata(watch, [version])),
  );
  await checkNpmPublicationWatch(db, env, watch);
  expect(await listPublicationObservations(db, organizationId, watch.id)).toMatchObject([
    { status: "published_without_approval" },
  ]);
  expect(fetcher.mock.calls.filter(([input]) => isTarball(input))).toHaveLength(0);
});

test("settled unknown releases are re-evaluated from stored digests, not a new download", async () => {
  const { db, organizationId, watch } = await seed();
  // Approved only after publication: a settled unknown.
  await insertReview(db, organizationId, { decidedAt: new Date(Date.now() + 1000) });
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input) =>
      isTarball(input) ? new Response(bytes) : Response.json(registryMetadata(watch, [version])),
    );
  await checkNpmPublicationWatch(db, env, watch);
  const [first] = await listPublicationObservations(db, organizationId, watch.id);
  expect(first).toMatchObject({
    status: "unknown",
    reason: "decision_history_unavailable",
    sha1,
    sha256,
  });
  // Within the settled cadence the release is not re-examined at all.
  await releaseLease(db, watch.id);
  await checkNpmPublicationWatch(db, env, watch);
  expect((await listPublicationObservations(db, organizationId, watch.id))[0]?.checkedAt).toEqual(
    first?.checkedAt,
  );
  // Once due, it is re-evaluated from the digests already stored.
  await db
    .update(publicationObservations)
    .set({ checkedAt: new Date(Date.now() - 25 * 60 * 60 * 1000) })
    .where(eq(publicationObservations.watchId, watch.id));
  await releaseLease(db, watch.id);
  await checkNpmPublicationWatch(db, env, watch);
  const [again] = await listPublicationObservations(db, organizationId, watch.id);
  expect(again).toMatchObject({ reason: "decision_history_unavailable", sha1, sha256 });
  expect(again?.checkedAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
  expect(fetcher.mock.calls.filter(([input]) => isTarball(input))).toHaveLength(1);
});

test("a reviewed release whose tarball leaves the registry origin is never fetched", async () => {
  const { db, organizationId, watch } = await seed();
  await insertReview(db, organizationId);
  const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({
      name,
      versions: {
        [version]: { name, version, dist: { tarball: "https://evil.example/package/-/p.tgz" } },
      },
      time: { [version]: watch.createdAt.toISOString() },
    }),
  );
  await checkNpmPublicationWatch(db, env, watch);
  expect(await listPublicationObservations(db, organizationId, watch.id)).toMatchObject([
    { status: "unknown", reason: "artifact_identity_invalid" },
  ]);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test("oversized anonymous metadata cannot create a successful coverage claim", async () => {
  const { db, organizationId, watch } = await seed();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response("{}", { headers: { "content-length": String(65 * 1024 * 1024) } }),
  );
  await checkNpmPublicationWatch(db, env, watch);
  expect(await listPublicationObservations(db, organizationId, watch.id)).toEqual([]);
  // Distinct from a transient outage: it becomes a coverage gap on the watch.
  expect(await getPublicationWatch(db, organizationId, watch.id)).toMatchObject({
    lastError: "registry_metadata_too_large",
    coverageGap: "registry_metadata_too_large",
    coverageGapSince: expect.any(Date),
  });
});

test("a check reads as unfinished until its outcome is recorded", async () => {
  const { db, organizationId, watch } = await seed();
  let midCheck: { lastCheckedAt: Date | null; lastError: string | null } | undefined;
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    midCheck = await getPublicationWatch(db, organizationId, watch.id);
    return Response.json(registryMetadata(watch, []));
  });
  await checkNpmPublicationWatch(db, env, watch);
  expect(midCheck).toMatchObject({
    lastCheckedAt: expect.any(Date),
    lastError: "check_in_progress",
  });
  expect((await getPublicationWatch(db, organizationId, watch.id))?.lastError).toBeNull();
});

test("a large packument streams into what the verdict reads", async () => {
  const { db, organizationId, watch } = await seed();
  // Well past the old 4 MiB buffered cap, mostly fields the monitor never keeps.
  const noise = "x".repeat(1024 * 1024);
  const metadata = {
    ...registryMetadata(watch, [version]),
    readme: noise.repeat(6),
    "dist-tags": { latest: version },
  };
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json(metadata));
  await checkNpmPublicationWatch(db, env, watch);
  expect(await listPublicationObservations(db, organizationId, watch.id)).toMatchObject([
    { version, status: "published_without_approval", distTags: ["latest"] },
  ]);
  expect(await getPublicationWatch(db, organizationId, watch.id)).toMatchObject({
    lastError: null,
    coverageGap: null,
    distTagsCheckedAt: expect.any(Date),
  });
});

test("organization enrollment is capped at twenty and duplicate enrollment remains idempotent", async () => {
  const { db, organizationId, watch } = await seed();
  for (let i = 0; i < 19; i++) await createPublicationWatch(db, organizationId, `package-${i}`);
  await expect(createPublicationWatch(db, organizationId, "package-over-limit")).rejects.toThrow(
    "At most 20",
  );
  expect((await createPublicationWatch(db, organizationId, name)).id).toBe(watch.id);
});

test("streaming metadata cap applies without content-length and cancels the stream", async () => {
  const { db, organizationId, watch } = await seed();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const cancel = vi.fn();
  let sent = 0;
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      new ReadableStream({
        // Leading whitespace is valid JSON, so only the byte cap can stop it.
        pull(controller) {
          sent++;
          controller.enqueue(new Uint8Array(1024 * 1024).fill(0x20));
        },
        cancel,
      }),
    ),
  );
  await checkNpmPublicationWatch(db, env, watch);
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(sent).toBeLessThanOrEqual(66);
  expect(await listPublicationObservations(db, organizationId, watch.id)).toEqual([]);
  expect((await getPublicationWatch(db, organizationId, watch.id))?.lastError).toBe(
    "registry_metadata_too_large",
  );
});

test("malformed metadata is unavailable evidence, a gap only once it persists", async () => {
  const { db, organizationId, watch } = await seed();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(`{"name":${JSON.stringify(name)},`));
  await checkNpmPublicationWatch(db, env, watch);
  const current = await getPublicationWatch(db, organizationId, watch.id);
  expect(current).toMatchObject({
    lastError: "registry_evidence_unavailable",
    coverageGap: "registry_evidence_unavailable",
    coverageGapNotifiedAt: null,
  });
  // Recorded from now: it is reported only if no read succeeds for an hour.
  expect(current!.coverageGapSince!.getTime()).toBeGreaterThan(Date.now() - 60_000);
});

test("Workers Request accepts the fetch contract and registry redirects remain unknown", async () => {
  const { db, organizationId, watch } = await seed();
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    expect(request.redirect).toBe("manual");
    expect(request.headers.has("authorization")).toBe(false);
    return new Response("", { status: 302, headers: { location: "https://evil.example/package" } });
  });
  await checkNpmPublicationWatch(db, env, watch);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect((await getPublicationWatch(db, organizationId, watch.id))?.lastError).toBe(
    "registry_evidence_unavailable",
  );
  expect(await listPublicationObservations(db, organizationId, watch.id)).toEqual([]);
});

function gateSummary(digests: { sha256: string; sha1?: string }) {
  return {
    stagedPublish: {
      mode: "workflow_gate",
      digest: digests.sha256,
      ...(digests.sha1 ? { sha1: digests.sha1 } : {}),
      manifest: {
        schema: "drydock.release-artifacts.v1",
        ecosystem: "npm",
        package: name,
        version,
        artifacts: [{ path: "package.tgz", sha256: digests.sha256 }],
      },
    },
  };
}

function paddedRelease(watch: { createdAt: Date }, shasum: string) {
  const metadata = registryMetadata(watch, [version]);
  return {
    ...metadata,
    versions: {
      [version]: {
        ...(metadata.versions[version] as Record<string, unknown>),
        dist: { tarball: `https://registry.npmjs.org/pkg/-/pkg-${version}.tgz`, shasum },
      },
    },
  };
}

test("a gate review's recorded SHA-1 exposes a padded tarball that differs from it", async () => {
  const { db, organizationId, watch } = await seed();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await insertReview(db, organizationId, {
    source: "workflow_gate",
    registryUrl: null,
    registryPackageName: null,
    registryVersion: null,
    summaryJson: gateSummary({ sha256, sha1 }),
  });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
    isTarball(input)
      ? new Response(new Uint8Array(8), {
          headers: { "content-length": String(OVER_TARBALL_CAP) },
        })
      : Response.json(paddedRelease(watch, "e".repeat(40))),
  );
  await checkNpmPublicationWatch(db, env, watch);
  expect(await listPublicationObservations(db, organizationId, watch.id)).toMatchObject([
    { status: "artifact_mismatch", sha1: null },
  ]);
});

test("a legacy gate review with only SHA-256 and a padded tarball stays unknown with nothing vouching", async () => {
  const { db, organizationId, watch } = await seed();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await insertReview(db, organizationId, {
    source: "workflow_gate",
    registryUrl: null,
    registryPackageName: null,
    registryVersion: null,
    summaryJson: gateSummary({ sha256 }),
  });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
    isTarball(input)
      ? new Response(new Uint8Array(8), {
          headers: { "content-length": String(OVER_TARBALL_CAP) },
        })
      : Response.json(paddedRelease(watch, "e".repeat(40))),
  );
  await checkNpmPublicationWatch(db, env, watch);
  // Not settled silently: nothing vouches (no scan id), so after the gap
  // threshold it is reported as a coverage gap (see publication-alerts tests).
  const [observation] = await listPublicationObservations(db, organizationId, watch.id);
  expect(observation).toMatchObject({
    status: "unknown",
    reason: "artifact_too_large",
    scanId: null,
    coverageGap: false,
  });
  await db
    .update(publicationObservations)
    .set({ firstSeenAt: new Date(Date.now() - 2 * 60 * 60 * 1000) })
    .where(eq(publicationObservations.watchId, watch.id));
  expect((await listPublicationObservations(db, organizationId, watch.id))[0]).toMatchObject({
    coverageGap: true,
  });
  expect((await getPublicationWatch(db, organizationId, watch.id))?.unverifiedReleaseCount).toBe(1);
});

test("more than a hundred records of a version cannot settle it without a byte match", async () => {
  const { db, organizationId, watch } = await seed();
  // A flood of gate runs of other bytes (someone with CI access can push past
  // the history limit cheaply), then a direct publish of different bytes.
  for (let index = 0; index < 101; index++) {
    await insertReview(db, organizationId, {
      source: "workflow_gate",
      registryUrl: null,
      registryPackageName: null,
      registryVersion: null,
      decision: null,
      decidedAt: null,
      summaryJson: gateSummary({ sha256: index.toString(16).padStart(64, "0") }),
      createdAt: new Date(Date.now() - index * 1000),
    });
  }
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
    isTarball(input) ? new Response(bytes) : Response.json(registryMetadata(watch, [version])),
  );
  await checkNpmPublicationWatch(db, env, watch);
  expect(await listPublicationObservations(db, organizationId, watch.id)).toMatchObject([
    { status: "published_without_approval", reason: "review_history_limit" },
  ]);
});

test("published-pair reviews do not count toward the history limit, and a match among the newest decides", async () => {
  const { db, organizationId, watch } = await seed();
  for (let index = 0; index < 101; index++) {
    await insertReview(db, organizationId, {
      source: "published",
      decision: null,
      decidedAt: null,
      createdAt: new Date(Date.now() - index * 1000),
    });
  }
  // The owner's approved review, older than every published-pair review.
  await insertReview(db, organizationId, { createdAt: new Date(0) });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
    isTarball(input) ? new Response(bytes) : Response.json(registryMetadata(watch, [version])),
  );
  await checkNpmPublicationWatch(db, env, watch);
  expect(await listPublicationObservations(db, organizationId, watch.id)).toMatchObject([
    { status: "approved_match", reason: null },
  ]);
});

test("dist-tags past the read limit are recorded as unknown, not as absent", async () => {
  const { db, organizationId, watch } = await seed();
  const distTags = Object.fromEntries(
    Array.from({ length: 1001 }, (_, index) => [`tag-${index}`, "0.0.1"]),
  );
  vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    Response.json({
      ...registryMetadata(watch, [version]),
      "dist-tags": { latest: version, ...distTags },
    }),
  );
  await checkNpmPublicationWatch(db, env, watch);
  expect(await listPublicationObservations(db, organizationId, watch.id)).toMatchObject([
    { version, distTags: null },
  ]);
  expect((await getPublicationWatch(db, organizationId, watch.id))?.distTagsCheckedAt).toEqual(
    expect.any(Date),
  );
});

test("a version string up to npm's 256 characters is observed, and an unreadable one is a gap", async () => {
  const { db, organizationId, watch } = await seed();
  const long = `1.0.1-${"a".repeat(200)}`;
  const releases = [long, "not a version"];
  vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    Response.json({ ...registryMetadata(watch, releases), "dist-tags": { latest: long } }),
  );
  await checkNpmPublicationWatch(db, env, watch);
  expect(await listPublicationObservations(db, organizationId, watch.id)).toMatchObject([
    { version: long, status: "published_without_approval", distTags: ["latest"] },
  ]);
  expect(await getPublicationWatch(db, organizationId, watch.id)).toMatchObject({
    lastError: "invalid_version_metadata",
    coverageGap: "invalid_version_metadata",
  });
});

test("a deeply nested field in one release cannot blind the monitor to the package", async () => {
  const { db, organizationId, watch } = await seed();
  const releases = ["1.0.0", "2.0.0"];
  const metadata = registryMetadata(watch, releases);
  const depth = 5_000;
  const hostile = `${"[".repeat(depth)}${"]".repeat(depth)}`;
  const body = JSON.stringify(metadata).replace(
    '"version":"1.0.0",',
    `"version":"1.0.0","custom":${hostile},`,
  );
  expect(body).toContain('"custom":[[[');
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(body));
  await checkNpmPublicationWatch(db, env, watch);
  const observations = await listPublicationObservations(db, organizationId, watch.id);
  expect(observations.map((row) => [row.version, row.status]).sort()).toEqual([
    ["1.0.0", "published_without_approval"],
    ["2.0.0", "published_without_approval"],
  ]);
  expect((await getPublicationWatch(db, organizationId, watch.id))?.lastError).toBeNull();
});

test("a flood of undecided records cannot push a decision out of view", async () => {
  const { db, organizationId, watch } = await seed();
  // The owner's approval of the published bytes, created before a flood of
  // newer undecided gate runs of other bytes.
  await insertReview(db, organizationId, { createdAt: new Date(0) });
  for (let index = 0; index < 101; index++) {
    await insertReview(db, organizationId, {
      source: "workflow_gate",
      registryUrl: null,
      registryPackageName: null,
      registryVersion: null,
      decision: null,
      decidedAt: null,
      summaryJson: gateSummary({ sha256: index.toString(16).padStart(64, "0") }),
      createdAt: new Date(Date.now() - index * 1000),
    });
  }
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
    isTarball(input) ? new Response(bytes) : Response.json(registryMetadata(watch, [version])),
  );
  await checkNpmPublicationWatch(db, env, watch);
  expect(await listPublicationObservations(db, organizationId, watch.id)).toMatchObject([
    { status: "approved_match" },
  ]);
});

test("once a sweep's byte budget is spent, no tarball download starts", async () => {
  const { db, organizationId, watch } = await seed();
  await insertReview(db, organizationId);
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input) =>
      isTarball(input) ? new Response(bytes) : Response.json(registryMetadata(watch, [version])),
    );
  await checkNpmPublicationWatch(db, env, watch, { meter: { bytes: 1024 * 1024 * 1024 } });
  expect(fetcher.mock.calls.filter(([input]) => isTarball(input))).toHaveLength(0);
  expect(await listPublicationObservations(db, organizationId, watch.id)).toEqual([]);
  expect((await getPublicationWatch(db, organizationId, watch.id))?.lastError).toBe(
    "pending_release_backlog",
  );
});

test("another organization's claim never silences a watcher without staged history", async () => {
  await createDb(env.DB).delete(npmPackageClaims).where(eq(npmPackageClaims.packageName, name));
  const { db, organizationId, watch } = await seed();
  const owner = await seed();
  await db.insert(npmPackageClaims).values({
    registryUrl: "https://registry.npmjs.org",
    ecosystem: "npm",
    packageName: name,
    organizationId: owner.organizationId,
    firstStageId: "stage-claim",
    claimedAt: new Date(),
    managementConfirmedAt: new Date(),
  });
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => new Response("{}", { status: 200 }));
  await checkNpmPublicationWatch(db, env, watch);
  expect(fetcher).toHaveBeenCalled();
  expect(await getPublicationWatch(db, organizationId, watch.id)).toMatchObject({
    ownershipConflict: false,
    lastCheckedAt: expect.any(Date),
  });
  await db
    .update(npmPackageClaims)
    .set({ organizationId: null })
    .where(eq(npmPackageClaims.packageName, name));
  expect(await getPublicationWatch(db, organizationId, watch.id)).toMatchObject({
    ownershipConflict: false,
  });
});

test("foreign and orphaned claims stop a competing manager's scheduled and direct polling without deleting watches", async () => {
  await createDb(env.DB).delete(npmPackageClaims).where(eq(npmPackageClaims.packageName, name));
  const { db, organizationId, userId, watch } = await seed();
  await seedStagedHistory(db, organizationId, userId);
  const owner = await seed();
  await db.insert(npmPackageClaims).values({
    registryUrl: "https://registry.npmjs.org",
    ecosystem: "npm",
    packageName: name,
    organizationId: owner.organizationId,
    firstStageId: "stage-claim",
    claimedAt: new Date(),
    managementConfirmedAt: new Date(),
  });
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => new Response("{}", { status: 200 }));
  await checkNpmPublicationWatch(db, env, watch);
  expect(fetcher).not.toHaveBeenCalled();
  expect(await getPublicationWatch(db, organizationId, watch.id)).toMatchObject({
    ownershipConflict: true,
    lastCheckedAt: null,
  });
  await db
    .update(npmPackageClaims)
    .set({ organizationId: null })
    .where(eq(npmPackageClaims.packageName, name));
  await sweepNpmPublicationWatches(db, env);
  expect(await getPublicationWatch(db, organizationId, watch.id)).toMatchObject({
    ownershipConflict: true,
    lastCheckedAt: null,
  });
});

test("a claim acquired during registry fetching prevents a competing manager's observation and alert persistence", async () => {
  await createDb(env.DB).delete(npmPackageClaims).where(eq(npmPackageClaims.packageName, name));
  const { db, organizationId, userId, watch } = await seed();
  await seedStagedHistory(db, organizationId, userId);
  const owner = await seed();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (!String(input).endsWith(".tgz")) {
      await db.insert(npmPackageClaims).values({
        registryUrl: "https://registry.npmjs.org",
        ecosystem: "npm",
        packageName: name,
        organizationId: owner.organizationId,
        firstStageId: "race-stage",
        claimedAt: new Date(),
        managementConfirmedAt: new Date(),
      });
    }
    if (String(input).endsWith(".tgz")) return new Response(bytes);
    return Response.json({
      name,
      versions: {
        [version]: {
          name,
          version,
          dist: {
            tarball:
              "https://registry.npmjs.org/@drydock/publication-test/-/publication-test-1.0.0.tgz",
          },
        },
      },
      time: { [version]: watch.createdAt.toISOString() },
    });
  });
  await checkNpmPublicationWatch(db, env, watch);
  expect(await listPublicationObservations(db, organizationId, watch.id)).toEqual([]);
  expect(
    await db
      .select()
      .from(publicationAlerts)
      .where(eq(publicationAlerts.organizationId, organizationId)),
  ).toEqual([]);
  expect(await getPublicationWatch(db, organizationId, watch.id)).toMatchObject({
    ownershipConflict: true,
  });
});

test("a provisional personal claim prevents direct and scheduled polling without removing the watch", async () => {
  await createDb(env.DB).delete(npmPackageClaims).where(eq(npmPackageClaims.packageName, name));
  const { db, organizationId, watch } = await seed();
  await db.insert(npmPackageClaims).values({
    registryUrl: "https://registry.npmjs.org",
    ecosystem: "npm",
    packageName: name,
    organizationId,
    firstStageId: "pending-personal-stage",
    claimedAt: new Date(),
    managementConfirmedAt: null,
  });
  const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({}));
  await checkNpmPublicationWatch(db, env, watch);
  expect(fetcher).not.toHaveBeenCalled();
  await sweepNpmPublicationWatches(db, env);
  expect(await listPublicationObservations(db, organizationId, watch.id)).toEqual([]);
  expect(
    await db
      .select()
      .from(publicationAlerts)
      .where(eq(publicationAlerts.organizationId, organizationId)),
  ).toEqual([]);
  expect(await getPublicationWatch(db, organizationId, watch.id)).toMatchObject({
    managementPending: true,
    ownershipConflict: false,
    lastCheckedAt: null,
  });
});

test("a same-organization provisional claim acquired during fetch prevents observation and alert persistence", async () => {
  await createDb(env.DB).delete(npmPackageClaims).where(eq(npmPackageClaims.packageName, name));
  const { db, organizationId, watch } = await seed();
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    await db.insert(npmPackageClaims).values({
      registryUrl: "https://registry.npmjs.org",
      ecosystem: "npm",
      packageName: name,
      organizationId,
      firstStageId: "inflight-personal-stage",
      claimedAt: new Date(),
      managementConfirmedAt: null,
    });
    return Response.json(registryMetadata(watch, [version]));
  });
  await checkNpmPublicationWatch(db, env, watch);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(await listPublicationObservations(db, organizationId, watch.id)).toEqual([]);
  expect(
    await db
      .select()
      .from(publicationAlerts)
      .where(eq(publicationAlerts.organizationId, organizationId)),
  ).toEqual([]);
  expect(await getPublicationWatch(db, organizationId, watch.id)).toMatchObject({
    managementPending: true,
    ownershipConflict: false,
    distTagsCheckedAt: null,
  });
});
