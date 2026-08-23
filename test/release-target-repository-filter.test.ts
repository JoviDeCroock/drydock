import { describe, expect, test } from "vitest";
import {
  buildReleaseTargetPayload,
  selectUnmappedEnvironments,
  type PublicReleaseTarget,
  type RepositoryEnvironment,
} from "../src/models/github-app";

function target(repositoryId: number): PublicReleaseTarget {
  return {
    id: `rt_${repositoryId}`,
    organizationId: "org_1",
    installationRowId: "inst_1",
    ecosystem: "pypi",
    artifactName: null,
    repositoryId,
    repositoryFullName: "octo/whatever",
    environment: "pypi-release",
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
  };
}

describe("selectUnmappedEnvironments", () => {
  const environments: RepositoryEnvironment[] = [
    { name: "chrome-release" },
    { name: "Firefox-Release" },
  ];

  test("returns every environment when no repository is selected", () => {
    expect(selectUnmappedEnvironments(environments, [target(1)], null)).toEqual(environments);
  });

  test("drops only environments already mapped for the selected repository", () => {
    const chrome = target(1);
    chrome.environment = "CHROME-RELEASE";
    const otherRepository = target(2);
    otherRepository.environment = "Firefox-Release";
    expect(selectUnmappedEnvironments(environments, [chrome, otherRepository], 1)).toEqual([
      { name: "Firefox-Release" },
    ]);
  });

  test("returns an empty list once every environment on the repository is mapped", () => {
    const chrome = target(1);
    chrome.environment = "chrome-release";
    const firefox = target(1);
    firefox.id = "rt_firefox";
    firefox.environment = "Firefox-Release";
    expect(selectUnmappedEnvironments(environments, [chrome, firefox], 1)).toEqual([]);
  });
});

describe("buildReleaseTargetPayload", () => {
  const form = {
    installationRowId: " inst_1 ",
    repositoryFullName: " octo/alpha ",
    environment: " release ",
  };

  test("omits ecosystem for auto-detection", () => {
    expect(buildReleaseTargetPayload({ ...form, ecosystem: null })).toEqual({
      installationRowId: "inst_1",
      repositoryFullName: "octo/alpha",
      environment: "release",
    });
  });

  test("pins browser archives when selected", () => {
    expect(buildReleaseTargetPayload({ ...form, ecosystem: "browser" })).toMatchObject({
      ecosystem: "browser",
    });
  });
});
