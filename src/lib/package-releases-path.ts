/**
 * Dashboard URL of one package's release view.
 *
 * A scoped npm name keeps its `/` in the path (`/dashboard/packages/@scope/name`),
 * exactly as `/diff` does: the asset layer 307-redirects a percent-encoded
 * slash to a literal one, so a single encoded segment would not survive a hard
 * load. The client route and the API route both take the name as a rest
 * parameter. The ecosystem rides in the query only when it is not npm, so the
 * common link stays short and the page can default the same way the API does.
 * The organization rides in `?org=` and stays there: the page shows one
 * organization's history, and a link without it would show whichever
 * organization the reader's browser last had active.
 */
import { encodePackageName } from "./package-diff-path";

export function packageReleasesPath(
  packageName: string,
  ecosystem?: string | null,
  organizationId?: string | null,
): string {
  const params = new URLSearchParams();
  if (ecosystem && ecosystem !== "npm") params.set("ecosystem", ecosystem);
  if (organizationId) params.set("org", organizationId);
  const qs = params.toString();
  return `/dashboard/packages/${encodePackageName(packageName)}${qs ? `?${qs}` : ""}`;
}

export function packageReleasesApiPath(
  packageName: string,
  options: { ecosystem?: string | null; cursor?: string | null; limit?: number } = {},
): string {
  const params = new URLSearchParams();
  if (options.ecosystem && options.ecosystem !== "npm") params.set("ecosystem", options.ecosystem);
  if (options.cursor) params.set("cursor", options.cursor);
  if (options.limit) params.set("limit", String(options.limit));
  const qs = params.toString();
  return `/api/v1/packages/${encodePackageName(packageName)}/releases${qs ? `?${qs}` : ""}`;
}
