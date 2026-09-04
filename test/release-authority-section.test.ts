import { describe, expect, test } from "vitest";
import type { GateReleaseAuthority } from "../src/models/github-app";
import { authorityAssessmentMissingForGateApproval } from "../src/pages/Dashboard/ScanDetail/GateDecisionDialog";
import { releaseAuthorityVisibleForFailedGate } from "../src/pages/Dashboard/ScanDetail/ReleaseAuthoritySection";

describe("releaseAuthorityVisibleForFailedGate", () => {
  test("keeps authority evidence visible when a workflow-gate review fails", () => {
    expect(releaseAuthorityVisibleForFailedGate("failed", true)).toBe(true);
  });

  test("does not add the failed-review section to other scan states", () => {
    expect(releaseAuthorityVisibleForFailedGate("failed", false)).toBe(false);
    expect(releaseAuthorityVisibleForFailedGate("complete", true)).toBe(false);
    expect(releaseAuthorityVisibleForFailedGate("pending", true)).toBe(false);
    expect(releaseAuthorityVisibleForFailedGate("running", true)).toBe(false);
  });
});

describe("authorityAssessmentMissingForGateApproval", () => {
  const assessed = {
    run: { repositoryFullName: "octo/example" },
    delta: { status: "unchanged" },
  } as GateReleaseAuthority;

  test("requires both a readable snapshot and delta when policy is enabled", () => {
    expect(authorityAssessmentMissingForGateApproval(null, true, false)).toBe(true);
    expect(authorityAssessmentMissingForGateApproval({ ...assessed, run: null }, true, false)).toBe(
      true,
    );
    expect(
      authorityAssessmentMissingForGateApproval({ ...assessed, delta: null }, true, false),
    ).toBe(true);
    expect(authorityAssessmentMissingForGateApproval(assessed, true, false)).toBe(false);
  });

  test("does not block when policy is disabled or the gate is already decided", () => {
    expect(authorityAssessmentMissingForGateApproval(null, false, false)).toBe(false);
    expect(authorityAssessmentMissingForGateApproval(null, true, true)).toBe(false);
  });
});
