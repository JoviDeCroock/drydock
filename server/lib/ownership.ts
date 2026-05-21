const PERSONAL_ORGANIZATION_PREFIX = "personal:";

export function personalOrganizationId(userId: string) {
  if (!userId) throw new Error("userId is required for personal organization ownership");
  return `${PERSONAL_ORGANIZATION_PREFIX}${userId}`;
}

export function scanBelongsToOrganization(
  scan: { organizationId?: string | null },
  organizationId: string,
) {
  return Boolean(organizationId) && scan.organizationId === organizationId;
}
