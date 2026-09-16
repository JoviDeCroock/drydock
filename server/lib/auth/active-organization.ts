import type { Context } from "hono";
import { and, eq } from "drizzle-orm";
import { type AppDb } from "../../db/client";
import { ensurePersonalOrganization } from "../../db/organizations";
import { organizationMembers } from "../../db/schema";
import { ForbiddenError, UnauthorizedError } from "../platform/errors";
import type { OrganizationRole } from "./roles";
import type { Bindings, Variables } from "../../types";

export const ACTIVE_ORG_HEADER = "x-organization-id";

type AppContext = Context<{ Bindings: Bindings; Variables: Variables }>;

export interface ActiveOrganizationContext {
  organizationId: string;
  role: OrganizationRole;
}

// Resolve the active organization and role in one membership read; falling back
// to the caller's personal organization lazily creates its owner membership.
export async function requireActiveOrganizationContext(
  c: AppContext,
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
    if (membership) return membership;
  }
  const organizationId = await ensurePersonalOrganization(db, session);
  if (!organizationId) throw new UnauthorizedError();
  return { organizationId, role: "owner" };
}

export async function requireActiveOrganization(c: AppContext, db: AppDb): Promise<string> {
  return (await requireActiveOrganizationContext(c, db)).organizationId;
}

/**
 * Resolves the active organization and rejects the request with a 403 (via
 * `ForbiddenError`) unless the caller's role satisfies `allowed`. Membership
 * itself is never the question here: a non-member already fell back to their
 * personal organization above.
 */
export async function requireOrganizationRole(
  c: AppContext,
  db: AppDb,
  allowed: (role: OrganizationRole) => boolean,
): Promise<ActiveOrganizationContext> {
  const context = await requireActiveOrganizationContext(c, db);
  if (!allowed(context.role)) throw new ForbiddenError();
  return context;
}
