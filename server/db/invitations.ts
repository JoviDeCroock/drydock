import { and, desc, eq, sql } from "drizzle-orm";
import { normalizeRole, type OrganizationRole } from "../lib/auth/roles";
import type { AppDb } from "./client";
import { removeMemberAndReconcileApprovals } from "./scan-approvals";
import { organizationInvitations, organizationMembers, organizations, user } from "./schema";

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function findUserByEmail(db: AppDb, email: string) {
  const [row] = await db
    .select({ id: user.id, email: user.email, name: user.name })
    .from(user)
    .where(eq(user.email, normalizeEmail(email)))
    .limit(1);
  return row ?? null;
}

export async function getOrganizationRole(
  db: AppDb,
  organizationId: string,
  userId: string,
): Promise<OrganizationRole | null> {
  const [row] = await db
    .select({ role: organizationMembers.role, ownerUserId: organizations.ownerUserId })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
    .where(
      and(
        eq(organizationMembers.organizationId, organizationId),
        eq(organizationMembers.userId, userId),
      ),
    )
    .limit(1);
  if (!row) return null;
  if (row.ownerUserId === userId) return "owner";
  return normalizeRole(row.role);
}

export interface OrganizationMemberEntry {
  userId: string;
  email: string | null;
  name: string | null;
  role: OrganizationRole;
  isOwner: boolean;
  joinedAt: Date;
}

export async function listOrganizationMembers(
  db: AppDb,
  organizationId: string,
): Promise<OrganizationMemberEntry[]> {
  const [ownerRow] = await db
    .select({ ownerUserId: organizations.ownerUserId })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  const ownerUserId = ownerRow?.ownerUserId ?? null;

  const rows = await db
    .select({
      userId: organizationMembers.userId,
      role: organizationMembers.role,
      joinedAt: organizationMembers.createdAt,
      email: user.email,
      name: user.name,
    })
    .from(organizationMembers)
    .leftJoin(user, eq(user.id, organizationMembers.userId))
    .where(eq(organizationMembers.organizationId, organizationId));

  return rows
    .map((row) => {
      const isOwner = row.userId === ownerUserId;
      return {
        userId: row.userId,
        email: row.email ?? null,
        name: row.name ?? null,
        role: isOwner ? ("owner" as OrganizationRole) : normalizeRole(row.role),
        isOwner,
        joinedAt: row.joinedAt,
      };
    })
    .sort((a, b) => {
      if (a.isOwner !== b.isOwner) return a.isOwner ? -1 : 1;
      return a.joinedAt.getTime() - b.joinedAt.getTime();
    });
}

export async function addOrganizationMember(
  db: AppDb,
  input: { organizationId: string; userId: string; role: OrganizationRole },
): Promise<void> {
  const now = new Date();
  await db
    .insert(organizationMembers)
    .values({
      id: `member:${input.organizationId}:${input.userId}`,
      organizationId: input.organizationId,
      userId: input.userId,
      role: input.role,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [organizationMembers.organizationId, organizationMembers.userId],
      set: { role: input.role, updatedAt: now },
    });
}

export async function removeOrganizationMember(
  db: AppDb,
  organizationId: string,
  userId: string,
): Promise<boolean> {
  return removeMemberAndReconcileApprovals(db, organizationId, userId);
}

export interface InvitationRecord {
  id: string;
  organizationId: string;
  email: string;
  role: OrganizationRole;
  status: string;
  invitedByUserId: string | null;
  acceptedByUserId: string | null;
  acceptedAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

function readInvitationRow(row: typeof organizationInvitations.$inferSelect): InvitationRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    email: row.email,
    role: normalizeRole(row.role),
    status: row.status,
    invitedByUserId: row.invitedByUserId,
    acceptedByUserId: row.acceptedByUserId,
    acceptedAt: row.acceptedAt,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export interface UpsertInvitationInput {
  organizationId: string;
  email: string;
  role: OrganizationRole;
  tokenHash: string;
  invitedByUserId: string;
  expiresAt: Date;
}

// One live invite per (org, email): re-inviting an address that already has a
// pending invite rotates its token and extends the expiry on the same row, so a
// resend silently invalidates the previous link instead of stacking invites.
export async function upsertInvitation(
  db: AppDb,
  input: UpsertInvitationInput,
): Promise<InvitationRecord> {
  const email = normalizeEmail(input.email);
  const now = new Date();
  const [existing] = await db
    .select()
    .from(organizationInvitations)
    .where(
      and(
        eq(organizationInvitations.organizationId, input.organizationId),
        eq(organizationInvitations.email, email),
        eq(organizationInvitations.status, "pending"),
      ),
    )
    .limit(1);

  if (existing) {
    const [updated] = await db
      .update(organizationInvitations)
      .set({
        role: input.role,
        tokenHash: input.tokenHash,
        invitedByUserId: input.invitedByUserId,
        expiresAt: input.expiresAt,
        updatedAt: now,
      })
      .where(eq(organizationInvitations.id, existing.id))
      .returning();
    return readInvitationRow(updated);
  }

  const [created] = await db
    .insert(organizationInvitations)
    .values({
      id: crypto.randomUUID(),
      organizationId: input.organizationId,
      email,
      role: input.role,
      tokenHash: input.tokenHash,
      status: "pending",
      invitedByUserId: input.invitedByUserId,
      expiresAt: input.expiresAt,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return readInvitationRow(created);
}

export async function listPendingInvitations(
  db: AppDb,
  organizationId: string,
): Promise<InvitationRecord[]> {
  const rows = await db
    .select()
    .from(organizationInvitations)
    .where(
      and(
        eq(organizationInvitations.organizationId, organizationId),
        eq(organizationInvitations.status, "pending"),
      ),
    )
    .orderBy(desc(organizationInvitations.createdAt));
  return rows.map(readInvitationRow);
}

export async function getInvitationByTokenHash(
  db: AppDb,
  tokenHash: string,
): Promise<InvitationRecord | null> {
  const [row] = await db
    .select()
    .from(organizationInvitations)
    .where(eq(organizationInvitations.tokenHash, tokenHash))
    .limit(1);
  return row ? readInvitationRow(row) : null;
}

export async function revokeInvitation(
  db: AppDb,
  organizationId: string,
  invitationId: string,
): Promise<boolean> {
  const result = await db
    .update(organizationInvitations)
    .set({ status: "revoked", updatedAt: new Date() })
    .where(
      and(
        eq(organizationInvitations.id, invitationId),
        eq(organizationInvitations.organizationId, organizationId),
        eq(organizationInvitations.status, "pending"),
      ),
    )
    .returning({ id: organizationInvitations.id });
  return result.length > 0;
}

// Compare-and-swap out of `pending`: the WHERE clause is the single transition,
// so two concurrent accepts of the same link race and only one wins (the loser
// sees zero rows and is treated as already-accepted/expired by the caller).
export async function markInvitationAccepted(
  db: AppDb,
  input: { invitationId: string; acceptedByUserId: string },
): Promise<boolean> {
  const now = new Date();
  const result = await db
    .update(organizationInvitations)
    .set({
      status: "accepted",
      acceptedByUserId: input.acceptedByUserId,
      acceptedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(organizationInvitations.id, input.invitationId),
        eq(organizationInvitations.status, "pending"),
        sql`${organizationInvitations.expiresAt} > ${now.getTime()}`,
      ),
    )
    .returning({ id: organizationInvitations.id });
  return result.length > 0;
}
