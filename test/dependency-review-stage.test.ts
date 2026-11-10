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
import { decideBump } from "../server/lib/dependency-review/policy";
import { PublicDiffError } from "../server/lib/public-diff/error";
import type { PublicPackageDiff } from "../server/lib/public-diff";

const { verifyMirrorBump, verifyPublicPin, readCached, loadDiff, listVersions } = vi.hoisted(
  () => ({
    verifyMirrorBump: vi.fn(),
    verifyPublicPin: vi.fn(),
    readCached: vi.fn(),
    loadDiff: vi.fn(),
    listVersions: vi.fn(),
  }),
);

vi.mock("../server/lib/dependency-review/mirror-identity", () => ({
  verifyMirrorBump,
  verifyPublicPin,
}));
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
  for (const fn of [verifyMirrorBump, verifyPublicPin, readCached, loadDiff, listVersions]) {
    fn.mockReset();
  }
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
    expect(result.outcomes.slice(-3)).toEqual(
      Array.from({ length: 3 }, () => ({
        kind: "unreviewed",
        reason: "over-cap",
        pastReviewLimit: true,
      })),
    );

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
    // Each cold diff is written when it starts and when it lands.
    expect(cold.saves).toHaveLength(10);
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
      firstPublishedAt: new Date(NOW - 30 * DAY).toISOString(),
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
    expect(result.outcomes[0]).toEqual({
      kind: "new-package",
      publishedAt: uploaded,
      firstPublishedAt: uploaded,
    });
  });

  test("a failed lookup is stored as unknown, and nothing is fetched with egress off", async () => {
    const failed = await stage([bump("lost", { fromVersion: null })]);
    expect(failed.outcomes[0]).toEqual({
      kind: "new-package",
      publishedAt: null,
      firstPublishedAt: null,
    });

    listVersions.mockClear();
    const offline = await stage([bump("private-install", { fromVersion: null })], {
      env: { NPM_REGISTRY: "https://npm.internal.example" },
    });
    expect(listVersions).not.toHaveBeenCalled();
    expect(offline.outcomes[0]).toEqual({
      kind: "new-package",
      publishedAt: null,
      firstPublishedAt: null,
    });
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
  test("a proven mirror bump becomes a public bump; an unproven one is an unverified pin", async () => {
    verifyMirrorBump.mockImplementation(
      async (_env, _ctx, candidate: DependencyBump) => candidate.name === "proven",
    );

    const result = await stage([mirrorBump("proven"), mirrorBump("unproven")]);

    expect(verifyMirrorBump).toHaveBeenCalledTimes(2);
    expect(verifyMirrorBump.mock.calls[0][2]).toMatchObject({ name: "proven", mirror: {} });
    const [proven, unproven] = result.bumps;
    expect(proven).toEqual({ ...bump("proven"), viaMirror: true });
    expect(unproven).toMatchObject({ privateSource: true, remoteSource: true, mirror: {} });
    expect(result.outcomes[0]).toMatchObject({ kind: "diffed" });
    expect(result.outcomes[1]).toEqual({ kind: "unreviewed", reason: "unverified-pin" });
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

  test("a failing proof, or public egress off, makes the bump an unverified pin", async () => {
    verifyMirrorBump.mockRejectedValue(new Error("registry down"));
    const failed = await stage([mirrorBump("flaky")]);
    expect(failed.outcomes[0]).toEqual({ kind: "unreviewed", reason: "unverified-pin" });

    verifyMirrorBump.mockClear();
    const offline = await stage([mirrorBump("offline")], {
      env: { NPM_REGISTRY: "https://npm.internal.example" },
    });
    expect(verifyMirrorBump).not.toHaveBeenCalled();
    expect(offline.outcomes[0]).toEqual({ kind: "unreviewed", reason: "unverified-pin" });
  });
});

const pinnedMirror = (name: string, toHash: string, lockfilePath: string): DependencyBump =>
  bump(name, {
    lockfilePath,
    privateSource: true,
    mirror: { fromHashes: ["sha512-old"], toHashes: [toHash] },
  });

const pinnedPublic = (name: string, hash: string, overrides: Partial<DependencyBump> = {}) =>
  bump(name, { pinnedHashes: [hash], ...overrides });

describe("a proof belongs to the hashes it proved", () => {
  const honestMirror = pinnedMirror("left-pad", "sha512-honest", "a/package-lock.json");
  const evilMirror = pinnedMirror("left-pad", "sha512-evil", "b/package-lock.json");
  const honestPin = pinnedPublic("left-pad", "sha512-honest", {
    lockfilePath: "a/package-lock.json",
  });
  const evilPin = pinnedPublic("left-pad", "sha512-evil", { lockfilePath: "b/package-lock.json" });
  const honestOnly = async (_env: unknown, _ctx: unknown, candidate: DependencyBump) =>
    (candidate.mirror?.toHashes ?? candidate.pinnedHashes ?? []).includes("sha512-honest");

  test("two pins of the same versions never share a key", () => {
    expect(bumpProgressKey(honestMirror)).not.toBe(bumpProgressKey(evilMirror));
    expect(dependencyChangeKey(honestMirror)).not.toBe(dependencyChangeKey(evilMirror));
    expect(bumpProgressKey(honestPin)).not.toBe(bumpProgressKey(evilPin));
    expect(dependencyChangeKey(honestPin)).not.toBe(dependencyChangeKey(evilPin));
  });

  test("across passes, a hostile mirror pin is proven on its own, not skipped", async () => {
    verifyMirrorBump.mockImplementation(honestOnly);
    // An earlier pass proved the honest pin.
    const first = await stage([honestMirror]);
    expect(first.bumps[0]).toMatchObject({ viaMirror: true });

    const next = await stage([honestMirror, evilMirror], { progress: first.progress });

    expect(verifyMirrorBump).toHaveBeenCalledTimes(2);
    expect(verifyMirrorBump.mock.calls[1][2]).toBe(evilMirror);
    expect(next.bumps[0]).toMatchObject({ viaMirror: true });
    expect(next.bumps[1]).toMatchObject({ privateSource: true, mirror: {} });
    expect(next.bumps[1].viaMirror).toBeUndefined();
    expect(next.outcomes[1]).toEqual({ kind: "unreviewed", reason: "unverified-pin" });
  });

  test.each([
    ["honest first", [honestMirror, evilMirror]],
    ["hostile first", [evilMirror, honestMirror]],
  ])("in one pass, each mirror pin keeps its own proof (%s)", async (_order, bumps) => {
    verifyMirrorBump.mockImplementation(honestOnly);
    const result = await stage(bumps);
    for (const [index, original] of bumps.entries()) {
      const honest = original === honestMirror;
      expect(result.bumps[index].viaMirror).toBe(honest ? true : undefined);
      expect(result.progress.bumps[bumpProgressKey(original)]).toEqual(
        expect.objectContaining({ mirrorVerified: honest }),
      );
    }
  });

  test("across passes, a hostile public pin is proven on its own, not skipped", async () => {
    verifyPublicPin.mockImplementation(honestOnly);
    const first = await stage([honestPin]);
    const next = await stage([honestPin, evilPin], { progress: first.progress });

    expect(verifyPublicPin).toHaveBeenCalledTimes(2);
    expect(next.bumps[0]).toEqual(bump("left-pad", { lockfilePath: "a/package-lock.json" }));
    expect(next.bumps[1]).toMatchObject({ privateSource: true, remoteSource: true });
    expect(next.outcomes[1]).toEqual({ kind: "unreviewed", reason: "unverified-pin" });
  });

  test.each([
    ["honest first", [honestPin, evilPin]],
    ["hostile first", [evilPin, honestPin]],
  ])("in one pass, each public pin keeps its own proof (%s)", async (_order, bumps) => {
    verifyPublicPin.mockImplementation(honestOnly);
    const result = await stage(bumps);
    for (const [index, original] of bumps.entries()) {
      const honest = original === honestPin;
      expect(Boolean(result.bumps[index].privateSource)).toBe(!honest);
      expect(result.progress.bumps[bumpProgressKey(original)]).toEqual(
        expect.objectContaining({ pinVerified: honest }),
      );
    }
  });
});

describe("public pins", () => {
  test("a proven pin is diffed as a plain public bump and keyed as one", async () => {
    verifyPublicPin.mockResolvedValue(true);
    const result = await stage([pinnedPublic("lib", "sha512-x")]);
    expect(result.bumps[0]).toEqual(bump("lib"));
    expect(result.outcomes[0]).toMatchObject({ kind: "diffed" });
    expect(dependencyChangeKey(result.bumps[0])).toBe(dependencyChangeKey(bump("lib")));
  });

  test("a failed pin is never diffed and holds under the age fallback", async () => {
    verifyPublicPin.mockResolvedValue(false);
    const result = await stage([pinnedPublic("lib", "sha512-x")]);
    expect(loadDiff).not.toHaveBeenCalled();
    expect(listVersions).not.toHaveBeenCalled();
    expect(result.bumps[0]).toMatchObject({
      privateSource: true,
      remoteSource: true,
      pinnedHashes: ["sha512-x"],
    });
    expect(result.outcomes[0]).toEqual({ kind: "unreviewed", reason: "unverified-pin" });
    expect(decideBump(result.outcomes[0], DEFAULT_DEPENDENCY_REVIEW_POLICY, NOW)).toEqual({
      status: "hold",
      reasons: ["too-new"],
      evidence: null,
      unreviewed: "unverified-pin",
    });
  });

  test("a proof that throws, or egress off, reads as failed; the proof is asked once", async () => {
    verifyPublicPin.mockRejectedValue(new Error("registry down"));
    const first = await stage([pinnedPublic("lib", "sha512-x")]);
    expect(first.outcomes[0]).toEqual({ kind: "unreviewed", reason: "unverified-pin" });
    await stage([pinnedPublic("lib", "sha512-x")], { progress: first.progress });
    expect(verifyPublicPin).toHaveBeenCalledTimes(1);

    verifyPublicPin.mockClear();
    const offline = await stage([pinnedPublic("lib", "sha512-x")], {
      env: { NPM_REGISTRY: "https://npm.internal.example" },
    });
    expect(verifyPublicPin).not.toHaveBeenCalled();
    expect(offline.outcomes[0]).toEqual({ kind: "unreviewed", reason: "unverified-pin" });
  });

  test("a proven re-pin is a new-package outcome the age fallback dates", async () => {
    verifyPublicPin.mockResolvedValue(true);
    listVersions.mockResolvedValue({
      packageName: "lib",
      versions: [{ version: "1.0.1", publishedAt: new Date(NOW - DAY).toISOString() }],
      suggested: null,
    });
    const repin = pinnedPublic("lib", "sha512-x", { fromVersion: null, repinned: true });
    const result = await stage([repin]);
    expect(loadDiff).not.toHaveBeenCalled();
    expect(result.bumps[0]).toEqual({ ...bump("lib", { fromVersion: null }), repinned: true });
    expect(result.outcomes[0]).toEqual({
      kind: "new-package",
      publishedAt: new Date(NOW - DAY).toISOString(),
      firstPublishedAt: new Date(NOW - DAY).toISOString(),
      repinned: true,
    });
  });

  test("proofs share the per-pass registry lookup budget", async () => {
    verifyPublicPin.mockResolvedValue(true);
    readCached.mockResolvedValue(diffPayload());
    const result = await stage(
      Array.from({ length: 160 }, (_, i) => pinnedPublic(`p-${i}`, `sha512-${i}`)),
    );
    expect(verifyPublicPin).toHaveBeenCalledTimes(150);
    expect(result.complete).toBe(false);
  });
});

describe("the review limit bounds proofs", () => {
  test("bumps past the first 500 reviewable ones are never proven, diffed, or dated", async () => {
    const reviewed = Array.from({ length: 500 }, (_, i) => bump(`r-${i}`));
    const progress = emptyProgress(NOW);
    for (const entry of reviewed) {
      progress.bumps[bumpProgressKey(entry)] = {
        evidence: { ...emptyEvidence(), releaseRisk: "low" },
      };
    }
    const past = [mirrorBump("m-late"), pinnedPublic("p-late", "sha512-late"), bump("d-late")];
    const added = bump("n-late", { fromVersion: null });

    const result = await stage([...reviewed, ...past, added], { progress });

    expect(verifyMirrorBump).not.toHaveBeenCalled();
    expect(verifyPublicPin).not.toHaveBeenCalled();
    expect(loadDiff).not.toHaveBeenCalled();
    expect(listVersions).not.toHaveBeenCalled();
    expect(result.complete).toBe(true);
    expect(result.outcomes.slice(500)).toEqual([
      { kind: "unreviewed", reason: "over-cap", pastReviewLimit: true },
      { kind: "unreviewed", reason: "over-cap", pastReviewLimit: true },
      { kind: "unreviewed", reason: "over-cap", pastReviewLimit: true },
      { kind: "new-package", pastReviewLimit: true },
    ]);
    // Without a proof, the past-limit pins keep their pin-specific identity.
    expect(dependencyChangeKey(result.bumps[501])).toBe(
      dependencyChangeKey(pinnedPublic("p-late", "sha512-late")),
    );
    const verdict = decideBump(result.outcomes[503], DEFAULT_DEPENDENCY_REVIEW_POLICY, NOW);
    expect(verdict).toMatchObject({
      status: "hold",
      reasons: ["young-package"],
      young: { why: "age-unknown" },
      pastReviewLimit: true,
    });
  });
});

describe("a cold diff that takes its pass down", () => {
  test("is retried alone first, then given up on as failed", async () => {
    const poison = bump("poison");
    const others = [bump("a"), bump("b")];
    const progress = emptyProgress(NOW);
    progress.bumps[bumpProgressKey(poison)] = { coldStarts: 1 };
    progress.bumps[bumpProgressKey(others[0])] = { coldStarts: 1 };
    const order: string[] = [];
    loadDiff.mockImplementation(async (_env, _ctx, input: { packageName: string }) => {
      order.push(input.packageName);
      return diffPayload();
    });

    // One suspect runs before anything else; the other waits for a later pass.
    const first = await stage([poison, ...others], { progress });
    expect(order).toEqual(["poison", "b"]);
    expect(first.progress.bumps[bumpProgressKey(poison)]).toMatchObject({ coldStarts: 2 });
    expect(first.outcomes[1]).toEqual({
      kind: "unreviewed",
      reason: "over-cap",
      pastReviewLimit: true,
    });

    // A suspect that took a pass down twice is recorded as failed, not retried.
    order.length = 0;
    const killed = emptyProgress(NOW);
    killed.bumps[bumpProgressKey(poison)] = { coldStarts: 2 };
    const next = await stage([poison, ...others], { progress: killed });
    expect(order).toEqual(["a", "b"]);
    expect(next.outcomes[0]).toMatchObject({ kind: "unreviewed", reason: "failed" });
    expect(next.complete).toBe(true);
  });

  test("its start is written before the diff runs", async () => {
    let savedBeforeDiff: string | undefined;
    const w = writer();
    loadDiff.mockImplementation(async () => {
      savedBeforeDiff = w.saves.at(-1);
      throw new Error("killed");
    });
    await runReviewStage(
      context(),
      [bump("slow")],
      DEFAULT_DEPENDENCY_REVIEW_POLICY,
      w.instance,
      Date.now() + 60_000,
    );
    expect(JSON.parse(savedBeforeDiff ?? "{}").bumps[bumpProgressKey(bump("slow"))]).toEqual({
      coldStarts: 1,
    });
  });
});

function emptyEvidence() {
  return {
    releaseRisk: "low" as const,
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
}

describe("a mirror pin that is not the public release", () => {
  test("holds under the default policy like a failed public pin, never passing as private", async () => {
    verifyMirrorBump.mockResolvedValue(false);
    verifyPublicPin.mockResolvedValue(false);
    const mirrored = mirrorBump("swapped");
    const pinned = pinnedPublic("swapped-public", "sha512-x");

    const result = await stage([mirrored, pinned]);

    expect(loadDiff).not.toHaveBeenCalled();
    expect(listVersions).not.toHaveBeenCalled();
    const verdicts = result.outcomes.map((outcome) =>
      decideBump(outcome, DEFAULT_DEPENDENCY_REVIEW_POLICY, NOW),
    );
    expect(verdicts[0]).toEqual({
      status: "hold",
      reasons: ["too-new"],
      evidence: null,
      unreviewed: "unverified-pin",
    });
    expect(verdicts[0]).toEqual(verdicts[1]);
    // The approval stays bound to the hashes the mirror pinned.
    expect(dependencyChangeKey(result.bumps[0])).toBe(dependencyChangeKey(mirrored));
    expect(dependencyChangeKey(result.bumps[0]).split("\u0000").at(-1)).toMatch(
      /^mirror:[0-9a-f]{64}$/,
    );
  });
});

describe("an entry that should pin and doesn't", () => {
  test("a public bump or re-pin with an empty pin holds as unverified, however old", async () => {
    verifyPublicPin.mockResolvedValue(true);
    listVersions.mockResolvedValue({
      packageName: "x",
      versions: [{ version: "1.0.1", publishedAt: new Date(NOW - 400 * DAY).toISOString() }],
      suggested: null,
    });
    const bumped = bump("no-pin", { pinnedHashes: [] });
    const repin = bump("no-repin", { fromVersion: null, repinned: true, pinnedHashes: [] });

    const result = await stage([bumped, repin]);

    expect(verifyPublicPin).not.toHaveBeenCalled();
    expect(loadDiff).not.toHaveBeenCalled();
    expect(result.outcomes).toEqual([
      { kind: "unreviewed", reason: "unverified-pin" },
      { kind: "unreviewed", reason: "unverified-pin" },
    ]);
    for (const outcome of result.outcomes) {
      expect(decideBump(outcome, DEFAULT_DEPENDENCY_REVIEW_POLICY, NOW)).toMatchObject({
        status: "hold",
        reasons: ["too-new"],
        unreviewed: "unverified-pin",
      });
    }
    // An empty pin is its own identity, never the plain public change.
    expect(dependencyChangeKey(result.bumps[0])).not.toBe(dependencyChangeKey(bump("no-pin")));
    expect(dependencyChangeKey(bumped)).toMatch(/pin:[0-9a-f]{64}$/);
  });

  test("a mirror pin with an empty side fails without a lookup", async () => {
    verifyMirrorBump.mockResolvedValue(true);
    const result = await stage([
      bump("empty", { privateSource: true, mirror: { fromHashes: [], toHashes: ["sha512-b"] } }),
    ]);
    expect(verifyMirrorBump).not.toHaveBeenCalled();
    expect(result.outcomes[0]).toEqual({ kind: "unreviewed", reason: "unverified-pin" });
  });
});

describe("new packages are dated for the young-package rule", () => {
  const NO_AGE: DependencyReviewPolicy = {
    ...DEFAULT_DEPENDENCY_REVIEW_POLICY,
    unreadMinimumAgeDays: null,
  };
  const ago = (days: number) => new Date(NOW - days * DAY).toISOString();
  const fresh = (name: string, overrides: Partial<DependencyBump> = {}) =>
    bump(name, { fromVersion: null, lockfilePinsTree: true, ...overrides });
  const decideAll = (result: Awaited<ReturnType<typeof stage>>, policy = NO_AGE) =>
    result.outcomes.map((outcome) => decideBump(outcome, policy, NOW));

  test("every new package is dated with the age fallback off; a re-pin is not", async () => {
    listVersions.mockResolvedValue({
      packageName: "fresh",
      versions: [
        { version: "1.0.1", publishedAt: ago(2) },
        { version: "0.1.0", publishedAt: ago(400) },
      ],
      suggested: null,
    });
    const result = await stage(
      [fresh("fresh"), fresh("repinned", { repinned: true }), bump("changed")],
      { policy: NO_AGE },
    );

    expect(listVersions).toHaveBeenCalledTimes(1);
    expect(listVersions.mock.calls[0][2]).toBe("fresh");
    expect(result.outcomes[0]).toEqual({
      kind: "new-package",
      publishedAt: ago(2),
      firstPublishedAt: ago(400),
    });
    expect(result.complete).toBe(true);
    expect(decideAll(result)[0]).toMatchObject({
      status: "hold",
      reasons: ["young-package"],
      young: { why: "version-published", at: ago(2) },
    });
  });

  test("the listing's own first publish time wins over its versions' newest uploads", async () => {
    // PyPI: foo 1.0 first uploaded 400 days ago gained a wheel yesterday;
    // the installed 2.0 is 10 days old. Not young.
    listVersions.mockResolvedValue({
      packageName: "foo",
      versions: [
        { version: "2.0", publishedAt: ago(10) },
        { version: "1.0", publishedAt: ago(1) },
      ],
      firstPublishedAt: ago(400),
      suggested: null,
    });
    const result = await stage(
      [fresh("foo", { ecosystem: "pypi", toVersion: "2.0", lockfilePath: "uv.lock" })],
      { policy: NO_AGE },
    );
    expect(result.outcomes[0]).toEqual({
      kind: "new-package",
      publishedAt: ago(10),
      firstPublishedAt: ago(400),
    });
    expect(decideAll(result)[0]).toEqual({ status: "new-package" });
  });

  test("a failed lookup is stored as unknown, holds, and is never retried", async () => {
    const first = await stage([fresh("fresh")], { policy: NO_AGE });
    expect(listVersions).toHaveBeenCalledTimes(1);
    expect(first.outcomes[0]).toEqual({
      kind: "new-package",
      publishedAt: null,
      firstPublishedAt: null,
    });
    expect(decideAll(first)[0]).toMatchObject({
      reasons: ["young-package"],
      young: { why: "age-unknown" },
    });

    listVersions.mockClear();
    await stage([fresh("fresh")], { policy: NO_AGE, progress: first.progress });
    expect(listVersions).not.toHaveBeenCalled();
  });

  test("their lookups share the per-pass registry budget", async () => {
    listVersions.mockResolvedValue({ packageName: "x", versions: [], suggested: null });
    const bumps = Array.from({ length: 200 }, (_, i) => fresh(`dep-${i}`));

    const first = await stage(bumps, { policy: NO_AGE });
    expect(listVersions).toHaveBeenCalledTimes(150);
    expect(first.complete).toBe(false);
    // Unreached in this pass, it reads as unchecked if no pass followed.
    expect(first.outcomes.at(-1)).toEqual({ kind: "new-package", pastReviewLimit: true });

    listVersions.mockClear();
    const second = await stage(bumps, { policy: NO_AGE, progress: first.progress });
    expect(listVersions).toHaveBeenCalledTimes(50);
    expect(second.complete).toBe(true);
  });

  test("a new package past the review limit gets no lookup and holds as young", async () => {
    listVersions.mockResolvedValue({
      packageName: "x",
      versions: [{ version: "1.0.1", publishedAt: ago(400) }],
      suggested: null,
    });
    const filler = Array.from({ length: 500 }, (_, i) => bump(`filler-${i}`));
    readCached.mockResolvedValue(diffPayload());
    const result = await stage(
      [...filler, fresh("late"), fresh("late-repin", { repinned: true })],
      {
        policy: NO_AGE,
      },
    );
    expect(listVersions).not.toHaveBeenCalled();
    expect(result.outcomes.at(-2)).toEqual({ kind: "new-package", pastReviewLimit: true });
    expect(decideAll(result).at(-2)).toMatchObject({
      reasons: ["young-package"],
      young: { why: "age-unknown" },
      pastReviewLimit: true,
    });
    // A re-pin is no new package, wherever it falls.
    expect(result.outcomes.at(-1)).toEqual({
      kind: "new-package",
      pastReviewLimit: true,
      repinned: true,
    });
  });

  test("an unreviewed new package says so; an unreviewed version change does not", async () => {
    const result = await stage(
      [
        fresh("remote", { privateSource: true, remoteSource: true }),
        bump("changed", { privateSource: true, remoteSource: true }),
      ],
      { policy: NO_AGE },
    );
    expect(result.outcomes).toEqual([
      { kind: "unreviewed", reason: "remote-source", newPackage: true },
      { kind: "unreviewed", reason: "remote-source" },
    ]);
  });

  test("the pins-the-tree fact survives the pin and mirror proofs", async () => {
    verifyPublicPin.mockResolvedValue(true);
    verifyMirrorBump.mockResolvedValue(true);
    readCached.mockResolvedValue(diffPayload());
    const result = await stage([
      pinnedPublic("pinned", "sha512-x", { lockfilePinsTree: true }),
      { ...mirrorBump("mirrored"), lockfilePinsTree: true },
    ]);
    expect(result.bumps[0]).not.toHaveProperty("pinnedHashes");
    expect(result.bumps[0].lockfilePinsTree).toBe(true);
    expect(result.bumps[1]).toMatchObject({ viaMirror: true, lockfilePinsTree: true });
  });
});
