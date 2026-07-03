import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { personalOrganizationId } from "../lib/ownership";
import { deleteOrganizationArtifacts } from "../lib/scan-artifacts";
import type { AppDb, WorkspaceSession } from "./client";
import {
  githubAppInstallations,
  githubReleaseTargets,
  githubWorkflowGates,
  npmConnections,
  organizationInvitations,
  organizationMembers,
  organizationNotificationRecipients,
  organizationSlackConnections,
  organizations,
  scanEvents,
  scanFiles,
  scanFindings,
  scans,
  twoFactor,
  user,
} from "./schema";

export async function ensurePersonalOrganization(db: AppDb, session: WorkspaceSession) {
  const organizationId = personalOrganizationId(session.userId);
  const [existing] = await db
    .select({ organizationId: organizationMembers.organizationId })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, organizationId),
        eq(organizationMembers.userId, session.userId),
      ),
    )
    .limit(1);
  if (existing) return organizationId;

  const now = new Date();
  const name = session.name || session.email || "Personal workspace";

  await db
    .insert(organizations)
    .values({
      id: organizationId,
      name,
      ownerUserId: session.userId,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();

  await db
    .insert(organizationMembers)
    .values({
      id: `member:${organizationId}:${session.userId}`,
      organizationId,
      userId: session.userId,
      role: "owner",
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();

  return organizationId;
}

export async function getUserContact(db: AppDb, userId: string) {
  const [row] = await db
    .select({ id: user.id, email: user.email, emailVerified: user.emailVerified, name: user.name })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  return row ?? null;
}

export async function getOrganizationName(db: AppDb, organizationId: string) {
  const [row] = await db
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  return row?.name ?? null;
}

export async function getOrganizationOwnerUserId(db: AppDb, organizationId: string) {
  const [row] = await db
    .select({ ownerUserId: organizations.ownerUserId })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  return row?.ownerUserId ?? null;
}

export interface OrganizationListEntry {
  id: string;
  name: string;
  ownerUserId: string;
  role: string;
  isPersonal: boolean;
  npmConnectionConfigured: boolean;
  requireTwoFactorForReleaseDecisions: boolean;
  createdAt: Date | string | number;
  updatedAt: Date | string | number;
}

export async function listUserOrganizations(
  db: AppDb,
  userId: string,
): Promise<OrganizationListEntry[]> {
  const personalId = personalOrganizationId(userId);
  const rows = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      ownerUserId: organizations.ownerUserId,
      role: organizationMembers.role,
      requireTwoFactorForReleaseDecisions: organizations.requireTwoFactorForReleaseDecisions,
      createdAt: organizations.createdAt,
      updatedAt: organizations.updatedAt,
      npmConnectionConfigured: sql<boolean>`exists (
        select 1
        from ${npmConnections}
        where ${npmConnections.organizationId} = ${organizations.id}
      )`,
    })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
    .where(eq(organizationMembers.userId, userId));

  return rows
    .map((row) => ({
      id: row.id,
      name: row.name,
      ownerUserId: row.ownerUserId,
      role: row.role,
      isPersonal: row.id === personalId,
      npmConnectionConfigured: Boolean(row.npmConnectionConfigured),
      requireTwoFactorForReleaseDecisions: Boolean(row.requireTwoFactorForReleaseDecisions),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }))
    .sort((a, b) => {
      if (a.isPersonal !== b.isPersonal) return a.isPersonal ? -1 : 1;
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    });
}

export interface CreateOrganizationInput {
  ownerUserId: string;
  name: string;
}

export async function createOrganization(db: AppDb, input: CreateOrganizationInput) {
  const id = crypto.randomUUID();
  const now = new Date();
  await db.batch([
    db.insert(organizations).values({
      id,
      name: input.name,
      ownerUserId: input.ownerUserId,
      createdAt: now,
      updatedAt: now,
    }),
    db.insert(organizationMembers).values({
      id: `member:${id}:${input.ownerUserId}`,
      organizationId: id,
      userId: input.ownerUserId,
      role: "owner",
      createdAt: now,
      updatedAt: now,
    }),
  ]);
  return id;
}

export async function isOrganizationOwner(
  db: AppDb,
  organizationId: string,
  userId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(and(eq(organizations.id, organizationId), eq(organizations.ownerUserId, userId)))
    .limit(1);
  return Boolean(row);
}

export async function renameOrganization(db: AppDb, organizationId: string, name: string) {
  await db
    .update(organizations)
    .set({ name, updatedAt: new Date() })
    .where(eq(organizations.id, organizationId));
}

/**
 * Whether this org enforces a two-factor step-up on release-gate decisions for
 * every member. Read at decision time as an authoritative org-level policy on
 * top of the per-user enrollment check — fail closed: a missing org row reads as
 * "not required" only because such a row cannot reach the decision path (the
 * gate is scoped to a real org the caller belongs to).
 */
export async function organizationRequiresTwoFactorForReleaseDecisions(
  db: AppDb,
  organizationId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ enabled: organizations.requireTwoFactorForReleaseDecisions })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  return Boolean(row?.enabled);
}

