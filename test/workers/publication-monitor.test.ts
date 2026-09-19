import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createDb } from "../../server/db/client";
import {
  createPublicationWatch,
  deletePublicationWatch,
  getPublicationWatch,
  listPublicationObservations,
} from "../../server/db/publication-watches";
import { publicationWatches, scans, user } from "../../server/db/schema";
import { ensurePersonalOrganization } from "../../server/db/organizations";
import {
  checkNpmPublicationWatch,
  classifyPublication,
} from "../../server/lib/ecosystems/npm/publication-monitor";
import { createHash } from "node:crypto";

const name = "@drydock/publication-test";
const version = "1.0.0";
const bytes = new TextEncoder().encode("inert artifact bytes; never execute");
const sha1 = createHash("sha1").update(bytes).digest("hex");
const sha256 = createHash("sha256").update(bytes).digest("hex");
const published = new Date("2026-09-12T12:00:00Z");
function review(overrides = {}) {
  return {
    id: "scan1",
    source: "auto_discovery",
    registryUrl: "https://registry.npmjs.org",
    registryPackageName: name,
    registryVersion: version,
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
  const db = createDb(env.DB);
  const id = crypto.randomUUID();
  const now = new Date();
  await db
    .insert(user)
    .values({ id, name: "Watcher", email: `${id}@example.com`, createdAt: now, updatedAt: now });
  const organizationId = await ensurePersonalOrganization(db, { userId: id });
  const watch = await createPublicationWatch(db, organizationId, name);
  return { db, organizationId, watch };
}
afterEach(() => vi.restoreAllMocks());

describe("publication evidence", () => {
  test("binds staged evidence to digest, registry coordinates and prior decision", () => {
    const classify = (reviews: ReturnType<typeof review>[]) =>
      classifyPublication(name, version, published, { sha1, sha256 }, reviews).status;
    expect(classify([review()])).toBe("approved_match");
    expect(classify([review({ decision: "no_publish" })])).toBe("published_despite_rejection");
    expect(classify([review({ decidedAt: published })])).toBe("unknown");
    expect(classify([review({ decidedAt: new Date(published.getTime() + 1000) })])).toBe("unknown");
    expect(classify([review({ registryUrl: "https://private.example" })])).toBe(
      "published_without_approval",
    );
    expect(classify([review({ registryPackageName: "different" })])).toBe(
      "published_without_approval",
    );
    expect(
      classifyPublication(name, version, published, { sha1: "b".repeat(40), sha256 }, [review()])
        .status,
    ).toBe("artifact_mismatch");
    expect(classify([review({ summaryJson: {} })])).toBe("unknown");
    expect(classifyPublication(name, version, null, { sha1, sha256 }, [review()]).status).toBe(
      "unknown",
    );
  });
  test("verifies workflow manifest identity and actual single artifact digest", () => {
    const gate = review({
      source: "workflow_gate",
      registryUrl: null,
      summaryJson: {
        stagedPublish: {
          mode: "workflow_gate",
          digest: sha256,
          manifest: {
            schema: "drydock.release-artifacts.v1",
            ecosystem: "npm",
            package: name,
            version,
            artifacts: [{ path: "package.tgz", sha256 }],
          },
        },
      },
    });
    expect(classifyPublication(name, version, published, { sha1, sha256 }, [gate]).status).toBe(
      "approved_match",
    );
    expect(classifyPublication("other", version, published, { sha1, sha256 }, [gate]).status).toBe(
      "published_without_approval",
    );
  });
});

describe("public package monitoring", () => {
  test("discovers direct releases without a scan, hashes fetched bytes and preserves observation on network failures", async () => {
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
      sha1,
      sha256,
      scanId: null,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
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
    expect(observations).toHaveLength(2);
    expect(observations.every((row) => row.status === "unknown")).toBe(true);
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

test.each(["publish", "no_publish"])(
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

test("bounded batches drain new versions and do not refetch resolved releases", async () => {
  const { db, organizationId, watch } = await seed();
  const versions = Object.fromEntries(
    ["1.0.0", "2.0.0", "3.0.0", "4.0.0"].map((version) => [
      version,
      { name, version, dist: { tarball: `https://registry.npmjs.org/pkg/-/pkg-${version}.tgz` } },
    ]),
  );
  const time = Object.fromEntries(
    Object.keys(versions).map((version) => [version, watch.createdAt.toISOString()]),
  );
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input) =>
      String(input).endsWith(".tgz")
        ? new Response(bytes)
        : Response.json({ name, versions, time }),
    );
  await checkNpmPublicationWatch(db, env, watch);
  expect(await listPublicationObservations(db, organizationId, watch.id)).toHaveLength(3);
  expect((await getPublicationWatch(db, organizationId, watch.id))?.lastError).toBe(
    "pending_release_backlog",
  );
  await db
    .update(publicationWatches)
    .set({ lastCheckedAt: new Date(0) })
    .where(eq(publicationWatches.id, watch.id));
  await checkNpmPublicationWatch(db, env, watch);
  expect(await listPublicationObservations(db, organizationId, watch.id)).toHaveLength(4);
  expect(fetcher).toHaveBeenCalledTimes(6);
  expect((await getPublicationWatch(db, organizationId, watch.id))?.lastError).toBeNull();
});

test("oversized anonymous metadata cannot create a successful coverage claim", async () => {
  const { db, organizationId, watch } = await seed();
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response("{}", { headers: { "content-length": String(5 * 1024 * 1024) } }),
  );
  await checkNpmPublicationWatch(db, env, watch);
  expect(await listPublicationObservations(db, organizationId, watch.id)).toEqual([]);
  expect((await getPublicationWatch(db, organizationId, watch.id))?.lastError).toBe(
    "registry_evidence_unavailable",
  );
});

test("a decision overwritten after publication leaves its earlier history unknown", () => {
  const overwritten = review({ decidedAt: new Date(published.getTime() + 1000) });
  expect(
    classifyPublication(name, version, published, { sha1, sha256 }, [overwritten]),
  ).toMatchObject({ status: "unknown", reason: "decision_history_unavailable" });
  expect(
    classifyPublication(name, version, published, { sha1, sha256 }, [overwritten, review()]).status,
  ).toBe("approved_match");
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
  const cancel = vi.fn();
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1));
        },
        cancel,
      }),
    ),
  );
  await checkNpmPublicationWatch(db, env, watch);
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(await listPublicationObservations(db, organizationId, watch.id)).toEqual([]);
  expect((await getPublicationWatch(db, organizationId, watch.id))?.lastError).toBe(
    "registry_evidence_unavailable",
  );
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
