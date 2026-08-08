export type OrganizationRole = "owner" | "admin" | "member";

export const ORGANIZATION_ROLES: readonly OrganizationRole[] = ["owner", "admin", "member"];

// Roles an owner/admin may hand out via an invite. Ownership is never granted by
// invite — there is exactly one owner per org (organizations.ownerUserId).
export const INVITABLE_ROLES: readonly OrganizationRole[] = ["admin", "member"];

export function normalizeRole(value: unknown): OrganizationRole {
  return value === "owner" || value === "admin" ? value : "member";
}

export function isInvitableRole(value: unknown): value is OrganizationRole {
  return value === "admin" || value === "member";
}

// Member management and integration management both require elevated access.
// A plain member can read org-scoped data and act on scans, but cannot change
// who is in the org or rewire its credentials/release targets.
export function roleCanManageMembers(role: OrganizationRole | null): boolean {
  return role === "owner" || role === "admin";
}

export function roleCanManageIntegrations(role: OrganizationRole | null): boolean {
  return role === "owner" || role === "admin";
}

// Publishing a report beyond the organization is a governance action, not a
// scan-review action, so it takes the same elevated bar as integrations.
export function roleCanManagePublicShares(role: OrganizationRole | null): boolean {
  return role === "owner" || role === "admin";
}
