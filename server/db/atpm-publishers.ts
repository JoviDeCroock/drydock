import { and, eq, isNull, lt } from "drizzle-orm";
import { type AppDb } from "./client";
import { atpmOauthRequests, atpmPublishers } from "./schema";

/**
 * Persistence for atpm publisher enrolment.
 *
 * A row here says "this organization proved control of this DID". It grants
 * nothing: reading a publisher's records needs no permission, and Drydock never
 * writes to one. What it decides is whose releases appear in whose dashboard
 * and where notifications go — so it is scoped, revocable, and unique per
 * organization + DID, but it is not a credential store.
 */

export interface AtpmPublisherRecord {
  id: string;
  organizationId: string;
  did: string;
  handle: string | null;
  pds: string;
  verificationMethod: string;
  verifiedAt: Date;
  disabledAt: Date | null;
  lastSweptAt: Date | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface AtpmPublisherRow {
  id: string;
  organizationId: string;
  did: string;
  handle: string | null;
  pds: string;
  verificationMethod: string;
  verifiedAt: Date | string | number;
  disabledAt: Date | string | number | null;
  lastSweptAt: Date | string | number | null;
  createdByUserId: string | null;
  createdAt: Date | string | number;
  updatedAt: Date | string | number;
}

function readPublisherRow(row: AtpmPublisherRow): AtpmPublisherRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    did: row.did,
    handle: row.handle,
    pds: row.pds,
    verificationMethod: row.verificationMethod,
    verifiedAt: new Date(row.verifiedAt),
    disabledAt: row.disabledAt === null ? null : new Date(row.disabledAt),
    lastSweptAt: row.lastSweptAt === null ? null : new Date(row.lastSweptAt),
    createdByUserId: row.createdByUserId,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
}

export interface UpsertAtpmPublisherInput {
  organizationId: string;
  did: string;
  handle: string | null;
  pds: string;
  verificationMethod: string;
  createdByUserId: string | null;
}

/**
 * Record a proof of control, or refresh one.
 *
 * Re-enrolling an account that is already present is a re-proof rather than a
 * duplicate: it moves `verified_at` forward, refreshes the handle and PDS as
 * they are now, and clears a previous opt-out. That makes "prove it again" the
 * remedy for an expired or revoked enrolment without needing a separate verb.
 */
export async function upsertAtpmPublisher(
  db: AppDb,
  input: UpsertAtpmPublisherInput,
): Promise<AtpmPublisherRecord> {
  const now = new Date();
  const existing = await getAtpmPublisherByDid(db, input.organizationId, input.did);
  if (existing) {
    await db
      .update(atpmPublishers)
      .set({
        handle: input.handle,
        pds: input.pds,
        verificationMethod: input.verificationMethod,
        verifiedAt: now,
        disabledAt: null,
        updatedAt: now,
      })
      .where(eq(atpmPublishers.id, existing.id));
    return {
      ...existing,
      handle: input.handle,
      pds: input.pds,
      verificationMethod: input.verificationMethod,
      verifiedAt: now,
      disabledAt: null,
      updatedAt: now,
    };
  }

  const id = crypto.randomUUID();
  await db.insert(atpmPublishers).values({
    id,
    organizationId: input.organizationId,
    did: input.did,
    handle: input.handle,
    pds: input.pds,
    verificationMethod: input.verificationMethod,
    verifiedAt: now,
    disabledAt: null,
    lastSweptAt: null,
    createdByUserId: input.createdByUserId,
    createdAt: now,
    updatedAt: now,
  });
  return {
    id,
    organizationId: input.organizationId,
    did: input.did,
    handle: input.handle,
    pds: input.pds,
    verificationMethod: input.verificationMethod,
    verifiedAt: now,
    disabledAt: null,
    lastSweptAt: null,
    createdByUserId: input.createdByUserId,
    createdAt: now,
    updatedAt: now,
  };
}

export async function getAtpmPublisherByDid(
  db: AppDb,
  organizationId: string,
  did: string,
): Promise<AtpmPublisherRecord | null> {
  const [row] = await db
    .select()
    .from(atpmPublishers)
    .where(and(eq(atpmPublishers.organizationId, organizationId), eq(atpmPublishers.did, did)))
    .limit(1);
  return row ? readPublisherRow(row) : null;
}

export async function getAtpmPublisher(
  db: AppDb,
  organizationId: string,
  id: string,
): Promise<AtpmPublisherRecord | null> {
  const [row] = await db
    .select()
    .from(atpmPublishers)
    .where(and(eq(atpmPublishers.organizationId, organizationId), eq(atpmPublishers.id, id)))
    .limit(1);
  return row ? readPublisherRow(row) : null;
}

