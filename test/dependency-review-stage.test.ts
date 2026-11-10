import { beforeEach, describe, expect, test, vi } from "vitest";
import { dependencyChangeKey } from "../server/db/dependency-reviews";
import { bumpDiffUrl } from "../server/lib/dependency-review/approvable";
import type { ReviewContext } from "../server/lib/dependency-review/context";
import {
  bumpProgressKey,
  emptyProgress,
  ProgressWriter,
  type DependencyReviewProgress,
} from "../server/lib/dependency-review/progress";
import {
  MAX_COLD_DIFFS_PER_PASS,
  runReviewStage,
} from "../server/lib/dependency-review/review-bumps";
import {
  DEFAULT_DEPENDENCY_REVIEW_POLICY,
  type DependencyBump,
  type DependencyReviewPolicy,
} from "../server/lib/dependency-review/types";
import { PublicDiffError } from "../server/lib/public-diff/error";
import type { PublicPackageDiff } from "../server/lib/public-diff";

const { verifyMirrorBump, readCached, loadDiff, listVersions } = vi.hoisted(() => ({
  verifyMirrorBump: vi.fn(),
  readCached: vi.fn(),
  loadDiff: vi.fn(),
  listVersions: vi.fn(),
}));

vi.mock("../server/lib/dependency-review/mirror-identity", () => ({ verifyMirrorBump }));
vi.mock("../server/lib/public-diff", async () => {
  const { PublicDiffError: Err } = await import("../server/lib/public-diff/error");
  const { publicDiffEgressAllowed } = await import("../server/lib/public-diff/egress");
  return {
    PublicDiffError: Err,
    publicDiffEgressAllowed,
    readCachedPublicPackageDiff: readCached,
    loadPublicPackageDiff: loadDiff,
  };
});
vi.mock("../server/lib/ecosystems", () => {
  const adapter = (ecosystem: string) => ({
    ecosystem,
    registryUrl: `https://registry.${ecosystem}.example`,
    isValidPackageName: () => true,
    isValidVersion: () => true,
    normalizePackageName: (name: string) => name.toLowerCase(),
    // PEP 440-ish for the test: "1.0" and "1.0.0" name one release.
    versionsEquivalent:
      ecosystem === "pypi"
        ? (a: string, b: string) => a.replace(/(\.0)+$/, "") === b.replace(/(\.0)+$/, "")
        : undefined,
    listVersions,
  });
  return { getPublicDiffAdapter: adapter };
});

const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;

function diffPayload(diff: PublicPackageDiff["diff"] = []): PublicPackageDiff {
  return {
    ecosystem: "npm",
    packageName: "x",
    fromVersion: "1.0.0",
    toVersion: "1.0.1",
    fromPackageJson: null,
    toPackageJson: null,
    fromFiles: [],
    toFiles: [],
    diff,
    packageJsonDiff: {
      name: "x",
      hasPreviousManifest: true,
      previousVersion: "1.0.0",
      stagedVersion: "1.0.1",
      scripts: [],
      dependencies: [],
      bin: [],
      entrypointsChanged: false,
    },
    findings: [],
    risk: {
      artifactRisk: "low",
      releaseRisk: "low",
      contextRisk: "low",
      releaseFindingCount: 0,
      contextFindingCount: 0,
      unknownFindingCount: 0,
      priorApprovedContextFindingCount: 0,
    },
    cachedAt: new Date(NOW).toISOString(),
  };
}

const bump = (name: string, overrides: Partial<DependencyBump> = {}): DependencyBump => ({
  ecosystem: "npm",
  name,
  fromVersion: "1.0.0",
  toVersion: "1.0.1",
  direct: true,
  lockfilePath: "package-lock.json",
  ...overrides,
});

const mirrorBump = (name: string): DependencyBump =>
  bump(name, {
    privateSource: true,
    mirror: { fromHashes: ["sha512-a"], toHashes: ["sha512-b"] },
  });

function context(envOverrides: Record<string, unknown> = {}): ReviewContext {
  return {
    env: {
      BETTER_AUTH_URL: "https://drydock.example",
      ...envOverrides,
    } as unknown as Cloudflare.Env,
    ctx: {} as ExecutionContext,
    db: {} as ReviewContext["db"],
    review: { id: "dr_1", organizationId: "org_1" } as ReviewContext["review"],
    repo: { owner: "o", name: "r" },
    token: "t",
    appId: "1",
    detailsUrl: null,
  };
}

function writer(progress: DependencyReviewProgress = emptyProgress(NOW)) {
  const saves: string[] = [];
  const instance = new ProgressWriter(progress, async (json) => {
    saves.push(json);
    return true;
  });
  return { instance, saves };
}

