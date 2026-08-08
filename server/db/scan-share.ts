import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { base64UrlEncode } from "../lib/platform/crypto-utils";
import type { AppDb } from "./client";
import { recordScanEvent } from "./events";
import { scans } from "./schema";

// 256 bits of entropy, base64url (43 chars). The token is the whole capability
// for the public report route, so it must be unguessable; lookups go through
// the unique index, not string comparison in application code.
function generatePublicShareToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

export interface PublicShareState {
  publicShareToken: string;
  publicSharedAt: Date;
}

/**
 * Enable (or return the existing) public share link for a completed scan.
 * Idempotent: re-sharing an already-shared scan returns the current token so
 * the UI never rotates a link that may already be distributed.
 */
export async function enablePublicShare(
  db: AppDb,
  input: { scanId: string; organizationId: string; actorUserId: string },
): Promise<PublicShareState | null> {
  const readShareState = () =>
    db
      .select({
        status: scans.status,
        publicShareToken: scans.publicShareToken,
        publicSharedAt: scans.publicSharedAt,
        packageName: scans.packageName,
        stagedVersion: scans.stagedVersion,
      })
      .from(scans)
      .where(and(eq(scans.id, input.scanId), eq(scans.organizationId, input.organizationId)))
      .limit(1);

  const [existing] = await readShareState();
  if (!existing) return null;
  if (existing.status !== "complete") return null;
  if (existing.publicShareToken && existing.publicSharedAt) {
    return { publicShareToken: existing.publicShareToken, publicSharedAt: existing.publicSharedAt };
  }

  const now = new Date();
  const token = generatePublicShareToken();
  const updated = await db
    .update(scans)
    .set({
      publicShareToken: token,
      publicSharedAt: now,
      publicSharedByUserId: input.actorUserId,
      updatedAt: now,
    })
    .where(
      and(
        eq(scans.id, input.scanId),
        eq(scans.organizationId, input.organizationId),
        eq(scans.status, "complete"),
        // Guards the idempotency promise under concurrency: two racing enables
        // must never rotate a token one of them already returned.
        isNull(scans.publicShareToken),
      ),
    )
    .returning({ id: scans.id });
  if (updated.length === 0) {
    // Lost the race to a concurrent enable — return the winner's token.
    const [current] = await readShareState();
    if (current?.publicShareToken && current.publicSharedAt) {
      return { publicShareToken: current.publicShareToken, publicSharedAt: current.publicSharedAt };
    }
    return null;
  }

  await recordScanEvent(db, {
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    scanId: input.scanId,
    type: "scan.share_enabled",
    metadata: { packageName: existing.packageName, stagedVersion: existing.stagedVersion },
  });
  return { publicShareToken: token, publicSharedAt: now };
}

/** Revoke the public share link. Returns false when the scan was not shared. */
export async function revokePublicShare(
  db: AppDb,
  input: { scanId: string; organizationId: string; actorUserId: string },
): Promise<boolean> {
  const now = new Date();
  const updated = await db
    .update(scans)
    .set({
      publicShareToken: null,
      publicSharedAt: null,
      publicSharedByUserId: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(scans.id, input.scanId),
        eq(scans.organizationId, input.organizationId),
        isNotNull(scans.publicShareToken),
      ),
    )
    .returning({
      id: scans.id,
      packageName: scans.packageName,
      stagedVersion: scans.stagedVersion,
    });
  if (updated.length === 0) return false;

  await recordScanEvent(db, {
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    scanId: input.scanId,
    type: "scan.share_revoked",
    metadata: { packageName: updated[0].packageName, stagedVersion: updated[0].stagedVersion },
  });
  return true;
}

/**
 * Resolve a public share token to its scan's id + organization. The caller
 * re-reads the full detail through `getScan` with the resolved organization so
 * the public path shares the exact read pipeline (R2 artifacts, digest checks)
 * used by authenticated reads.
 */
export async function resolvePublicShareToken(
  db: AppDb,
  token: string,
): Promise<{ scanId: string; organizationId: string } | null> {
  if (!token) return null;
  const [row] = await db
    .select({ scanId: scans.id, organizationId: scans.organizationId, status: scans.status })
    .from(scans)
    .where(eq(scans.publicShareToken, token))
    .limit(1);
  if (!row || row.status !== "complete" || !row.organizationId) return null;
  return { scanId: row.scanId, organizationId: row.organizationId };
}
