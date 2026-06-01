import { and, eq } from "drizzle-orm";
import { personalOrganizationId } from "../lib/ownership";
import type { AppDb, WorkspaceSession } from "./client";
import { npmConnections, organizationMembers, organizations, user } from "./schema";

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
    .select({ id: user.id, email: user.email, name: user.name })
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
