/**
 * Dashboard URL of one saved review.
 *
 * A review belongs to exactly one organization, so its address names it in
 * `?org=` the way a package page does: the page pins that organization, and a
 * link opened in another tab (or after switching organizations elsewhere)
 * still reads the review it points at instead of a 404 from whichever
 * organization the browser last had active.
 */
export function scanDetailPath(
  scanId: string,
  organizationId?: string | null,
  params: Record<string, string | null | undefined> = {},
): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) query.set(key, value);
  }
  if (organizationId) query.set("org", organizationId);
  const qs = query.toString();
  return `/dashboard/scans/${encodeURIComponent(scanId)}${qs ? `?${qs}` : ""}`;
}
