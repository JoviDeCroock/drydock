import type { Context } from "hono";
import { and, eq } from "drizzle-orm";
import type { AppDb } from "../db";
import { ensurePersonalOrganization } from "../db";
import { organizationMembers } from "../db/schema";
import { type OrganizationRole, personalOrganizationId } from "./ownership";
import type { Bindings, Variables } from "../types";

export const ACTIVE_ORG_HEADER = "x-organization-id";

export async function requireActiveOrganization(
  c: Context<{ Bindings: Bindings; Variables: Variables }>,
  db: AppDb,
): Promise<string> {
  const result = await resolveActiveOrganization(c, db);
  return result.organizationId;
}

export async function resolveActiveOrganization(
  c: Context<{ Bindings: Bindings; Variables: Variables }>,
  db: AppDb,
): Promise<{ organizationId: string; role: OrganizationRole }> {
  const session = c.get("authSession");
  const requested = c.req.header(ACTIVE_ORG_HEADER)?.trim() || null;
  if (requested) {
    const [membership] = await db
      .select({ role: organizationMembers.role })
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
        organizationId: requested,
        role: (membership.role === "member" ? "member" : "owner") as OrganizationRole,
      };
    }
  }
  await ensurePersonalOrganization(db, session);
  return { organizationId: personalOrganizationId(session.userId), role: "owner" };
}
