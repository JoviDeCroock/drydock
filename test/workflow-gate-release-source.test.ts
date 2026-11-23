import { afterEach, describe, expect, test, vi } from "vitest";
import {
  inspectGateReleaseSource,
  releaseSourceFindings,
  resolveTagCommit,
} from "../server/lib/workflow-gates/release-source";

const HEAD = "de2f74e0".padEnd(40, "0");
const OTHER = "63956bf0".padEnd(40, "1");
const TAG_OBJECT = "aaaaaaaa".padEnd(40, "2");
const UPCOMING = "bbbbbbbb".padEnd(40, "3");
const MAIN = "cccccccc".padEnd(40, "4");
const RELEASE_1X = "dddddddd".padEnd(40, "5");

type Routes = Record<string, unknown | ((url: URL) => Response)>;

function stubGithub(routes: Routes) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const key = `${url.pathname.replace("/repos/octo/example", "")}${url.search}`;
      calls.push(key);
      const route = routes[key];
      if (route === undefined) return new Response("{}", { status: 404 });
      if (typeof route === "function") return (route as (url: URL) => Response)(url);
      return Response.json(route);
    }),
  );
  return calls;
}

function run(overrides: Record<string, unknown> = {}) {
  return { id: 42, head_sha: HEAD, head_branch: "v13.3.0", event: "release", ...overrides };
}

