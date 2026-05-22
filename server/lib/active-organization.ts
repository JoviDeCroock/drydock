import { and, eq } from "drizzle-orm";
import type { AppDb, WorkspaceSession } from "../db";
import { ensurePersonalOrganization } from "../db";
import { organizationMembers, user as userTable } from "../db/schema";
import { personalOrganizationId } from "./ownership";

export async function requireActiveOrganization(
  db: AppDb,
  session: WorkspaceSession,
): Promise<string> {
  const personalId = personalOrganizationId(session.userId);
  const [row] = await db
    .select({ activeOrganizationId: userTable.activeOrganizationId })
    .from(userTable)
    .where(eq(userTable.id, session.userId))
    .limit(1);

  const candidate = row?.activeOrganizationId ?? null;
  if (candidate) {
    const [membership] = await db
      .select({ organizationId: organizationMembers.organizationId })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.organizationId, candidate),
          eq(organizationMembers.userId, session.userId),
        ),
      )
      .limit(1);
    if (membership) return candidate;
  }

  await ensurePersonalOrganization(db, session);
  await db
    .update(userTable)
    .set({ activeOrganizationId: personalId, updatedAt: new Date() })
    .where(eq(userTable.id, session.userId));
  return personalId;
}

export async function setActiveOrganization(
  db: AppDb,
  session: WorkspaceSession,
  organizationId: string,
): Promise<boolean> {
  const [membership] = await db
    .select({ organizationId: organizationMembers.organizationId })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, organizationId),
        eq(organizationMembers.userId, session.userId),
      ),
    )
    .limit(1);
  if (!membership) return false;

  await db
    .update(userTable)
    .set({ activeOrganizationId: organizationId, updatedAt: new Date() })
    .where(eq(userTable.id, session.userId));
  return true;
}