async function stage(
  bumps: DependencyBump[],
  options: {
    policy?: DependencyReviewPolicy;
    progress?: DependencyReviewProgress;
    env?: Record<string, unknown>;
  } = {},
) {
  const w = writer(options.progress);
  const result = await runReviewStage(
    context(options.env),
    bumps,
    options.policy ?? DEFAULT_DEPENDENCY_REVIEW_POLICY,
    w.instance,
    Date.now() + 60_000,
  );
  return { ...result, progress: w.instance.progress, saves: w.saves };
}

beforeEach(() => {
  for (const fn of [verifyMirrorBump, readCached, loadDiff, listVersions]) fn.mockReset();
  readCached.mockResolvedValue(null);
  loadDiff.mockResolvedValue(diffPayload([{ path: "index.js", status: "modified", flags: [] }]));
  listVersions.mockRejectedValue(new Error("not stubbed"));
});

describe("review stage budget", () => {
  test("cached pairs cost nothing; cold pairs stop at the per-pass budget", async () => {
    const cached = Array.from({ length: 60 }, (_, i) => bump(`cached-${i}`));
    const cold = Array.from({ length: MAX_COLD_DIFFS_PER_PASS + 3 }, (_, i) => bump(`cold-${i}`));
    readCached.mockImplementation(async (_env, _ctx, input: { packageName: string }) =>
      input.packageName.startsWith("cached-") ? diffPayload() : null,
    );

    const result = await stage([...cached, ...cold]);

    expect(loadDiff).toHaveBeenCalledTimes(MAX_COLD_DIFFS_PER_PASS);
    expect(result.complete).toBe(false);
    expect(result.settled).toBe(60 + MAX_COLD_DIFFS_PER_PASS);
    // The unreached three read as over the cap if no pass followed.
    expect(result.outcomes.slice(-3)).toEqual([
      { kind: "unreviewed", reason: "over-cap" },
      { kind: "unreviewed", reason: "over-cap" },
      { kind: "unreviewed", reason: "over-cap" },
    ]);

    // The next pass diffs only what is left.
    loadDiff.mockClear();
    const next = await stage([...cached, ...cold], { progress: result.progress });
    expect(loadDiff).toHaveBeenCalledTimes(3);
    expect(next.complete).toBe(true);
    expect(next.outcomes.every((outcome) => outcome.kind === "diffed")).toBe(true);
  });

  test("outcomes the public diff doesn't cache are kept, not retried", async () => {
    loadDiff.mockImplementation(async (_env, _ctx, input: { packageName: string }) => {
      if (input.packageName === "gone") throw new PublicDiffError("missing", 404);
      if (input.packageName === "huge") throw new PublicDiffError("too large", 413);
      throw new Error("sandbox crashed");
    });
    const bumps = [bump("gone"), bump("huge"), bump("broken")];

    const first = await stage(bumps, {
      policy: { ...DEFAULT_DEPENDENCY_REVIEW_POLICY, holdOnUnreviewed: true },
    });
    expect(first.outcomes).toEqual([
      { kind: "unreviewed", reason: "not-found" },
      { kind: "unreviewed", reason: "unsupported" },
      { kind: "unreviewed", reason: "failed" },
    ]);
    loadDiff.mockClear();
    readCached.mockClear();
    await stage(bumps, { progress: first.progress });
    expect(readCached).not.toHaveBeenCalled();
    expect(loadDiff).not.toHaveBeenCalled();
  });

  test("cheap outcomes are written in batches, each cold diff at once", async () => {
    readCached.mockResolvedValue(diffPayload());
    const cached = await stage(Array.from({ length: 20 }, (_, i) => bump(`p-${i}`)));
    // 20 outcomes flush in batches of 8 before the caller's final flush.
    expect(cached.saves).toHaveLength(2);
    expect(Object.keys(JSON.parse(cached.saves[0]).bumps)).toHaveLength(8);

    readCached.mockResolvedValue(null);
    const cold = await stage(Array.from({ length: 5 }, (_, i) => bump(`c-${i}`)));
    expect(cold.saves).toHaveLength(5);
  });
});