const REPOSITORY = { default_branch: "master" };
const commitRef = (sha: string) => ({ object: { type: "commit", sha } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("inspectGateReleaseSource", () => {
  test("bee-js shape: a tagged commit on no protected branch", async () => {
    stubGithub({
      "/actions/runs/42": run(),
      "/git/ref/tags/v13.3.0": { object: { type: "tag", sha: TAG_OBJECT } },
      [`/git/tags/${TAG_OBJECT}`]: { object: { type: "commit", sha: HEAD } },
      "": REPOSITORY,
      "/branches?protected=true&per_page=11": [{ name: "upcoming", commit: { sha: UPCOMING } }],
      [`/compare/${UPCOMING}...${HEAD}?per_page=1&page=2`]: { status: "diverged" },
    });
    const source = await inspectGateReleaseSource("t", "octo/example", 42);
    expect(source).toEqual({
      headSha: HEAD,
      event: "release",
      tag: { name: "v13.3.0", commitSha: HEAD },
      protection: {
        status: "unprotected",
        repositoryProtectsBranches: true,
        defaultBranch: "master",
      },
    });
    const findings = releaseSourceFindings(source);
    expect(findings.map((f) => [f.ruleId, f.severity, f.file])).toEqual([
      ["release.unprotected-commit", "medium", "<release-process>"],
    ]);
    expect(findings[0].evidence).toBe("commit de2f74e00000 is not on any protected branch");
    expect(findings[0].ruleVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("a commit reachable from a protected branch emits nothing", async () => {
    stubGithub({
      "/actions/runs/42": run({ head_branch: "main", event: "push" }),
      "/git/ref/heads/main": commitRef(HEAD),
      "": { default_branch: "main" },
      "/branches?protected=true&per_page=11": [
        { name: "release", commit: { sha: RELEASE_1X } },
        { name: "main", commit: { sha: MAIN } },
      ],
      [`/compare/${MAIN}...${HEAD}?per_page=1&page=2`]: { status: "identical" },
    });
    const source = await inspectGateReleaseSource("t", "octo/example", 42);
    expect(source?.tag).toBeNull();
    expect(source?.protection).toEqual({ status: "protected", branch: "main" });
    expect(releaseSourceFindings(source)).toEqual([]);
  });

  test("checks every protected branch before calling a commit unprotected", async () => {
    const calls = stubGithub({
      "/actions/runs/42": run({ head_branch: "release/1.x", event: "workflow_dispatch" }),
      "/git/ref/heads/release/1.x": commitRef(HEAD),
      "": { default_branch: "main" },
      "/branches?protected=true&per_page=11": [
        { name: "release/1.x", commit: { sha: RELEASE_1X } },
        { name: "main", commit: { sha: MAIN } },
      ],
      [`/compare/${MAIN}...${HEAD}?per_page=1&page=2`]: { status: "ahead" },
      [`/compare/${RELEASE_1X}...${HEAD}?per_page=1&page=2`]: { status: "behind" },
    });
    const source = await inspectGateReleaseSource("t", "octo/example", 42);
    expect(source?.protection).toEqual({ status: "protected", branch: "release/1.x" });
    // Default branch is compared first.
    expect(calls.filter((c) => c.startsWith("/compare/"))[0]).toContain(`/compare/${MAIN}...`);
  });

  test("a repository that protects no branch falls back to the default branch, at low", async () => {
    stubGithub({
      "/actions/runs/42": run({ head_branch: "feature", event: "workflow_dispatch" }),
      "/git/ref/heads/feature": commitRef(HEAD),
      "/git/ref/heads/main": commitRef(MAIN),
      "": { default_branch: "main" },
      "/branches?protected=true&per_page=11": [],
      [`/compare/${MAIN}...${HEAD}?per_page=1&page=2`]: { status: "diverged" },
    });
    const findings = releaseSourceFindings(await inspectGateReleaseSource("t", "octo/example", 42));
    expect(findings.map((f) => [f.ruleId, f.severity])).toEqual([
      ["release.unprotected-commit", "low"],
    ]);
    expect(findings[0].evidence).toContain("not on the default branch main");
  });

  test("a direct push to an unprotected default branch is quiet when nothing is protected", async () => {
    stubGithub({
      "/actions/runs/42": run({ head_branch: "master", event: "push" }),
      "/git/ref/heads/master": commitRef(HEAD),
      "": REPOSITORY,
      "/branches?protected=true&per_page=11": [],
      [`/compare/${HEAD}...${HEAD}?per_page=1&page=2`]: { status: "identical" },
    });
    expect(releaseSourceFindings(await inspectGateReleaseSource("t", "octo/example", 42))).toEqual(
      [],
    );
  });

  test("a tag that names another commit is a high mismatch", async () => {
    stubGithub({
      "/actions/runs/42": run({ head_branch: "v2.4.1", event: "push" }),
      "/git/ref/tags/v2.4.1": commitRef(OTHER),
      "": REPOSITORY,
      "/branches?protected=true&per_page=11": [{ name: "master", commit: { sha: MAIN } }],
      [`/compare/${MAIN}...${HEAD}?per_page=1&page=2`]: { status: "behind" },
    });
    const findings = releaseSourceFindings(await inspectGateReleaseSource("t", "octo/example", 42));
    expect(findings.map((f) => [f.ruleId, f.severity])).toEqual([["release.tag-mismatch", "high"]]);
    expect(findings[0].evidence).toBe(
      "the run was started from tag v2.4.1 and built de2f74e00000; the tag now points at 63956bf01111",
    );
  });

  test("a deleted tag on a release run is a mismatch", async () => {
    stubGithub({
      "/actions/runs/42": run(),
      "": REPOSITORY,
      "/branches?protected=true&per_page=11": [{ name: "master", commit: { sha: MAIN } }],
      [`/compare/${MAIN}...${HEAD}?per_page=1&page=2`]: { status: "behind" },
    });
    const findings = releaseSourceFindings(await inspectGateReleaseSource("t", "octo/example", 42));
    expect(findings.map((f) => f.ruleId)).toEqual(["release.tag-mismatch"]);
    expect(findings[0].evidence).toContain("the tag no longer exists");
  });

  test("a push whose ref is both a tag and a branch is not treated as a tag run", async () => {
    stubGithub({
      "/actions/runs/42": run({ head_branch: "next", event: "push" }),
      "/git/ref/tags/next": commitRef(OTHER),
      "/git/ref/heads/next": commitRef(HEAD),
      "": REPOSITORY,
      "/branches?protected=true&per_page=11": [{ name: "next", commit: { sha: HEAD } }],
      [`/compare/${HEAD}...${HEAD}?per_page=1&page=2`]: { status: "identical" },
    });
    const source = await inspectGateReleaseSource("t", "octo/example", 42);
    expect(source?.tag).toBeNull();
    expect(releaseSourceFindings(source)).toEqual([]);
  });

  test("a commit with no history in common with a protected branch is unprotected", async () => {
    stubGithub({
      "/actions/runs/42": run(),
      "/git/ref/tags/v13.3.0": commitRef(HEAD),
      "": REPOSITORY,
      "/branches?protected=true&per_page=11": [{ name: "upcoming", commit: { sha: UPCOMING } }],
      // GitHub answers 404 for a comparison between unrelated histories.
    });
    const source = await inspectGateReleaseSource("t", "octo/example", 42);
    expect(source?.protection).toMatchObject({ status: "unprotected" });
  });

  test("compares against the branch tip commit, so a tag named like the branch cannot stand in", async () => {
    const calls = stubGithub({
      "/actions/runs/42": run(),
      "/git/ref/tags/v13.3.0": commitRef(HEAD),
      "": REPOSITORY,
      "/branches?protected=true&per_page=11": [{ name: "main", commit: { sha: MAIN } }],
      // A tag `main` pointing at the release commit would make this identical.
      [`/compare/main...${HEAD}?per_page=1&page=2`]: { status: "identical" },
      [`/compare/${MAIN}...${HEAD}?per_page=1&page=2`]: { status: "diverged" },
    });
    const source = await inspectGateReleaseSource("t", "octo/example", 42);
    expect(source?.protection).toMatchObject({ status: "unprotected" });
    expect(calls).not.toContain(`/compare/main...${HEAD}?per_page=1&page=2`);
  });

  test("an undetermined branch does not hide a later protected match", async () => {
    stubGithub({
      "/actions/runs/42": run({ head_branch: "main", event: "push" }),
      "/git/ref/heads/main": commitRef(HEAD),
      "": { default_branch: "main" },
      "/branches?protected=true&per_page=11": [
        { name: "main", commit: { sha: MAIN } },
        { name: "release", commit: { sha: RELEASE_1X } },
      ],
      [`/compare/${MAIN}...${HEAD}?per_page=1&page=2`]: () => new Response("busy", { status: 422 }),
      [`/compare/${RELEASE_1X}...${HEAD}?per_page=1&page=2`]: { status: "behind" },
    });
    const source = await inspectGateReleaseSource("t", "octo/example", 42);
    expect(source?.protection).toEqual({ status: "protected", branch: "release" });
  });

  test("a retried review keeps a tag an earlier review bound, even after it was deleted", async () => {
    const routes = {
      "/actions/runs/42": run({ head_branch: "v2.4.1", event: "push" }),
      "": REPOSITORY,
      "/branches?protected=true&per_page=11": [{ name: "master", commit: { sha: MAIN } }],
      [`/compare/${MAIN}...${HEAD}?per_page=1&page=2`]: { status: "behind" },
    };
    stubGithub(routes);
    // Without the earlier binding a missing ref on a push run is unknown.
    expect((await inspectGateReleaseSource("t", "octo/example", 42))?.tag).toBeNull();
    const findings = releaseSourceFindings(
      await inspectGateReleaseSource("t", "octo/example", 42, "v2.4.1"),
    );
    expect(findings.map((f) => [f.ruleId, f.severity])).toEqual([["release.tag-mismatch", "high"]]);
    expect(findings[0].evidence).toContain("the tag no longer exists");
  });

  test("a failed tag read on a release run still binds the tag at the run's commit", async () => {
    stubGithub({
      "/actions/runs/42": run(),
      "/git/ref/tags/v13.3.0": () => new Response("busy", { status: 502 }),
      "": REPOSITORY,
      "/branches?protected=true&per_page=11": [{ name: "master", commit: { sha: MAIN } }],
      [`/compare/${MAIN}...${HEAD}?per_page=1&page=2`]: { status: "behind" },
    });
    const source = await inspectGateReleaseSource("t", "octo/example", 42);
    expect(source?.tag).toEqual({ name: "v13.3.0", commitSha: HEAD });
    expect(releaseSourceFindings(source)).toEqual([]);
  });

  test("a denied tag read binds nothing, so approval is not tied to a read that cannot succeed", async () => {
    stubGithub({
      "/actions/runs/42": run(),
      "/git/ref/tags/v13.3.0": () => new Response("forbidden", { status: 403 }),
      "": REPOSITORY,
      "/branches?protected=true&per_page=11": [{ name: "master", commit: { sha: MAIN } }],
      [`/compare/${MAIN}...${HEAD}?per_page=1&page=2`]: { status: "behind" },
    });
    expect((await inspectGateReleaseSource("t", "octo/example", 42))?.tag).toBeNull();
  });

  test("GitHub failures read as unknown and emit nothing", async () => {
    stubGithub({
      "/actions/runs/42": run(),
      "/git/ref/tags/v13.3.0": () => new Response("forbidden", { status: 403 }),
      "": () => new Response("forbidden", { status: 403 }),
    });
    const source = await inspectGateReleaseSource("t", "octo/example", 42);
    expect(source?.tag).toBeNull();
    expect(source?.protection).toEqual({ status: "unknown" });
    expect(releaseSourceFindings(source)).toEqual([]);
  });

  test("more protected branches than the cap is unknown, not unprotected", async () => {
    stubGithub({
      "/actions/runs/42": run({ head_branch: "main", event: "push" }),
      "/git/ref/heads/main": commitRef(HEAD),
      "": { default_branch: "main" },
      "/branches?protected=true&per_page=11": Array.from({ length: 11 }, (_, i) => ({
        name: `b${i}`,
      })),
    });
    const source = await inspectGateReleaseSource("t", "octo/example", 42);
    expect(source?.protection).toEqual({ status: "unknown" });
  });

  test("an unreadable run returns null", async () => {
    stubGithub({ "/actions/runs/42": { id: 42, run_attempt: 1 } });
    expect(await inspectGateReleaseSource("t", "octo/example", 42)).toBeNull();
    expect(releaseSourceFindings(null)).toEqual([]);
  });
});

describe("resolveTagCommit", () => {
  test("dereferences annotated tags and reports deletion as null", async () => {
    stubGithub({
      "/git/ref/tags/v1": { object: { type: "tag", sha: TAG_OBJECT } },
      [`/git/tags/${TAG_OBJECT}`]: { object: { type: "commit", sha: HEAD.toUpperCase() } },
    });
    expect(await resolveTagCommit("t", "octo/example", "v1")).toBe(HEAD);
    expect(await resolveTagCommit("t", "octo/example", "v2")).toBeNull();
  });

  test("throws when GitHub cannot answer, so approval fails closed", async () => {
    stubGithub({ "/git/ref/tags/v1": () => new Response("nope", { status: 403 }) });
    await expect(resolveTagCommit("t", "octo/example", "v1")).rejects.toThrow();
  });
});
