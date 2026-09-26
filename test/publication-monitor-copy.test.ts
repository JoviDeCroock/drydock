import { describe, expect, test } from "vitest";
import {
  coverageGapMessage,
  emptyObservationsMessage,
  observationReasonLabel,
  observationStatusLabels,
  watchMetaLine,
  watchProblemMessage,
} from "../src/features/publication-monitor/copy";
import type { PublicationWatch } from "../src/models/publication-watches";

const watch: PublicationWatch = {
  id: "watch-1",
  organizationId: "org-1",
  packageName: "@scope/package",
  source: "staged_discovery",
  createdAt: "2026-09-01T00:00:00.000Z",
  lastCheckedAt: "2026-09-02T00:00:00.000Z",
  lastError: null,
  unresolvedAlertCount: 0,
  releaseCount: 0,
  coverageGap: null,
  coverageGapSince: null,
  distTagsCheckedAt: null,
  unverifiedReleaseCount: 0,
};

describe("publication monitor copy", () => {
  test("an empty release list claims no releases only after a check with no problem", () => {
    expect(emptyObservationsMessage(watch)).toMatch(
      /^No new releases since you started watching on .+\. Earlier releases are not checked\.$/,
    );
    expect(emptyObservationsMessage({ ...watch, lastCheckedAt: null })).toBe(
      "Not checked yet. Drydock checks it automatically, or choose Check now.",
    );
    // A backlog or one unreadable version can leave a new release unrecorded,
    // so any problem withholds the claim; the problem itself says why.
    for (const lastError of [
      "registry_evidence_unavailable",
      "check_failed",
      "monitoring_disabled",
      "pending_release_backlog",
      "invalid_version_metadata",
      "artifact_timeout",
    ]) {
      expect(emptyObservationsMessage({ ...watch, lastError })).toBe("No releases recorded yet.");
    }
  });

  test("a watch enrolled from any staged review, discovered or submitted by hand, says so", () => {
    expect(watchMetaLine(watch)).toMatch(/ · added from a staged review$/);
  });

  test("a watch's meta line answers what its latest check found", () => {
    expect(watchMetaLine({ ...watch, lastCheckedAt: null })).toMatch(
      /^watching since .+ · not checked yet · /,
    );
    expect(watchMetaLine(watch)).toMatch(/ · checked .+ · no new releases · /);
    expect(watchMetaLine({ ...watch, releaseCount: 1 })).toMatch(/ · 1 new release · /);
    expect(watchMetaLine({ ...watch, releaseCount: 3 })).toMatch(/ · 3 new releases · /);
    for (const lastError of ["check_in_progress", "check_failed", "pending_release_backlog"]) {
      expect(watchMetaLine({ ...watch, lastError })).not.toMatch(/no new releases/);
    }
  });

  test("alert labels speak only for this organization", () => {
    for (const label of Object.values(observationStatusLabels)) {
      expect(label).not.toMatch(/unreviewed|prior approval/i);
    }
    expect(observationStatusLabels.published_without_approval).toBe(
      "Published with no approval in this organization",
    );
  });

  test("an alert's reason asks for the decision first and accuses no one", () => {
    for (const reason of ["review_pending", "review_failed", "reviewed_without_decision"]) {
      const label = observationReasonLabel({ status: "published_without_approval", reason });
      expect(label).toMatch(/these exact bytes/);
      expect(label).toMatch(/investigate if nobody here published it/);
      expect(label).not.toMatch(/compromis|attack|stolen|malicious/i);
    }
    expect(
      observationReasonLabel({
        status: "published_despite_rejection",
        reason: "rejected_after_publication",
      }),
    ).toBe("these exact bytes were rejected after they were published");
    expect(
      observationReasonLabel({ status: "published_without_approval", reason: null }),
    ).toBeNull();
    expect(observationReasonLabel({ status: "unknown", reason: "artifact_too_large" })).toBe(
      "the tarball exceeds the 256 MiB hashing limit",
    );
  });

  test("an oversized package document does not read as a passing outage", () => {
    expect(watchProblemMessage("registry_metadata_too_large")).toMatch(
      /does not resolve by itself/,
    );
    expect(watchProblemMessage("registry_metadata_too_large")).not.toMatch(/retried|next check/);
  });

  test("a coverage gap reads as could-not-verify, only once it has persisted", () => {
    const now = Date.parse("2026-09-02T12:00:00.000Z");
    const gap = {
      ...watch,
      coverageGap: "registry_metadata_too_large",
      coverageGapSince: "2026-09-02T11:30:00.000Z",
    };
    expect(coverageGapMessage(gap, now)).toBeNull();
    const persisted = coverageGapMessage(
      { ...gap, coverageGapSince: "2026-09-02T10:00:00.000Z" },
      now,
    );
    expect(persisted).toBe(
      "Drydock could not verify releases of @scope/package against this organization's reviews: npm's document for it is larger than Drydock reads.",
    );
    expect(coverageGapMessage({ ...watch, unverifiedReleaseCount: 2 }, now)).toMatch(
      /^Drydock could not verify 2 releases of @scope\/package/,
    );
    for (const message of [
      persisted,
      coverageGapMessage({ ...watch, unverifiedReleaseCount: 1 }, now),
    ]) {
      expect(message).not.toMatch(/no approval|despite|differ|alert/i);
    }
    expect(coverageGapMessage(watch, now)).toBeNull();
  });
});
