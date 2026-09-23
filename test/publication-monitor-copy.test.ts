import { describe, expect, test } from "vitest";
import {
  emptyObservationsMessage,
  observationStatusLabels,
  watchMetaLine,
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
};

describe("publication monitor copy", () => {
  test("an empty release list claims no releases only after a successful check", () => {
    expect(emptyObservationsMessage(watch)).toBe(
      "No releases since enrollment. Earlier releases are not checked.",
    );
    for (const lastError of [
      "registry_evidence_unavailable",
      "check_failed",
      "monitoring_disabled",
    ]) {
      expect(emptyObservationsMessage({ ...watch, lastError })).toBe(
        "Releases since enrollment are unknown until a check succeeds.",
      );
    }
    expect(emptyObservationsMessage({ ...watch, lastCheckedAt: null })).toBe(
      "Not checked yet, so releases since enrollment are unknown.",
    );
    // A backlog is incomplete, not unknown: what was observed is still true.
    expect(emptyObservationsMessage({ ...watch, lastError: "pending_release_backlog" })).toMatch(
      /^No releases since enrollment/,
    );
  });

  test("a watch enrolled from any staged review, discovered or submitted by hand, says so", () => {
    expect(watchMetaLine(watch)).toMatch(/^from a staged review · watching since /);
  });

  test("alert labels speak only for this organization", () => {
    for (const label of Object.values(observationStatusLabels)) {
      expect(label).not.toMatch(/unreviewed|prior approval/i);
    }
    expect(observationStatusLabels.published_without_approval).toBe(
      "Published with no approval in this organization",
    );
  });
});
