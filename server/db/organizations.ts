import { and, asc, eq, inArray } from "drizzle-orm";
import { personalOrganizationId } from "../lib/ownership";
import type { AppDb, WorkspaceSession } from "./client";
import {
  githubAppInstallations,
  githubReleaseTargets,
  githubWorkflowGates,
  npmConnections,
  organizationInvitations,
  organizationMembers,
  organizationNotificationRecipients,
  organizations,
  scanEvents,
  scanFiles,
  scanFindings,
  scans,
  user,
} from "./schema";

export async function ensurePersonalOrganization(db: AppDb, session: WorkspaceSession) {
  const organizationId = personalOrganizationId(session.userId);
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
      createdAt: organizations.createdAt,
      updatedAt: organizations.updatedAt,
      npmConnectionId: npmConnections.id,
    })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
    .leftJoin(npmConnections, eq(npmConnections.organizationId, organizations.id))
    .where(eq(organizationMembers.userId, userId));

  return rows
    .map((row) => ({
      id: row.id,
      name: row.name,
      ownerUserId: row.ownerUserId,
      role: row.role,
      isPersonal: row.id === personalId,
      npmConnectionConfigured: Boolean(row.npmConnectionId),
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
 * Permanently delete an organization and every row scoped to it. We delete the
 * children explicitly (in dependency order) rather than relying on
 * `ON DELETE CASCADE`, because D1 does not enforce foreign keys by default and a
 * silent orphan here would leak one org's scans/credentials past its deletion.
 * scan_files / scan_findings hang off scan_id, so they're cleared via a subquery
 * over the org's scans before the scans themselves go.
 */
export async function deleteOrganization(db: AppDb, organizationId: string): Promise<void> {
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
      .delete(organizationInvitations)
      .where(eq(organizationInvitations.organizationId, organizationId)),
    db.delete(organizationMembers).where(eq(organizationMembers.organizationId, organizationId)),
    db.delete(organizations).where(eq(organizations.id, organizationId)),
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

export async function countNotificationRecipients(
  db: AppDb,
  organizationId: string,
): Promise<number> {
  const rows = await db
    .select({ id: organizationNotificationRecipients.id })
    .from(organizationNotificationRecipients)
    .where(eq(organizationNotificationRecipients.organizationId, organizationId));
  return rows.length;
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
