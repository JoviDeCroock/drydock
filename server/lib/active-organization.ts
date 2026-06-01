import type { Context } from "hono";
import { and, eq } from "drizzle-orm";
import type { AppDb } from "../db";
import { ensurePersonalOrganization, getOrganizationRole } from "../db";
import { organizationMembers } from "../db/schema";
import { personalOrganizationId } from "./ownership";
import type { OrganizationRole } from "./roles";
import type { Bindings, Variables } from "../types";

export const ACTIVE_ORG_HEADER = "x-organization-id";

export async function requireActiveOrganization(
  c: Context<{ Bindings: Bindings; Variables: Variables }>,
  db: AppDb,
): Promise<string> {
  const session = c.get("authSession");
  const requested = c.req.header(ACTIVE_ORG_HEADER)?.trim() || null;
  if (requested) {
    const [membership] = await db
      .select({ organizationId: organizationMembers.organizationId })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.organizationId, requested),
          eq(organizationMembers.userId, session.userId),
        ),
      )
      .limit(1);
    if (membership) return requested;
  }
  await ensurePersonalOrganization(db, session);
  return personalOrganizationId(session.userId);
}

export interface ActiveOrganizationContext {
  organizationId: string;
  role: OrganizationRole;
}

// Resolve the active organization and the caller's role within it. Because
// requireActiveOrganization only returns an org the caller is a member of (or
// their own personal org), a membership row always exists, so role defaults to
// "member" only defensively.
export async function requireActiveOrganizationContext(
  c: Context<{ Bindings: Bindings; Variables: Variables }>,
  db: AppDb,
): Promise<ActiveOrganizationContext> {
  const organizationId = await requireActiveOrganization(c, db);
  const session = c.get("authSession");
  const role = (await getOrganizationRole(db, organizationId, session.userId)) ?? "member";
  return { organizationId, role };
}