export async function listAtpmPublishers(
  db: AppDb,
  organizationId: string,
): Promise<AtpmPublisherRecord[]> {
  const rows = await db
    .select()
    .from(atpmPublishers)
    .where(eq(atpmPublishers.organizationId, organizationId));
  return rows.map(readPublisherRow);
}

/** Every active enrolment across all organizations, for the discovery sweep. */
export async function listActiveAtpmPublishers(db: AppDb): Promise<AtpmPublisherRecord[]> {
  const rows = await db.select().from(atpmPublishers).where(isNull(atpmPublishers.disabledAt));
  return rows.map(readPublisherRow);
}

/**
 * Organizations watching a DID. The firehose consumer calls this for every atpm
 * stage written anywhere on the network, so it reads the `did` index and
 * returns nothing at all for the overwhelming majority of events.
 */
export async function listAtpmPublishersForDid(
  db: AppDb,
  did: string,
): Promise<AtpmPublisherRecord[]> {
  const rows = await db
    .select()
    .from(atpmPublishers)
    .where(and(eq(atpmPublishers.did, did), isNull(atpmPublishers.disabledAt)));
  return rows.map(readPublisherRow);
}

export async function deleteAtpmPublisher(
  db: AppDb,
  organizationId: string,
  id: string,
): Promise<boolean> {
  const result = await db
    .delete(atpmPublishers)
    .where(and(eq(atpmPublishers.organizationId, organizationId), eq(atpmPublishers.id, id)))
    .returning({ id: atpmPublishers.id });
  return result.length > 0;
}

export async function markAtpmPublisherSwept(db: AppDb, id: string): Promise<void> {
  const now = new Date();
  await db
    .update(atpmPublishers)
    .set({ lastSweptAt: now, updatedAt: now })
    .where(eq(atpmPublishers.id, id));
}

// ── In-flight authorization requests ─────────────────────────────────────────

export interface AtpmOauthRequestRecord {
  state: string;
  organizationId: string;
  createdByUserId: string | null;
  did: string;
  handle: string | null;
  pds: string;
  issuer: string;
  tokenEndpoint: string;
  pkceVerifier: string;
  dpopKeyCiphertext: string;
  dpopKeyNonce: string;
  expiresAt: Date;
}

export async function createAtpmOauthRequest(
  db: AppDb,
  input: Omit<AtpmOauthRequestRecord, "expiresAt"> & { ttlMs: number },
): Promise<void> {
  const now = new Date();
  await db.insert(atpmOauthRequests).values({
    state: input.state,
    organizationId: input.organizationId,
    createdByUserId: input.createdByUserId,
    did: input.did,
    handle: input.handle,
    pds: input.pds,
    issuer: input.issuer,
    tokenEndpoint: input.tokenEndpoint,
    pkceVerifier: input.pkceVerifier,
    dpopKeyCiphertext: input.dpopKeyCiphertext,
    dpopKeyNonce: input.dpopKeyNonce,
    expiresAt: new Date(now.getTime() + input.ttlMs),
    createdAt: now,
  });
}

/**
 * Read and delete an authorization request in one step.
 *
 * Single use is the point: an authorization code may only be exchanged once, so
 * the state that would allow a second attempt must not outlive the first. The
 * delete happens whether or not the exchange then succeeds, which also means a
 * failed attempt cannot be replayed.
 */
export async function consumeAtpmOauthRequest(
  db: AppDb,
  state: string,
): Promise<AtpmOauthRequestRecord | null> {
  const [row] = await db
    .delete(atpmOauthRequests)
    .where(eq(atpmOauthRequests.state, state))
    .returning();
  if (!row) return null;
  const record: AtpmOauthRequestRecord = {
    state: row.state,
    organizationId: row.organizationId,
    createdByUserId: row.createdByUserId,
    did: row.did,
    handle: row.handle,
    pds: row.pds,
    issuer: row.issuer,
    tokenEndpoint: row.tokenEndpoint,
    pkceVerifier: row.pkceVerifier,
    dpopKeyCiphertext: row.dpopKeyCiphertext,
    dpopKeyNonce: row.dpopKeyNonce,
    expiresAt: new Date(row.expiresAt),
  };
  return record.expiresAt.getTime() > Date.now() ? record : null;
}

/** Drop abandoned requests. Runs on the discovery cron alongside other pruning. */
export async function pruneExpiredAtpmOauthRequests(db: AppDb): Promise<void> {
  await db.delete(atpmOauthRequests).where(lt(atpmOauthRequests.expiresAt, new Date()));
}
