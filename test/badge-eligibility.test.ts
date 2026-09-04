import { describe, expect, test } from "vitest";
import { SCAN_SOURCES } from "../server/db/scans";
import {
  BADGE_INELIGIBLE_SOURCES,
  badgeEcosystem,
  isBadgeEligibleSource,
} from "../server/lib/public-feed";

const publishedPair = (ecosystem: string) => ({
  stagedPublish: { mode: "published_pair", ecosystem, packageName: "pkg", version: "1.0.0" },
});

const gateProvenance = (ecosystem: string) => ({
  stagedPublish: { provenance: { ecosystem, mode: "workflow_gate", artifacts: [] } },
});

describe("badge eligibility", () => {
  test("only the credential-backed staged sources may occupy the badge index", () => {
    expect(SCAN_SOURCES.filter(isBadgeEligibleSource)).toEqual([
      "manual",
      "auto_discovery",
      "workflow_gate",
    ]);
  });

  // The badge-candidate query filters on a literal source list rather than
  // calling the classifier, so the two have to be pinned together.
  test("the SQL exclusion list matches what the classifier rejects", () => {
    expect(SCAN_SOURCES.filter((source) => !isBadgeEligibleSource(source))).toEqual([
      ...BADGE_INELIGIBLE_SOURCES,
    ]);
  });

  test("an unrecognized source fails closed", () => {
    expect(isBadgeEligibleSource("some_future_source")).toBe(false);
  });

  test("a published-pair review has no badge ecosystem in any registry", () => {
    for (const ecosystem of ["npm", "pypi", "vscode"]) {
      expect(badgeEcosystem("published", publishedPair(ecosystem))).toBeNull();
    }
  });

  test("badge-eligible sources keep the ecosystem the badge is keyed on", () => {
    expect(badgeEcosystem("manual", { report: {} })).toBe("npm");
    expect(badgeEcosystem("workflow_gate", gateProvenance("pypi"))).toBe("pypi");
    expect(badgeEcosystem("workflow_gate", { report: {} })).toBeNull();
  });
});