export async function setRequireTwoFactorForReleaseDecisions(
  db: AppDb,
  organizationId: string,
  enabled: boolean,
) {
  await db
    .update(organizations)
    .set({ requireTwoFactorForReleaseDecisions: enabled, updatedAt: new Date() })
    .where(eq(organizations.id, organizationId));
}

/**
 * Permanently delete an organization and every row scoped to it. We delete the
 * children explicitly (in dependency order) rather than relying on
 * `ON DELETE CASCADE`, because D1 does not enforce foreign keys by default and a
 * silent orphan here would leak one org's scans/credentials past its deletion.
 * scan_files / scan_findings hang off scan_id, so they're cleared via a subquery
 * over the org's scans before the scans themselves go. The org's derived R2
 * artifacts are removed after the D1 teardown so redacted evidence doesn't
 * outlive the org; pass the ARTIFACTS bucket (the deletion is a no-op without
 * it, e.g. in environments with no bucket bound).
 */
export async function deleteOrganization(
  db: AppDb,
  organizationId: string,
  artifactBucket?: R2Bucket,
): Promise<void> {
  const orgScans = db
    .select({ id: scans.id })
    .from(scans)
    .where(eq(scans.organizationId, organizationId));

  await db.batch([
    db.delete(scanFindings).where(inArray(scanFindings.scanId, orgScans)),
    db.delete(scanFiles).where(inArray(scanFiles.scanId, orgScans)),
    db.delete(scanEvents).where(eq(scanEvents.organizationId, organizationId)),
    db.delete(scans).where(eq(scans.organizationId, organizationId)),
    db.delete(githubWorkflowGates).where(eq(githubWorkflowGates.organizationId, organizationId)),
    db.delete(githubReleaseTargets).where(eq(githubReleaseTargets.organizationId, organizationId)),
    db
      .delete(githubAppInstallations)
      .where(eq(githubAppInstallations.organizationId, organizationId)),
    db.delete(npmConnections).where(eq(npmConnections.organizationId, organizationId)),
    db
      .delete(organizationNotificationRecipients)
      .where(eq(organizationNotificationRecipients.organizationId, organizationId)),
    db
      .delete(organizationSlackConnections)
      .where(eq(organizationSlackConnections.organizationId, organizationId)),
    db
      .delete(organizationInvitations)
      .where(eq(organizationInvitations.organizationId, organizationId)),
    db.delete(organizationMembers).where(eq(organizationMembers.organizationId, organizationId)),
    db.delete(organizations).where(eq(organizations.id, organizationId)),
  ]);

  await deleteOrganizationArtifacts(artifactBucket, organizationId);
}

export interface CoOwnedOrganization {
  id: string;
  name: string;
  otherMemberCount: number;
}

