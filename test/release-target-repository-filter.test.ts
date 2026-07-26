import { describe, expect, test } from "vitest";
import {
  selectUnmappedRepositories,
  type InstallationRepository,
  type PublicReleaseTarget,
} from "../src/models/github-app";

const repos: InstallationRepository[] = [
  { id: 1, fullName: "octo/alpha", defaultBranch: "main" },
  { id: 2, fullName: "octo/beta", defaultBranch: "main" },
  { id: 3, fullName: "octo/gamma", defaultBranch: null },
];

function target(repositoryId: number): PublicReleaseTarget {
  return {
    id: `rt_${repositoryId}`,
    organizationId: "org_1",
    installationRowId: "inst_1",
    ecosystem: "pypi",
    repositoryId,
    repositoryFullName: "octo/whatever",
    environment: "pypi-release",
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
  };
}

describe("selectUnmappedRepositories", () => {
  test("returns every repository when nothing is mapped yet", () => {
    expect(selectUnmappedRepositories(repos, [])).toEqual(repos);
  });

  test("drops repositories that already have a release target", () => {
    const available = selectUnmappedRepositories(repos, [target(2)]);
    expect(available.map((repo) => repo.id)).toEqual([1, 3]);
  });

  test("matches on repository id, not full name, so renames still hide the repo", () => {
    const renamed = target(1);
    renamed.repositoryFullName = "octo/alpha-renamed";
    const available = selectUnmappedRepositories(repos, [renamed]);
    expect(available.map((repo) => repo.id)).toEqual([2, 3]);
  });

  test("returns an empty list once every accessible repo is mapped", () => {
    const allMapped = selectUnmappedRepositories(repos, [target(1), target(2), target(3)]);
    expect(allMapped).toEqual([]);
  });
});
