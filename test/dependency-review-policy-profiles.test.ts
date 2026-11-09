import { afterEach, expect, test, vi } from "vitest";
import {
  dependencyReviewPolicyForProfile,
  dependencyReviewPolicyProfile,
} from "../server/lib/dependency-review/policy-profiles";
import { DEFAULT_DEPENDENCY_REVIEW_POLICY } from "../server/lib/dependency-review/types";
import type { BumpEvidence } from "../server/lib/dependency-review/types";
import {
  evaluateBumpEvidence,
  newPackageVerdict,
  unreviewedVerdict,
} from "../server/lib/dependency-review/policy";
import { DependencyReviewsModel } from "../src/models/dependency-review";
import { jsonResponse } from "./helpers/fetch-stub";

afterEach(() => vi.unstubAllGlobals());

test("Prevention holds new and unread changes without changing the existing default", () => {
  const original = { ...DEFAULT_DEPENDENCY_REVIEW_POLICY };
  const prevention = dependencyReviewPolicyForProfile("prevention");
  expect(prevention).toEqual({
    ...original,
    holdOnUninspectedFiles: true,
    holdOnUnreviewed: true,
    holdOnNewPackages: true,
  });
  prevention.holdOnInstallScripts = false;
  expect(dependencyReviewPolicyForProfile("prevention").holdOnInstallScripts).toBe(true);
  expect(DEFAULT_DEPENDENCY_REVIEW_POLICY).toEqual(original);
  expect(dependencyReviewPolicyForProfile("capability")).toEqual(original);
});

test("a changed risk threshold or hold becomes Custom", () => {
  expect(dependencyReviewPolicyProfile(dependencyReviewPolicyForProfile("capability"))).toBe(
    "capability",
  );
  expect(dependencyReviewPolicyProfile(dependencyReviewPolicyForProfile("prevention"))).toBe(
    "prevention",
  );
  expect(
    dependencyReviewPolicyProfile({ ...DEFAULT_DEPENDENCY_REVIEW_POLICY, holdAtReleaseRisk: null }),
  ).toBe("custom");
  expect(
    dependencyReviewPolicyProfile({ ...DEFAULT_DEPENDENCY_REVIEW_POLICY, holdOnNewPackages: true }),
  ).toBe("custom");
});

test("Prevention blocks missing evidence while a complete low-risk update remains clear", () => {
  const prevention = dependencyReviewPolicyForProfile("prevention");
  const capability = dependencyReviewPolicyForProfile("capability");
  const evidence: BumpEvidence = {
    releaseRisk: "low",
    filesAdded: 0,
    filesRemoved: 0,
    filesChanged: 1,
    installScriptsAdded: 0,
    installScriptsChanged: 0,
    nativeBinariesAdded: 0,
    dependenciesAdded: 0,
    binCommandsAdded: 0,
    uninspectedFiles: 0,
    coverageNotices: 0,
    findings: [],
    findingCount: 0,
  };
  expect(evaluateBumpEvidence(evidence, prevention).status).toBe("clear");
  expect(evaluateBumpEvidence({ ...evidence, coverageNotices: 1 }, prevention)).toMatchObject({
    status: "hold",
    reasons: ["uninspected-files"],
  });
  expect(evaluateBumpEvidence({ ...evidence, coverageNotices: 1 }, capability).status).toBe(
    "clear",
  );
  expect(newPackageVerdict(prevention)).toMatchObject({ status: "hold", reasons: ["new-package"] });
  expect(newPackageVerdict(capability).status).toBe("new-package");
  expect(unreviewedVerdict("private-source", prevention)).toMatchObject({
    status: "hold",
    reasons: ["unreviewed"],
  });
  expect(unreviewedVerdict("private-source", capability).status).toBe("unreviewed");
});

test("loading preserves saved Custom policy and selecting a profile only edits the draft", async () => {
  const settings = {
    enabled: true,
    policy: { ...DEFAULT_DEPENDENCY_REVIEW_POLICY, holdAtReleaseRisk: "critical" as const },
    extraBotLogins: ["self-hosted-bot"],
  };
  const fetchMock = vi.fn(() =>
    Promise.resolve(
      jsonResponse({
        settings,
        githubAppInstalled: true,
        reviews: [],
        viewer: { canManage: true },
      }),
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  const model = new DependencyReviewsModel();
  try {
    await model.load();
    expect(model.draftProfile.value).toBe("custom");
    expect(model.dirty.value).toBe(false);
    model.setProfile("prevention");
    expect(model.draftProfile.value).toBe("prevention");
    expect(model.dirty.value).toBe(true);
    expect(model.saved.value).toEqual(settings);
    expect(model.draftBotLogins.value).toBe("self-hosted-bot");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    model.setPolicy("holdOnNewPackages", false);
    expect(model.draftProfile.value).toBe("custom");
    model.discard();
    expect(model.draftPolicy.value).toEqual(settings.policy);
    expect(model.dirty.value).toBe(false);
  } finally {
    model[Symbol.dispose]();
  }
});
