import { packageReleasesPath } from "../../lib/package-releases-path";
import type { ScanListItem } from "../../models/scan-api";

/**
 * Where a Recent reviews row's package name leads, and what its tooltip says.
 *
 * A queued or running review is the thing the reader is waiting on, so the
 * name opens it; the package's release history only becomes the useful target
 * once the review has an outcome to sit among the others.
 */
export function scanRowPackageLink(
  scan: Pick<ScanListItem, "id" | "status" | "ecosystem" | "organizationId"> & {
    packageName: string;
  },
): { href: string; title: string } {
  if (scan.status === "pending" || scan.status === "running") {
    return {
      href: `/dashboard/scans/${encodeURIComponent(scan.id)}`,
      title: `Open the review in progress for ${scan.packageName}`,
    };
  }
  return {
    href: packageReleasesPath(scan.packageName, scan.ecosystem, scan.organizationId),
    title: `All reviewed releases of ${scan.packageName}`,
  };
}
