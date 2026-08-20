import { env, createExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createDb } from "../../server/db/client";
import { ensurePersonalOrganization } from "../../server/db/organizations";
import { listScans } from "../../server/db/scans";
import * as schema from "../../server/db/schema";
import { discoverAtpmStagedCandidates } from "../../server/lib/ecosystems/atpm/staged-discovery";

const DID = "did:plc:twegdcgytckr5cxm57gyruxa";
const PDS = "https://shiitake.us-east.host.bsky.network";
const CID = "bafkreibrz4xmz6sbraw6h2mtchh5xq7jqghrjhr3yyyub3wbyrvmyjg2bm";

/**
 * The publisher's whole resolution chain, answered from memory: a DNS-over-HTTPS
 * handle claim, the PLC directory's DID document, and the PDS listing. Stubbing
 * at `fetch` rather than at a module boundary keeps the host policy, the
 * bidirectional handle check, and the record validation all in the path under
 * test — a discovery sweep that skipped any of those would be reviewing
 * candidates it has no business trusting.
 */
function stubPublisher(records: unknown[]) {
  vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("https://cloudflare-dns.com/dns-query")) {
      return Promise.resolve(Response.json({ Answer: [{ type: 16, data: `"did=${DID}"` }] }));
    }
    if (url.startsWith(`https://plc.directory/${encodeURIComponent(DID)}`)) {
      return Promise.resolve(
        Response.json({
          id: DID,
          alsoKnownAs: ["at://ebey.dev"],
          service: [
            { id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: PDS },
          ],
        }),
      );
    }
    if (url.startsWith(`${PDS}/xrpc/com.atproto.repo.listRecords`)) {
      return Promise.resolve(Response.json({ records }));
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  });
}

function stageRecord(rkey: string, version: string) {
  return {
    uri: `at://${DID}/dev.atpm.alpha.stage/${rkey}`,
    cid: "bafyreih5wqzfvyjyw2djzp2zaqf2wmn3tjq4vg6nxbwjqz6c5xkxq6snqi",
    value: {
      $type: "dev.atpm.alpha.stage",
      createdAt: "2026-08-13T06:28:24.000Z",
      name: "@ebey.dev/counter",
      version,
      tags: { latest: version },
      blob: { $type: "blob", ref: { $link: CID }, size: 604, mimeType: "application/gzip" },
      meta: {
        name: "@ebey.dev/counter",
        version,
        dist: { tarball: `${PDS}/xrpc/com.atproto.sync.getBlob?did=${DID}&cid=${CID}` },
      },
    },
  };
}

async function seedOrganization(): Promise<{ organizationId: string; userId: string }> {
  const db = createDb(env.DB);
  const now = new Date();
  const userId = `user_${crypto.randomUUID()}`;
  await db.insert(schema.user).values({
    id: userId,
    name: "atpm tester",
    email: `${userId}@example.com`,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  return { organizationId: await ensurePersonalOrganization(db, { userId }), userId };
}

describe("atpm staged discovery", () => {
  let organizationId: string;
  let userId: string;

  beforeEach(async () => {
    ({ organizationId, userId } = await seedOrganization());
    queued.length = 0;
  });

  afterEach(() => vi.unstubAllGlobals());

  // Discovery's job ends at "queued". Handing it a queue keeps the pipeline out
  // of this suite entirely — without one it falls back to running each scan
  // inline, and the assertions would then be about the sandbox rather than
  // about which candidates were found.
  const queued: unknown[] = [];
  const queueEnv = { ...env, SCAN_QUEUE: { send: async (m: unknown) => void queued.push(m) } };

  async function sweep(records: unknown[], publisherRef = "@ebey.dev") {
    stubPublisher(records);
    const db = createDb(env.DB);
    return discoverAtpmStagedCandidates({
      db,
      env: queueEnv as unknown as Cloudflare.Env,
      executionCtx: createExecutionContext(),
      organizationId,
      actorUserId: userId,
      publisherRef,
      source: "auto_discovery",
    });
  }

  test("creates one scan per pending candidate, addressed by its record key", async () => {
    const result = await sweep([
      stageRecord("3lmaaaaaaaaaa", "0.0.16"),
      stageRecord("3lmbbbbbbbbbb", "0.0.17"),
    ]);
    expect(result).toMatchObject({ found: 2, created: 2, skipped: 0, queued: true });

    const db = createDb(env.DB);
    const { scans } = await listScans(db, organizationId, { limit: 10 });
    expect(scans.map((scan) => scan.stageId).sort()).toEqual([
      `atpm:${DID}:3lmaaaaaaaaaa`,
      `atpm:${DID}:3lmbbbbbbbbbb`,
    ]);
    expect(scans[0].packageName).toBe("@ebey.dev/counter");
    // The queue message carries the ecosystem, so the job resolves the atpm
    // adapter rather than defaulting to npm.
    expect(queued).toHaveLength(2);
    expect(queued[0]).toMatchObject({ ecosystem: "atpm" });
  });

  test("does not review the same candidate twice", async () => {
    await sweep([stageRecord("3lmaaaaaaaaaa", "0.0.16")]);
    const second = await sweep([stageRecord("3lmaaaaaaaaaa", "0.0.16")]);
    expect(second).toMatchObject({ found: 1, created: 0, skipped: 1 });
  });

  test("bounds how much of a repository one sweep can pull in", async () => {
    // TIDs are base32-sortable: digits 0, 1, 8, and 9 are outside the
    // alphabet, so the keys are spelled from it rather than from a counter.
    const digits = "234567";
    const many = Array.from({ length: 25 }, (_, index) =>
      stageRecord(
        `3lmaaaaaaaa${digits[Math.floor(index / 6)]}${digits[index % 6]}`,
        `0.0.${index}`,
      ),
    );
    const result = await sweep(many);
    expect(result.found).toBe(10);
    expect(result.created).toBe(10);
  });

  test("skips a publisher reference that is not addressable", async () => {
    const result = await sweep([stageRecord("3lmaaaaaaaaaa", "0.0.16")], "not a handle");
    expect(result).toEqual({ found: 0, created: 0, skipped: 0, queued: false });
  });

  test("reviews nothing when the repository has no pending candidates", async () => {
    expect(await sweep([])).toEqual({ found: 0, created: 0, skipped: 0, queued: false });
  });
});