/**
 * Non-personal organizations this user owns that still have *other* members.
 * Account deletion is refused while any of these exist: silently removing the
 * owner would either orphan the org or, if we cascaded, wipe other members'
 * scans, npm token, and GitHub gates. The owner must hand these off or delete
 * them first. The personal workspace is always sole-owned, so it never blocks.
 */
export async function findCoOwnedOrganizations(
  db: AppDb,
  userId: string,
): Promise<CoOwnedOrganization[]> {
  const personalId = personalOrganizationId(userId);
  const rows = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      otherMemberCount: sql<number>`count(${organizationMembers.userId})`,
    })
    .from(organizations)
    .innerJoin(
      organizationMembers,
      and(
        eq(organizationMembers.organizationId, organizations.id),
        ne(organizationMembers.userId, userId),
      ),
    )
    .where(and(eq(organizations.ownerUserId, userId), ne(organizations.id, personalId)))
    .groupBy(organizations.id, organizations.name);
  return rows;
}

/**
 * Permanently delete everything Drydock owns for a user. Better Auth removes the
 * `user`, `session`, and `account` rows itself once its `beforeDelete` hook (our
 * caller) returns; this clears the rest. Because D1 does not enforce foreign
 * keys, none of it cascades on its own — mirroring deleteOrganization, we delete
 * by hand:
 *   - every organization the user owns outright (the personal workspace, plus
 *     any owned org that has no other members) via deleteOrganization, which
 *     also clears their membership rows there;
 *   - the user out of rows they created or decided on in organizations owned by
 *     *others*, which survive. Those columns are ON DELETE SET NULL, so we null
 *     them so a join to the now-deleted user can't dangle;
 *   - the user's remaining memberships and their 2FA secret.
 * Co-owned organizations (non-personal, with other members) must be rejected by
 * findCoOwnedOrganizations before this runs; if one reaches here it is left
 * intact rather than destroying another member's data.
 */
export async function deleteUserAccount(
  db: AppDb,
  userId: string,
  artifactBucket?: R2Bucket,
): Promise<void> {
  const personalId = personalOrganizationId(userId);
  const owned = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.ownerUserId, userId));

  for (const org of owned) {
    if (org.id !== personalId) {
      const others = (
        await db
          .select({ userId: organizationMembers.userId })
          .from(organizationMembers)
          .where(eq(organizationMembers.organizationId, org.id))
      ).filter((member) => member.userId !== userId).length;
      if (others > 0) continue; // co-owned: rejected upstream, never wiped here
    }
    await deleteOrganization(db, org.id, artifactBucket);
  }

  await db.batch([
    db.update(scans).set({ ownerUserId: null }).where(eq(scans.ownerUserId, userId)),
    db.update(scans).set({ decidedByUserId: null }).where(eq(scans.decidedByUserId, userId)),
    db.update(scanEvents).set({ actorUserId: null }).where(eq(scanEvents.actorUserId, userId)),
    db
      .update(npmConnections)
      .set({ createdByUserId: null })
      .where(eq(npmConnections.createdByUserId, userId)),
    db
      .update(organizationSlackConnections)
      .set({ createdByUserId: null })
      .where(eq(organizationSlackConnections.createdByUserId, userId)),
    db
      .update(githubAppInstallations)
      .set({ createdByUserId: null })
      .where(eq(githubAppInstallations.createdByUserId, userId)),
    db
      .update(githubReleaseTargets)
      .set({ createdByUserId: null })
      .where(eq(githubReleaseTargets.createdByUserId, userId)),
    db
      .update(organizationNotificationRecipients)
      .set({ createdByUserId: null })
      .where(eq(organizationNotificationRecipients.createdByUserId, userId)),
    db
      .update(organizationInvitations)
      .set({ invitedByUserId: null })
      .where(eq(organizationInvitations.invitedByUserId, userId)),
    db
      .update(organizationInvitations)
      .set({ acceptedByUserId: null })
      .where(eq(organizationInvitations.acceptedByUserId, userId)),
    db.delete(organizationMembers).where(eq(organizationMembers.userId, userId)),
    db.delete(twoFactor).where(eq(twoFactor.userId, userId)),
  ]);
}

