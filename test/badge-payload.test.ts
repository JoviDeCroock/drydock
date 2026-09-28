import { describe, expect, test } from "vitest";
import type { SharedScanRow } from "../server/db/scan-share";
import {
  buildBadgePayload,
  buildThreatFeedEntry,
  pickBadgeScan,
  postReleaseAnswersTag,
} from "../server/lib/public-feed";
import { compareArchiveDigests } from "../server/lib/ecosystems/artifact-integrity";

function row(overrides: Partial<SharedScanRow> = {}): SharedScanRow {
  return {
    scanId: "scan_1",
    organizationId: "org_1",
    registryVersion: "3.0.0",
    registryPackageName: "docula",
    registryUrl: "https://registry.npmjs.org",
    source: "auto_discovery",
    packageName: "docula",
    stagedVersion: "3.0.0",
    previousVersion: "2.2.0",
    risk: "low",
    decision: "publish",
    findingCount: 0,
    riskSummaryJson: { releaseRisk: "low" },
    summaryJson: { stagedPublish: { tag: "latest" } },
    publicShareToken: "token",
    publicFeedListedAt: new Date(0),
    completedAt: new Date(0),
    ...overrides,
  };
}

describe("badge payload", () => {
  test("a superseded review answers about the release a consumer would install", () => {
    expect(buildBadgePayload(row(), "latest", "3.0.1")).toMatchObject({
      label: "drydock",
      message: "3.0.1 not reviewed",
      color: "lightgrey",
    });
  });

  // The pick is no longer what the badge reports, so its identity qualifier
  // would describe a review this payload does not speak for.
  test("a superseded badge carries no identity qualifier", () => {
    expect(buildBadgePayload(row({ source: "workflow_gate" }), "latest", "3.0.1").label).toBe(
      "drydock",
    );
    expect(buildBadgePayload(row({ source: "workflow_gate" }), "beta", "3.0.1").label).toBe(
      "drydock (beta)",
    );
  });

  test("the superseding version is clamped and sanitized like any other", () => {
    expect(buildBadgePayload(row(), "latest", `3.0.1‮gnp`).message).toBe("3.0.1gnp not reviewed");
    expect(buildBadgePayload(row(), "latest", "9".repeat(80)).message).toBe(
      `${"9".repeat(64)}… not reviewed`,
    );
  });

  test("no supersession leaves the quoted review untouched", () => {
    expect(buildBadgePayload(row(), "latest", null).message).toBe("3.0.0 approved");
  });

  test("a release its publisher declined after npm published it reads blocked", () => {
    expect(
      buildBadgePayload(row(), "latest", { version: "3.0.1", blocked: true, unapproved: false }),
    ).toMatchObject({
      label: "drydock",
      message: "3.0.1 blocked",
      color: "red",
    });
  });

  test("a release its publisher's monitor saw published without approval is flagged orange", () => {
    expect(
      buildBadgePayload(row(), "latest", { version: "3.0.1", blocked: false, unapproved: true }),
    ).toMatchObject({
      label: "drydock",
      message: "3.0.1 published without approval",
      color: "orange",
    });
  });

  test("a decline after release outranks the unapproved flag", () => {
    expect(
      buildBadgePayload(row(), "latest", { version: "3.0.1", blocked: true, unapproved: true }),
    ).toMatchObject({ message: "3.0.1 blocked", color: "red" });
  });

  // `SharedScanRow` carries the owning organization so the badge's staleness
  // probe can scope itself; neither anonymous surface may ever serialize it.
  test("public surfaces never serialize the organization", () => {
    expect(Object.keys(buildBadgePayload(row(), "latest", "3.0.1"))).not.toContain(
      "organizationId",
    );
    const entry = buildThreatFeedEntry(row(), "https://drydock.org");
    expect(Object.keys(entry)).not.toContain("organizationId");
    expect(JSON.stringify(entry)).not.toContain("org_1");
  });
});

describe("post-release decisions on the badge", () => {
  // Only `listPostReleaseBadgeCandidates` sets the marker, after the guard.
  const postRelease = row({ source: "published", postRelease: { tag: "latest" } });

  test("a guarded decision answers as registry-verified; a bare published-pair review never does", () => {
    expect(pickBadgeScan([row({ source: "published" })])).toBeNull();
    expect(pickBadgeScan([postRelease])?.scanId).toBe("scan_1");
    expect(buildBadgePayload(postRelease, "latest")).toMatchObject({
      label: "drydock",
      message: "3.0.0 approved",
      color: "brightgreen",
    });
    expect(buildBadgePayload({ ...postRelease, decision: "no_publish" }, "latest")).toMatchObject({
      message: "3.0.0 blocked",
      color: "red",
    });
  });

  test("answers the tags npm recorded on the release, and `latest` for a stable version", () => {
    expect(postReleaseAnswersTag("3.0.1", null, "latest")).toBe(true);
    expect(postReleaseAnswersTag("3.0.1", [], "latest")).toBe(true);
    expect(postReleaseAnswersTag("3.0.1", ["latest"], "beta")).toBe(false);
    expect(postReleaseAnswersTag("4.0.0-rc.1", null, "latest")).toBe(false);
    expect(postReleaseAnswersTag("4.0.0-rc.1", ["latest"], "latest")).toBe(true);
    expect(postReleaseAnswersTag("4.0.0-rc.1", ["next"], "next")).toBe(true);
  });
});

describe("comparing archive digests", () => {
  const sha1 = "a".repeat(40);
  const sha256 = "b".repeat(64);

  test("every shared algorithm must agree, and at least one must be shared", () => {
    expect(compareArchiveDigests({ sha1, sha256 }, { sha1, sha256 })).toBe("match");
    expect(compareArchiveDigests({ sha1, sha256: null }, { sha1, sha256 })).toBe("match");
    expect(compareArchiveDigests({ sha1, sha256 }, { sha1, sha256: "c".repeat(64) })).toBe(
      "differ",
    );
    expect(compareArchiveDigests({ sha1, sha256: null }, { sha1: null, sha256 })).toBe(
      "incomparable",
    );
    expect(compareArchiveDigests(null, { sha1, sha256 })).toBe("incomparable");
  });
});
