import type { Context } from "hono";
import { and, eq } from "drizzle-orm";
import { type AppDb } from "../../db/client";
import { ensurePersonalOrganization } from "../../db/organizations";
import { organizationMembers } from "../../db/schema";
import { ForbiddenError, UnauthorizedError } from "../platform/errors";
import type { OrganizationRole } from "./roles";
import type { Bindings, Variables } from "../../types";

export const ACTIVE_ORG_HEADER = "x-organization-id";
/**
 * Sent by a page whose URL names its organization. A selector for an
 * organization the caller does not belong to is then refused rather than
 * answered from their personal organization, which would render a believable
 * page about the wrong organization.
 */
export const ACTIVE_ORG_STRICT_HEADER = "x-organization-strict";

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
  const apiKey = c.get("apiKey");
  if (apiKey) return apiKeyOrganizationContext(c, apiKey.organizationId);
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
    if (c.req.header(ACTIVE_ORG_STRICT_HEADER) === "1") {
      throw new ForbiddenError("not a member of this organization", "not_organization_member");
    }
  }
  const organizationId = await ensurePersonalOrganization(db, session);
  if (!organizationId) throw new UnauthorizedError();
  return { organizationId, role: "owner" };
}

/**
 * An API key belongs to exactly one organization and acts as a plain member:
 * every route it reaches is one a member can use. A selector naming another
 * organization is refused rather than silently answered from the key's own.
 */
function apiKeyOrganizationContext(
  c: AppContext,
  organizationId: string,
): ActiveOrganizationContext {
  const requested = c.req.header(ACTIVE_ORG_HEADER)?.trim() || null;
  if (requested && requested !== organizationId) {
    throw new ForbiddenError(
      "API key belongs to another organization",
      "api_key_organization_mismatch",
    );
  }
  return { organizationId, role: "member" };
}

/**
 * The user a request acts as: the signed-in user, or for an API key the key's
 * creator, whose membership the key lookup has just proved.
 */
export function requestActorUserId(c: AppContext): string {
  return c.get("apiKey")?.userId ?? c.get("authSession").userId;
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
