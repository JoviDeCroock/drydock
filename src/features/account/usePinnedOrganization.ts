import { useEffect } from "preact/hooks";
import { pinOrganization, unpinOrganization } from "../../models/active-organization";

/**
 * Bind a page to the organization its URL names. The pin is applied during
 * render, before any section mounts and issues its first request, so every
 * request the page makes (its own and those of sections other features add)
 * carries that organization strictly through the shared API client. Leaving
 * the page releases the pin; the organization stays the remembered one.
 */
export function usePinnedOrganization(organizationId: string | null): void {
  if (organizationId) pinOrganization(organizationId);
  useEffect(() => () => unpinOrganization(), []);
}
