import { env } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";
import { createDb } from "../../server/db/client";
import {
  consumeAtpmOauthRequest,
  createAtpmOauthRequest,
  deleteAtpmPublisher,
  listActiveAtpmPublishers,
  listAtpmPublishers,
  listAtpmPublishersForDid,
  pruneExpiredAtpmOauthRequests,
  upsertAtpmPublisher,
} from "../../server/db/atpm-publishers";
import { ensurePersonalOrganization } from "../../server/db/organizations";
import * as schema from "../../server/db/schema";
import {
  decryptSecretValue,
  decryptSlackBotToken,
  encryptSecretValue,
} from "../../server/lib/platform/secret-box";

const PDS = "https://shiitake.us-east.host.bsky.network";

/**
 * A fresh account per test. The suite shares one D1, and several of these
 * assertions are about "who is watching this DID" — which only means anything
 * if a previous test's enrolment cannot answer it.
 */
function freshDid(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return `did:plc:${[...bytes].map((byte) => alphabet[byte % alphabet.length]).join("")}`;
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

describe("atpm publisher enrolment", () => {
  let organizationId: string;
  let userId: string;
  let DID: string;

  beforeEach(async () => {
    ({ organizationId, userId } = await seedOrganization());
    DID = freshDid();
  });

  function enrol(overrides: Partial<Parameters<typeof upsertAtpmPublisher>[1]> = {}) {
    return upsertAtpmPublisher(createDb(env.DB), {
      organizationId,
      did: DID,
      handle: "ebey.dev",
      pds: PDS,
      verificationMethod: "atproto_oauth",
      createdByUserId: userId,
      ...overrides,
    });
  }

  test("records a proof of control", async () => {
    const publisher = await enrol();
    expect(publisher).toMatchObject({
      organizationId,
      did: DID,
      handle: "ebey.dev",
      verificationMethod: "atproto_oauth",
      disabledAt: null,
    });
    expect(await listAtpmPublishers(createDb(env.DB), organizationId)).toHaveLength(1);
  });

  test("re-proving refreshes rather than duplicating", async () => {
    const first = await enrol();
    // A handle can move, and the proof is periodically re-established; neither
    // should produce a second row for the same account.
    const second = await enrol({ handle: "moved.example" });
    expect(second.id).toBe(first.id);
    expect(second.handle).toBe("moved.example");
    expect(second.verifiedAt.getTime()).toBeGreaterThanOrEqual(first.verifiedAt.getTime());
    expect(await listAtpmPublishers(createDb(env.DB), organizationId)).toHaveLength(1);
  });

  test("two organizations may each watch the same account", async () => {
    const other = await seedOrganization();
    await enrol();
    await upsertAtpmPublisher(createDb(env.DB), {
      organizationId: other.organizationId,
      did: DID,
      handle: "ebey.dev",
      pds: PDS,
      verificationMethod: "atproto_oauth",
      createdByUserId: other.userId,
    });
    // The firehose fans one event out to every organization that enrolled the
    // account, so this lookup has to return both.
    const watching = await listAtpmPublishersForDid(createDb(env.DB), DID);
    expect(watching.map((row) => row.organizationId).sort()).toEqual(
      [organizationId, other.organizationId].sort(),
    );
  });

  test("a removed enrolment stops being swept and stops being notified", async () => {
    const publisher = await enrol();
    await deleteAtpmPublisher(createDb(env.DB), organizationId, publisher.id);
    expect(await listAtpmPublishersForDid(createDb(env.DB), DID)).toEqual([]);
    expect(
      (await listActiveAtpmPublishers(createDb(env.DB))).filter(
        (row) => row.organizationId === organizationId,
      ),
    ).toEqual([]);
  });

  test("another organization cannot remove an enrolment it does not own", async () => {
    const publisher = await enrol();
    const other = await seedOrganization();
    expect(await deleteAtpmPublisher(createDb(env.DB), other.organizationId, publisher.id)).toBe(
      false,
    );
    expect(await listAtpmPublishers(createDb(env.DB), organizationId)).toHaveLength(1);
  });
});

describe("in-flight authorization requests", () => {
  let organizationId: string;
  let userId: string;
  let DID: string;

  beforeEach(async () => {
    ({ organizationId, userId } = await seedOrganization());
    DID = freshDid();
  });

  async function create(state: string, ttlMs = 60_000) {
    const sealed = await encryptSecretValue(env, JSON.stringify({ kty: "EC", d: "secret" }));
    await createAtpmOauthRequest(createDb(env.DB), {
      state,
      organizationId,
      createdByUserId: userId,
      did: DID,
      handle: "ebey.dev",
      pds: PDS,
      issuer: "https://bsky.social",
      tokenEndpoint: "https://bsky.social/oauth/token",
      pkceVerifier: "verifier",
      dpopKeyCiphertext: sealed.ciphertext,
      dpopKeyNonce: sealed.nonce,
      ttlMs,
    });
  }

  test("is consumed exactly once", async () => {
    await create("state-1");
    const first = await consumeAtpmOauthRequest(createDb(env.DB), "state-1");
    expect(first?.did).toBe(DID);
    // An authorization code is single-use, so a replay must find nothing to
    // exchange it against.
    expect(await consumeAtpmOauthRequest(createDb(env.DB), "state-1")).toBeNull();
  });

  test("an expired request is consumed but not honoured", async () => {
    await create("state-2", -1_000);
    expect(await consumeAtpmOauthRequest(createDb(env.DB), "state-2")).toBeNull();
  });

  test("the DPoP key round-trips and is not readable as another kind of secret", async () => {
    await create("state-3");
    const request = await consumeAtpmOauthRequest(createDb(env.DB), "state-3");
    const sealed = {
      ciphertext: request!.dpopKeyCiphertext,
      nonce: request!.dpopKeyNonce,
    };
    expect(JSON.parse(await decryptSecretValue(env, sealed))).toEqual({
      kty: "EC",
      d: "secret",
    });
    // Domain separation: the same stored bytes must not open under another
    // caller's key, or one compromised path would unseal all of them.
    await expect(decryptSlackBotToken(env, sealed)).rejects.toThrow();
  });

  test("abandoned requests are pruned", async () => {
    await create("state-4", -1_000);
    await create("state-5", 60_000);
    await pruneExpiredAtpmOauthRequests(createDb(env.DB));
    expect(await consumeAtpmOauthRequest(createDb(env.DB), "state-4")).toBeNull();
    expect(await consumeAtpmOauthRequest(createDb(env.DB), "state-5")).not.toBeNull();
  });
});
