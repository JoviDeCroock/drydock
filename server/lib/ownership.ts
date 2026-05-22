const PERSONAL_ORGANIZATION_PREFIX = "personal:";

export const ORGANIZATION_ROLES = ["owner", "member"] as const;
export type OrganizationRole = (typeof ORGANIZATION_ROLES)[number];

export function isOrganizationRole(value: unknown): value is OrganizationRole {
  return typeof value === "string" && (ORGANIZATION_ROLES as readonly string[]).includes(value);
}

export function personalOrganizationId(userId: string) {
  if (!userId) throw new Error("userId is required for personal organization ownership");
  return `${PERSONAL_ORGANIZATION_PREFIX}${userId}`;
}

export function isPersonalOrganizationId(id: string) {
  return id.startsWith(PERSONAL_ORGANIZATION_PREFIX);
}

export function scanBelongsToOrganization(
  scan: { organizationId?: string | null },
  organizationId: string,
) {
  return Boolean(organizationId) && scan.organizationId === organizationId;
}
