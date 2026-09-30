import { describe, expect, test } from "vitest";
import { scanRowPackageLink } from "../src/pages/Dashboard/scan-row-link";

function row(status: string) {
  return {
    id: "scan/1",
    status,
    packageName: "@scope/pkg",
    ecosystem: "npm",
    organizationId: "org-1",
  };
}

describe("scanRowPackageLink", () => {
  test.each(["pending", "running"])("opens the %s review itself", (status) => {
    expect(scanRowPackageLink(row(status))).toEqual({
      href: "/dashboard/scans/scan%2F1",
      title: "Open the review in progress for @scope/pkg",
    });
  });

  test.each(["complete", "failed"])("opens the package history once the review is %s", (status) => {
    expect(scanRowPackageLink(row(status))).toEqual({
      href: "/dashboard/packages/@scope/pkg?org=org-1",
      title: "All reviewed releases of @scope/pkg",
    });
  });
});