describe("publish-time lookups", () => {
  test("only bumps the fallback reads are looked up, once per package per pass", async () => {
    listVersions.mockResolvedValue({
      packageName: "fresh",
      versions: [
        { version: "2.0.0", publishedAt: new Date(NOW - DAY).toISOString() },
        { version: "1.0.0", publishedAt: new Date(NOW - 30 * DAY).toISOString() },
      ],
      suggested: null,
    });
    const result = await stage([
      bump("fresh", { fromVersion: null, toVersion: "2.0.0", lockfilePath: "a/package-lock.json" }),
      bump("fresh", { fromVersion: null, toVersion: "2.0.0", lockfilePath: "b/package-lock.json" }),
      bump("read-fully"),
    ]);

    expect(listVersions).toHaveBeenCalledTimes(1);
    expect(result.outcomes[0]).toEqual({
      kind: "new-package",
      publishedAt: new Date(NOW - DAY).toISOString(),
    });
    // A fully read diff needs no publish time.
    expect(result.outcomes[2]).toMatchObject({ kind: "diffed" });
    expect(result.outcomes[2]).not.toHaveProperty("publishedAt");
    expect(result.complete).toBe(true);
  });

  test("a PyPI lockfile version matches its release by equivalence", async () => {
    const uploaded = new Date(NOW - 2 * DAY).toISOString();
    listVersions.mockResolvedValue({
      packageName: "requests",
      versions: [{ version: "2.0", publishedAt: uploaded }],
      suggested: null,
    });
    const result = await stage([
      bump("Requests", { ecosystem: "pypi", fromVersion: null, toVersion: "2.0.0" }),
    ]);
    expect(result.outcomes[0]).toEqual({ kind: "new-package", publishedAt: uploaded });
  });

  test("a failed lookup is stored as unknown, and nothing is fetched with egress off", async () => {
    const failed = await stage([bump("lost", { fromVersion: null })]);
    expect(failed.outcomes[0]).toEqual({ kind: "new-package", publishedAt: null });

    listVersions.mockClear();
    const offline = await stage([bump("private-install", { fromVersion: null })], {
      env: { NPM_REGISTRY: "https://npm.internal.example" },
    });
    expect(listVersions).not.toHaveBeenCalled();
    expect(offline.outcomes[0]).toEqual({ kind: "new-package", publishedAt: null });
  });

  test("private and remote sources are never looked up", async () => {
    const result = await stage([
      bump("corp", { privateSource: true }),
      bump("from-git", { privateSource: true, remoteSource: true }),
    ]);
    expect(listVersions).not.toHaveBeenCalled();
    expect(result.outcomes).toEqual([
      { kind: "unreviewed", reason: "private-source" },
      { kind: "unreviewed", reason: "remote-source" },
    ]);
  });
});

describe("mirror-resolved bumps", () => {
  test("a proven mirror bump becomes a public bump; an unproven one stays private", async () => {
    verifyMirrorBump.mockImplementation(
      async (_env, _ctx, candidate: DependencyBump) => candidate.name === "proven",
    );

    const result = await stage([mirrorBump("proven"), mirrorBump("unproven")]);

    expect(verifyMirrorBump).toHaveBeenCalledTimes(2);
    expect(verifyMirrorBump.mock.calls[0][2]).toMatchObject({ name: "proven", mirror: {} });
    const [proven, unproven] = result.bumps;
    expect(proven).toEqual({ ...bump("proven"), viaMirror: true });
    expect(unproven).toMatchObject({ privateSource: true, mirror: {} });
    expect(result.outcomes[0]).toMatchObject({ kind: "diffed" });
    expect(result.outcomes[1]).toEqual({ kind: "unreviewed", reason: "private-source" });
    expect(loadDiff).toHaveBeenCalledTimes(1);
    // Approvals, links, and the stored row use the public identity.
    expect(dependencyChangeKey(proven)).toBe(dependencyChangeKey(bump("proven")));
    expect(
      bumpDiffUrl({ BETTER_AUTH_URL: "https://drydock.example" } as Cloudflare.Env)(proven),
    ).toContain("/diff/proven/1.0.0/1.0.1");
    expect(
      bumpDiffUrl({ BETTER_AUTH_URL: "https://drydock.example" } as Cloudflare.Env)(unproven),
    ).toBeNull();
  });

  test("the proof is stored with the progress and asked once per review", async () => {
    verifyMirrorBump.mockResolvedValue(true);
    const first = await stage([mirrorBump("once")]);
    expect(first.progress.bumps[bumpProgressKey(mirrorBump("once"))]).toMatchObject({
      mirrorVerified: true,
    });
    await stage([mirrorBump("once")], { progress: first.progress });
    expect(verifyMirrorBump).toHaveBeenCalledTimes(1);
  });

  test("a failing proof, or public egress off, leaves the bump private", async () => {
    verifyMirrorBump.mockRejectedValue(new Error("registry down"));
    const failed = await stage([mirrorBump("flaky")]);
    expect(failed.outcomes[0]).toEqual({ kind: "unreviewed", reason: "private-source" });

    verifyMirrorBump.mockClear();
    const offline = await stage([mirrorBump("offline")], {
      env: { NPM_REGISTRY: "https://npm.internal.example" },
    });
    expect(verifyMirrorBump).not.toHaveBeenCalled();
    expect(offline.outcomes[0]).toEqual({ kind: "unreviewed", reason: "private-source" });
  });
});
