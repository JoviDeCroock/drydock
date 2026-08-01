import type { Context } from "hono";
import { and, eq } from "drizzle-orm";
import { type AppDb } from "../../db/client";
import { ensurePersonalOrganization } from "../../db/organizations";
import { organizationMembers } from "../../db/schema";
import { UnauthorizedError } from "../platform/errors";
import type { OrganizationRole } from "./roles";
import type { Bindings, Variables } from "../../types";

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
  const organizationId = await ensurePersonalOrganization(db, session);
  if (!organizationId) throw new UnauthorizedError();
  return organizationId;
}

export interface ActiveOrganizationContext {
  organizationId: string;
  role: OrganizationRole;
}

// Resolve the active organization and role in one membership read; falling back
// to the caller's personal organization lazily creates its owner membership.
export async function requireActiveOrganizationContext(
  c: Context<{ Bindings: Bindings; Variables: Variables }>,
  db: AppDb,
): Promise<ActiveOrganizationContext> {
  const session = c.get("authSession");
  const requested = c.req.header(ACTIVE_ORG_HEADER)?.trim() || null;
  if (requested) {
    const [membership] = await db
      .select({
        organizationId: organizationMembers.organizationId,
        role: organizationMembers.role,
      })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.organizationId, requested),
          eq(organizationMembers.userId, session.userId),
        ),
      )
      .limit(1);
    if (membership) {
      return {
        organizationId: membership.organizationId,
        role: membership.role as OrganizationRole,
      };
    }
  }
  const organizationId = await ensurePersonalOrganization(db, session);
  if (!organizationId) throw new UnauthorizedError();
  return { organizationId, role: "owner" };
}
