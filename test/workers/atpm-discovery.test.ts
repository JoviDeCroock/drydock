import { env, createExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createDb } from "../../server/db/client";
import { ensurePersonalOrganization } from "../../server/db/organizations";
import { listScans } from "../../server/db/scans";
import * as schema from "../../server/db/schema";
import {
  discoverAtpmStagedCandidates,
  sweepAtpmPublishers,
} from "../../server/lib/ecosystems/atpm/staged-discovery";
import { UUID_NAMESPACE_URL, uuidV5 } from "../../server/lib/platform/uuid";
import worker from "../../server";

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

function stageRecord(
  rkey: string,
  version: string,
  recordCid = "bafyreih5wqzfvyjyw2djzp2zaqf2wmn3tjq4vg6nxbwjqz6c5xkxq6snqi",
) {
  return {
    uri: `at://${DID}/dev.atpm.alpha.stage/${rkey}`,
    cid: recordCid,
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

function approveId(rkey: string, recordCid: string): Promise<string> {
  return uuidV5(`at://${DID}/dev.atpm.alpha.stage/${rkey}/${recordCid}`, UUID_NAMESPACE_URL);
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

  test("creates one scan per pending candidate, bound to its record CID", async () => {
    const recordCid = "bafyreih5wqzfvyjyw2djzp2zaqf2wmn3tjq4vg6nxbwjqz6c5xkxq6snqi";
    const result = await sweep([
      stageRecord("3lmaaaaaaaaaa", "0.0.16"),
      stageRecord("3lmbbbbbbbbbb", "0.0.17"),
    ]);
    expect(result).toMatchObject({ found: 2, created: 2, skipped: 0, queued: true });

    const db = createDb(env.DB);
    const { scans } = await listScans(db, organizationId, { limit: 10 });
    const firstApproveId = await approveId("3lmaaaaaaaaaa", recordCid);
    const secondApproveId = await approveId("3lmbbbbbbbbbb", recordCid);
    expect(scans.map((scan) => scan.stageId).sort()).toEqual([
      `atpm:${DID}:3lmaaaaaaaaaa:${firstApproveId}`,
      `atpm:${DID}:3lmbbbbbbbbbb:${secondApproveId}`,
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

  test("processes a fanned-out publisher lookup through the queue consumer", async () => {
    stubPublisher([stageRecord("3lmaaaaaaaaaa", "0.0.16")]);
    const retry = vi.fn();
    const batch = {
      messages: [
        {
          body: {
            kind: "atpm_discovery",
            organizationId,
            actorUserId: userId,
            publisherRef: "@ebey.dev",
            source: "auto_discovery",
          },
          attempts: 1,
          retry,
        },
      ],
    } as unknown as MessageBatch<import("../../server/lib/scan/job").QueueMessage>;

    await worker.queue(batch, queueEnv as unknown as Cloudflare.Env, createExecutionContext());
    expect(retry).not.toHaveBeenCalled();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ ecosystem: "atpm" });
  });

  test("reviews a record rewritten under the same key as a new candidate", async () => {
    const rkey = "3lmaaaaaaaaaa";
    const firstCid = "bafyreih5wqzfvyjyw2djzp2zaqf2wmn3tjq4vg6nxbwjqz6c5xkxq6snqi";
    const secondCid = "bafyreig7wqzfvyjyw2djzp2zaqf2wmn3tjq4vg6nxbwjqz6c5xkxq6snqa";
    await sweep([stageRecord(rkey, "0.0.16", firstCid)]);
    const second = await sweep([stageRecord(rkey, "0.0.17", secondCid)]);
    expect(second).toMatchObject({ found: 1, created: 1, skipped: 0 });

    const db = createDb(env.DB);
    const { scans } = await listScans(db, organizationId, { limit: 10 });
    expect(new Set(scans.map((scan) => scan.stageId))).toEqual(
      new Set([
        `atpm:${DID}:${rkey}:${await approveId(rkey, firstCid)}`,
        `atpm:${DID}:${rkey}:${await approveId(rkey, secondCid)}`,
      ]),
    );
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

  test("enforces the organization's shared scan quota across discovery sweeps", async () => {
    const digits = "234567";
    const records = Array.from({ length: 10 }, (_, index) =>
      stageRecord(
        `3lmaaaaaaaa${digits[Math.floor(index / 6)]}${digits[index % 6]}`,
        `0.0.${index}`,
      ),
    );
    expect(await sweep(records)).toMatchObject({ found: 10, created: 10, skipped: 0 });

    expect(await sweep([stageRecord("3lmzzzzzzzzzz", "0.1.0")])).toMatchObject({
      found: 1,
      created: 0,
      skipped: 1,
    });
    expect(queued).toHaveLength(10);
  });

  test("skips a publisher reference that is not addressable", async () => {
    const result = await sweep([stageRecord("3lmaaaaaaaaaa", "0.0.16")], "not a handle");
    expect(result).toEqual({ found: 0, created: 0, skipped: 0, queued: false });
  });

  test("reviews nothing when the repository has no pending candidates", async () => {
    expect(await sweep([])).toEqual({ found: 0, created: 0, skipped: 0, queued: false });
  });

  test("fans publisher discovery out in bounded queue batches and deduplicates targets", async () => {
    const batches: unknown[][] = [];
    const targets = Array.from({ length: 205 }, (_, index) => ({
      organizationId: `org_${index}`,
      actorUserId: `user_${index}`,
      publisherRef: index === 0 ? " @ebey.dev " : "@ebey.dev",
    }));
    targets.push({ organizationId: "org_0", actorUserId: "other", publisherRef: "@ebey.dev" });
    const result = await sweepAtpmPublishers({
      db: createDb(env.DB),
      env: {
        ...env,
        SCAN_QUEUE: { sendBatch: async (messages: unknown[]) => void batches.push(messages) },
      } as unknown as Cloudflare.Env,
      executionCtx: createExecutionContext(),
      targets,
      source: "auto_discovery",
    });

    expect(result).toEqual({ publishers: 205, created: 0, dispatched: 205 });
    expect(batches.map((batch) => batch.length)).toEqual([100, 100, 5]);
    expect(batches.flat()[0]).toMatchObject({
      body: {
        kind: "atpm_discovery",
        organizationId: "org_0",
        publisherRef: "@ebey.dev",
      },
      contentType: "json",
    });
  });
});