export interface NotificationRecipient {
  id: string;
  organizationId: string;
  email: string;
  createdByUserId: string | null;
  createdAt: Date | string | number;
  updatedAt: Date | string | number;
}

export async function listNotificationRecipients(
  db: AppDb,
  organizationId: string,
): Promise<NotificationRecipient[]> {
  return db
    .select({
      id: organizationNotificationRecipients.id,
      organizationId: organizationNotificationRecipients.organizationId,
      email: organizationNotificationRecipients.email,
      createdByUserId: organizationNotificationRecipients.createdByUserId,
      createdAt: organizationNotificationRecipients.createdAt,
      updatedAt: organizationNotificationRecipients.updatedAt,
    })
    .from(organizationNotificationRecipients)
    .where(eq(organizationNotificationRecipients.organizationId, organizationId))
    .orderBy(asc(organizationNotificationRecipients.createdAt));
}

export interface AddNotificationRecipientInput {
  organizationId: string;
  email: string;
  createdByUserId: string | null;
}

export async function addNotificationRecipient(
  db: AppDb,
  input: AddNotificationRecipientInput,
): Promise<{ created: boolean; recipient: NotificationRecipient }> {
  const email = input.email.trim().toLowerCase();
  const now = new Date();
  await db
    .insert(organizationNotificationRecipients)
    .values({
      id: crypto.randomUUID(),
      organizationId: input.organizationId,
      email,
      createdByUserId: input.createdByUserId,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();

  const [recipient] = await db
    .select({
      id: organizationNotificationRecipients.id,
      organizationId: organizationNotificationRecipients.organizationId,
      email: organizationNotificationRecipients.email,
      createdByUserId: organizationNotificationRecipients.createdByUserId,
      createdAt: organizationNotificationRecipients.createdAt,
      updatedAt: organizationNotificationRecipients.updatedAt,
    })
    .from(organizationNotificationRecipients)
    .where(
      and(
        eq(organizationNotificationRecipients.organizationId, input.organizationId),
        eq(organizationNotificationRecipients.email, email),
      ),
    )
    .limit(1);

  const created = new Date(recipient.createdAt).getTime() === now.getTime();
  return { created, recipient };
}

export async function deleteNotificationRecipient(
  db: AppDb,
  organizationId: string,
  recipientId: string,
): Promise<NotificationRecipient | null> {
  const [removed] = await db
    .delete(organizationNotificationRecipients)
    .where(
      and(
        eq(organizationNotificationRecipients.id, recipientId),
        eq(organizationNotificationRecipients.organizationId, organizationId),
      ),
    )
    .returning({
      id: organizationNotificationRecipients.id,
      organizationId: organizationNotificationRecipients.organizationId,
      email: organizationNotificationRecipients.email,
      createdByUserId: organizationNotificationRecipients.createdByUserId,
      createdAt: organizationNotificationRecipients.createdAt,
      updatedAt: organizationNotificationRecipients.updatedAt,
    });
  return removed ?? null;
}

/**
 * Resolve who receives a notification for an organization. When the org has
 * configured recipients they fully define the set; otherwise we fall back to the
 * owner's email so an org that never touched the setting keeps today's behavior
 * (and a misconfiguration never silently drops a security alert). Addresses are
 * lowercased and de-duplicated.
 */
export async function resolveNotificationEmails(
  db: AppDb,
  organizationId: string,
  ownerUserId: string,
): Promise<string[]> {
  const configured = await listNotificationRecipients(db, organizationId);
  if (configured.length > 0) {
    return dedupeEmails(configured.map((row) => row.email));
  }
  const owner = await getUserContact(db, ownerUserId);
  return owner?.email ? dedupeEmails([owner.email]) : [];
}

function dedupeEmails(emails: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const email of emails) {
    const normalized = email.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}
