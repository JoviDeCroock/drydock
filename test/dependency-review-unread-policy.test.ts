import { describe, expect, test } from "vitest";
import type { PublicPackageDiff } from "../server/lib/public-diff";
import {
  ageHold,
  decideBump,
  dependencyReviewPolicyInputError,
  extractBumpEvidence,
  hasUnreadContent,
  needsReleaseAge,
  parseDependencyReviewPolicy,
} from "../server/lib/dependency-review/policy";
import { ageRecheckAt } from "../server/lib/dependency-review/recheck";
import { renderDependencyReviewCheck } from "../server/lib/dependency-review/render";
import {
  DEFAULT_DEPENDENCY_REVIEW_POLICY,
  type BumpEvidence,
  type BumpOutcome,
  type BumpVerdict,
  type DependencyBump,
  type DependencyReviewPolicy,
  type NewDependencyCause,
  type ReviewedBump,
  type UnreviewedReason,
} from "../server/lib/dependency-review/types";
import { parseMinimumAgeInput, parseListInput } from "../src/models/dependency-review";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-11-10T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const ONE_DAY_OLD = iso(NOW - DAY);
const TEN_DAYS_OLD = iso(NOW - 10 * DAY);

const POLICY = DEFAULT_DEPENDENCY_REVIEW_POLICY;
const NO_AGE: DependencyReviewPolicy = { ...POLICY, unreadMinimumAgeDays: null };
// Every capability switch on: a changed binary is still not a capability.
const EVERY_SWITCH: DependencyReviewPolicy = { ...NO_AGE, holdOnNewBinCommands: true };

function diffWith(diff: PublicPackageDiff["diff"]): PublicPackageDiff {
  return {
    ecosystem: "npm",
    packageName: "esbuild-darwin-arm64",
    fromVersion: "1.0.0",
    toVersion: "1.0.1",
    fromPackageJson: null,
    toPackageJson: null,
    fromFiles: [],
    toFiles: [],
    diff,
    packageJsonDiff: {
      name: "esbuild-darwin-arm64",
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
    cachedAt: "2026-11-10T00:00:00.000Z",
  };
}

const CLEAN = extractBumpEvidence(diffWith([{ path: "index.js", status: "modified", flags: [] }]));
const SWAPPED_BINARY = extractBumpEvidence(
  diffWith([
    { path: "bin/esbuild.node", status: "modified", flags: ["binary", "native-macho"] },
    { path: "lib/main.js", status: "modified", flags: [] },
  ]),
);

const bump = (overrides: Partial<DependencyBump> = {}): DependencyBump => ({
  ecosystem: "npm",
  name: "left-pad",
  fromVersion: "1.0.0",
  toVersion: "1.0.1",
  direct: true,
  lockfilePath: "package-lock.json",
  ...overrides,
});

describe("changed native binaries", () => {
  test("count as changed, not added and not uninspected", () => {
    expect(SWAPPED_BINARY).toMatchObject({
      nativeBinariesAdded: 0,
      nativeBinariesChanged: 1,
      uninspectedFiles: 0,
    });
    expect(hasUnreadContent(SWAPPED_BINARY)).toBe(true);
    expect(hasUnreadContent(CLEAN)).toBe(false);
  });

  test("a swapped binary is no capability hold, even with every capability switch on", () => {
    expect(decideBump({ kind: "diffed", evidence: SWAPPED_BINARY }, EVERY_SWITCH, NOW)).toEqual({
      status: "clear",
      evidence: SWAPPED_BINARY,
    });
  });

  test("holds as unread content under holdOnUninspectedFiles", () => {
    expect(
      decideBump(
        { kind: "diffed", evidence: SWAPPED_BINARY },
        { ...NO_AGE, holdOnUninspectedFiles: true },
        NOW,
      ),
    ).toMatchObject({ status: "hold", reasons: ["uninspected-files"] });
  });

  test("evidence stored before the field existed reads as none changed", () => {
    const { nativeBinariesChanged: _dropped, ...legacy } = CLEAN;
    expect(hasUnreadContent(legacy as BumpEvidence)).toBe(false);
    expect(decideBump({ kind: "diffed", evidence: legacy as BumpEvidence }, POLICY, NOW)).toEqual({
      status: "clear",
      evidence: legacy,
    });
  });
});

describe("age fallback", () => {
  test("holds while younger than the minimum age, and passes from passesAt on", () => {
    const publishedAt = ONE_DAY_OLD;
    const passesAt = iso(Date.parse(publishedAt) + 3 * DAY);
    expect(ageHold(POLICY, publishedAt, NOW)).toEqual({ passesAt });
    expect(ageHold(POLICY, publishedAt, Date.parse(passesAt) - 1)).toEqual({ passesAt });
    expect(ageHold(POLICY, publishedAt, Date.parse(passesAt))).toBeNull();
    expect(ageHold(NO_AGE, publishedAt, NOW)).toBeNull();
  });

  test("an unknown or unparseable publish time holds without a passesAt", () => {
    expect(ageHold(POLICY, null, NOW)).toEqual({});
    expect(ageHold(POLICY, undefined, NOW)).toEqual({});
    expect(ageHold(POLICY, "yesterday", NOW)).toEqual({});
  });

  test.each<UnreviewedReason>(["over-cap", "timed-out", "not-found", "unsupported", "failed"])(
    "an unreviewed public bump (%s) holds as too new, then passes unreviewed",
    (reason) => {
      expect(
        decideBump({ kind: "unreviewed", reason, publishedAt: ONE_DAY_OLD }, POLICY, NOW),
      ).toMatchObject({
        status: "hold",
        reasons: ["too-new"],
        evidence: null,
        unreviewed: reason,
        passesAt: iso(NOW + 2 * DAY),
      });
      expect(
        decideBump({ kind: "unreviewed", reason, publishedAt: TEN_DAYS_OLD }, POLICY, NOW),
      ).toEqual({ status: "unreviewed", unreviewed: reason });
      // Not looked up, or the lookup failed: unknown holds until approved.
      const unknown = decideBump({ kind: "unreviewed", reason }, POLICY, NOW);
      expect(unknown).toMatchObject({ status: "hold", reasons: ["too-new"] });
      expect(unknown).not.toHaveProperty("passesAt");
    },
  );

  test("a new package holds as too new, then passes as a new package", () => {
    expect(decideBump({ kind: "new-package", publishedAt: ONE_DAY_OLD }, POLICY, NOW)).toEqual({
      status: "hold",
      reasons: ["too-new"],
      evidence: null,
      passesAt: iso(NOW + 2 * DAY),
    });
    expect(decideBump({ kind: "new-package", publishedAt: TEN_DAYS_OLD }, POLICY, NOW)).toEqual({
      status: "new-package",
    });
  });

  test("a git, URL, or tarball source never ages out while the fallback is on", () => {
    const remote: BumpOutcome = {
      kind: "unreviewed",
      reason: "remote-source",
      publishedAt: TEN_DAYS_OLD,
    };
    const verdict = decideBump(remote, POLICY, NOW);
    expect(verdict).toMatchObject({
      status: "hold",
      reasons: ["too-new"],
      unreviewed: "remote-source",
    });
    expect(verdict).not.toHaveProperty("passesAt");
    expect(decideBump(remote, NO_AGE, NOW)).toEqual({
      status: "unreviewed",
      unreviewed: "remote-source",
    });
  });

  test("a private-registry bump is exempt: only holdOnUnreviewed holds it", () => {
    const priv: BumpOutcome = { kind: "unreviewed", reason: "private-source" };
    expect(decideBump(priv, POLICY, NOW)).toEqual({
      status: "unreviewed",
      unreviewed: "private-source",
    });
    expect(decideBump(priv, { ...POLICY, holdOnUnreviewed: true }, NOW)).toMatchObject({
      status: "hold",
      reasons: ["unreviewed"],
    });
    expect(needsReleaseAge(priv, POLICY)).toBe(false);
  });

  test("a reviewed bump with unread content holds while young, and lists as passed after", () => {
    expect(
      decideBump(
        { kind: "diffed", evidence: SWAPPED_BINARY, publishedAt: ONE_DAY_OLD },
        POLICY,
        NOW,
      ),
    ).toMatchObject({ status: "hold", reasons: ["too-new"], evidence: SWAPPED_BINARY });
    expect(
      decideBump(
        { kind: "diffed", evidence: SWAPPED_BINARY, publishedAt: TEN_DAYS_OLD },
        POLICY,
        NOW,
      ),
    ).toEqual({ status: "clear", evidence: SWAPPED_BINARY });
    // A fully read diff needs no timer, however new.
    expect(
      decideBump({ kind: "diffed", evidence: CLEAN, publishedAt: ONE_DAY_OLD }, POLICY, NOW),
    ).toEqual({ status: "clear", evidence: CLEAN });
  });

  test("the switches that hold outright take precedence over the timer", () => {
    expect(
      decideBump(
        { kind: "unreviewed", reason: "not-found", publishedAt: ONE_DAY_OLD },
        { ...POLICY, holdOnUnreviewed: true },
        NOW,
      ),
    ).toEqual({ status: "hold", reasons: ["unreviewed"], evidence: null, unreviewed: "not-found" });
    expect(
      decideBump(
        { kind: "new-package", publishedAt: TEN_DAYS_OLD },
        { ...POLICY, holdOnNewPackages: true },
        NOW,
      ),
    ).toEqual({ status: "hold", reasons: ["new-package"], evidence: null });
    expect(
      decideBump(
        { kind: "diffed", evidence: SWAPPED_BINARY, publishedAt: TEN_DAYS_OLD },
        { ...POLICY, holdOnUninspectedFiles: true },
        NOW,
      ),
    ).toEqual({ status: "hold", reasons: ["uninspected-files"], evidence: SWAPPED_BINARY });
    // A diff that already holds gets no age reason on top.
    const scripted = { ...SWAPPED_BINARY, installScriptsAdded: 1 };
    expect(
      decideBump({ kind: "diffed", evidence: scripted, publishedAt: ONE_DAY_OLD }, POLICY, NOW),
    ).toEqual({ status: "hold", reasons: ["install-script-added"], evidence: scripted });
  });

  test("needsReleaseAge asks only where the verdict reads the publish time", () => {
    expect(needsReleaseAge({ kind: "new-package" }, POLICY)).toBe(true);
    expect(needsReleaseAge({ kind: "new-package" }, NO_AGE)).toBe(false);
    expect(needsReleaseAge({ kind: "new-package" }, { ...POLICY, holdOnNewPackages: true })).toBe(
      false,
    );
    expect(needsReleaseAge({ kind: "unreviewed", reason: "over-cap" }, POLICY)).toBe(true);
    expect(needsReleaseAge({ kind: "unreviewed", reason: "remote-source" }, POLICY)).toBe(false);
    expect(
      needsReleaseAge(
        { kind: "unreviewed", reason: "over-cap" },
        { ...POLICY, holdOnUnreviewed: true },
      ),
    ).toBe(false);
    expect(needsReleaseAge({ kind: "diffed", evidence: CLEAN }, POLICY)).toBe(false);
    expect(needsReleaseAge({ kind: "diffed", evidence: SWAPPED_BINARY }, POLICY)).toBe(true);
    expect(
      needsReleaseAge(
        { kind: "diffed", evidence: { ...SWAPPED_BINARY, installScriptsAdded: 1 } },
        POLICY,
      ),
    ).toBe(false);
  });
});

describe("age recheck scheduling", () => {
  const tooNew = (passesAt?: string, approved = false): ReviewedBump => ({
    bump: bump({ name: `p-${passesAt ?? "unknown"}` }),
    verdict: {
      status: "hold",
      reasons: ["too-new"],
      evidence: null,
      ...(passesAt ? { passesAt } : {}),
    },
    approved,
  });
  const later = iso(NOW + 2 * DAY);
  const sooner = iso(NOW + DAY);

  test("runs at the earliest passesAt when every open hold is an age hold", () => {
    expect(ageRecheckAt([tooNew(later), tooNew(sooner)], "held", false)).toBe(sooner);
    // An approved hold is not open, so it doesn't count.
    expect(ageRecheckAt([tooNew(later), tooNew(undefined, true)], "held", false)).toBe(later);
  });

  test("never runs for an unknown age, another reason, coverage holds, or a passing review", () => {
    expect(ageRecheckAt([tooNew(later), tooNew()], "held", false)).toBeNull();
    const scripted: ReviewedBump = {
      bump: bump(),
      verdict: { status: "hold", reasons: ["install-script-added"], evidence: null },
      approved: false,
    };
    expect(ageRecheckAt([tooNew(later), scripted], "held", false)).toBeNull();
    expect(ageRecheckAt([tooNew(later)], "held", true)).toBeNull();
    expect(ageRecheckAt([], "held", false)).toBeNull();
    expect(ageRecheckAt([tooNew(later)], "clear", false)).toBeNull();
  });
});

describe("unread content is never called clear", () => {
  const diffUrl = (b: DependencyBump) => `https://drydock.example/diff/${b.name}`;
  const render = (bumps: ReviewedBump[], conclusion: "clear" | "held" = "clear") =>
    renderDependencyReviewCheck({
      bumps,
      conclusion,
      diffUrl,
      approvedBy: null,
      unreadLockfiles: [],
    });
  const clear: ReviewedBump = {
    bump: bump({ name: "read-fully" }),
    verdict: { status: "clear", evidence: CLEAN },
    approved: false,
  };
  const swapped: ReviewedBump = {
    bump: bump({ name: "swapped-binary" }),
    verdict: { status: "clear", evidence: SWAPPED_BINARY },
    approved: false,
  };

  test("lists a passing bump with unread changes in its own group, saying what went unread", () => {
    const { title, summary } = render([clear, swapped]);
    expect(title).toBe("No updates held");
    expect(summary).toContain("### Passed with unread changes (1)");
    expect(summary).toContain("changes 1 native binary no rule reads");
    expect(summary).toContain("### Clear (1)");
    const clearSection = summary.slice(summary.indexOf("### Clear"));
    expect(clearSection).not.toContain("swapped-binary");
    expect(render([swapped]).title).toBe("No updates held");
    expect(render([clear]).title).toBe("Update clear");
  });

  test("an age hold says when it passes, or that the publish time is unknown", () => {
    const held = (verdict: ReviewedBump["verdict"], overrides: Partial<DependencyBump> = {}) => ({
      bump: bump(overrides),
      verdict,
      approved: false,
    });
    const { summary } = render(
      [
        held({
          status: "hold",
          reasons: ["too-new"],
          evidence: SWAPPED_BINARY,
          passesAt: "2026-11-13T09:30:00.000Z",
        }),
        held(
          { status: "hold", reasons: ["too-new"], evidence: null, unreviewed: "over-cap" },
          { name: "capped" },
        ),
        held(
          { status: "hold", reasons: ["too-new"], evidence: null, unreviewed: "remote-source" },
          { name: "from-git" },
        ),
        held(
          {
            status: "hold",
            reasons: ["too-new"],
            evidence: null,
            passesAt: "2026-11-12T00:00:00.000Z",
          },
          { name: "brand-new", fromVersion: null },
        ),
      ],
      "held",
    );
    expect(summary).toContain(
      "changes 1 native binary no rule reads; younger than the minimum age for unread updates; passes 2026-11-13 09:30 UTC",
    );
    expect(summary).toContain(
      "no Drydock verdict (over the per-PR review limit); its publish time is unknown, so it holds until approved",
    );
    expect(summary).toContain("a git, URL, or tarball source has no publish time");
    expect(summary).toContain("new package with no previous version to compare; younger than");
  });
});

describe("settings validation", () => {
  test("accepts the defaults, off, and in-range ages", () => {
    expect(dependencyReviewPolicyInputError({ ...POLICY })).toBeNull();
    expect(dependencyReviewPolicyInputError({ unreadMinimumAgeDays: null })).toBeNull();
    expect(dependencyReviewPolicyInputError({ unreadMinimumAgeDays: 90 })).toBeNull();
    expect(dependencyReviewPolicyInputError({})).toBeNull();
  });

  test.each([0, 91, 2.5, "3", -1])("refuses minimum age %j", (age) => {
    expect(dependencyReviewPolicyInputError({ unreadMinimumAgeDays: age })).toMatch(
      /whole number of days from 1 to 90/,
    );
  });

  test.each([
    "http://mirror.example/npm/",
    "https://user:pw@mirror.example/npm/",
    "https://mirror.example/npm/?token=x",
    "https://mirror.example/npm/#x",
    "not a url",
    42,
  ])("refuses mirror %j", (mirror) => {
    expect(dependencyReviewPolicyInputError({ publicMirrors: [mirror] })).toMatch(/mirror URLs/);
  });

  test("refuses more than ten mirrors and a non-list", () => {
    const eleven = Array.from({ length: 11 }, (_, i) => `https://m${i}.example/npm/`);
    expect(dependencyReviewPolicyInputError({ publicMirrors: eleven })).toMatch(/up to 10/);
    expect(
      dependencyReviewPolicyInputError({ publicMirrors: "https://m.example/" }),
    ).not.toBeNull();
    expect(
      dependencyReviewPolicyInputError({ publicMirrors: ["https://m.example/npm"] }),
    ).toBeNull();
  });

  test("the settings form reads typed days and mirror lists", () => {
    expect(parseMinimumAgeInput("")).toBeNull();
    expect(parseMinimumAgeInput(" 7 ")).toBe(7);
    expect(parseMinimumAgeInput("0")).toBe("invalid");
    expect(parseMinimumAgeInput("91")).toBe("invalid");
    expect(parseMinimumAgeInput("3.5")).toBe("invalid");
    expect(parseListInput("https://a.example/npm/, https://b.example/pypi/\n")).toEqual([
      "https://a.example/npm/",
      "https://b.example/pypi/",
    ]);
  });
});

describe("added native binaries", () => {
  const ADDED_BINARY = extractBumpEvidence(
    diffWith([
      { path: "bin/new.node", status: "added", flags: ["binary", "native-macho"] },
      { path: "lib/main.js", status: "modified", flags: [] },
    ]),
  );
  const NATIVE_OFF: DependencyReviewPolicy = { ...POLICY, holdOnNativeBinaries: false };

  test("are unread content when the policy doesn't hold them as a capability", () => {
    expect(ADDED_BINARY).toMatchObject({ nativeBinariesAdded: 1, uninspectedFiles: 0 });
    expect(hasUnreadContent(ADDED_BINARY)).toBe(true);
    expect(hasUnreadContent(ADDED_BINARY, { nativeAddedHeld: true })).toBe(false);
  });

  test("feed the age fallback when native binaries are not held", () => {
    expect(
      decideBump(
        { kind: "diffed", evidence: ADDED_BINARY, publishedAt: ONE_DAY_OLD },
        NATIVE_OFF,
        NOW,
      ),
    ).toMatchObject({ status: "hold", reasons: ["too-new"], passesAt: iso(NOW + 2 * DAY) });
    expect(needsReleaseAge({ kind: "diffed", evidence: ADDED_BINARY }, NATIVE_OFF)).toBe(true);
  });

  test("hold under holdOnUninspectedFiles only when not already held as a capability", () => {
    const uninspectedOn = { ...NO_AGE, holdOnUninspectedFiles: true };
    expect(
      decideBump(
        { kind: "diffed", evidence: ADDED_BINARY },
        { ...uninspectedOn, holdOnNativeBinaries: false },
        NOW,
      ),
    ).toMatchObject({ status: "hold", reasons: ["uninspected-files"] });
    expect(
      decideBump({ kind: "diffed", evidence: ADDED_BINARY }, uninspectedOn, NOW),
    ).toMatchObject({ status: "hold", reasons: ["native-binary-added"] });
  });

  test("a passing release that adds one is never listed clear", () => {
    const verdict = decideBump(
      { kind: "diffed", evidence: ADDED_BINARY },
      { ...NATIVE_OFF, unreadMinimumAgeDays: null },
      NOW,
    );
    expect(verdict.status).toBe("clear");
    const { title, summary } = renderDependencyReviewCheck({
      bumps: [{ bump: bump(), verdict, approved: false }],
      conclusion: "clear",
      diffUrl: () => null,
      approvedBy: null,
      unreadLockfiles: [],
    });
    expect(title).toBe("No updates held");
    expect(summary).toContain("### Passed with unread changes (1)");
    expect(summary).toContain("adds 1 native binary no rule reads");
    expect(summary).not.toContain("### Clear");
  });
});

describe("pins, re-pins, and the review limit in the summary", () => {
  const render = (bumps: ReviewedBump[], conclusion: "clear" | "held") =>
    renderDependencyReviewCheck({
      bumps,
      conclusion,
      diffUrl: () => null,
      approvedBy: null,
      unreadLockfiles: [],
    });

  test("an unverified pin holds until approved, with no publish time to wait out", () => {
    const verdict = decideBump({ kind: "unreviewed", reason: "unverified-pin" }, POLICY, NOW);
    expect(verdict).toEqual({
      status: "hold",
      reasons: ["too-new"],
      evidence: null,
      unreviewed: "unverified-pin",
    });
    expect(needsReleaseAge({ kind: "unreviewed", reason: "unverified-pin" }, POLICY)).toBe(false);
  });

  const AGE_HOLD: Extract<BumpVerdict, { status: "hold" }> = {
    status: "hold",
    reasons: ["too-new"],
    evidence: null,
    unreviewed: "unverified-pin",
  };
  const LOOKED_UP =
    "no Drydock verdict (Drydock could not match the hashes pinned for this update to the public registry's release); it holds until approved; Re-run checks again if the registry was unreachable";
  const SCOPE_ADVICE =
    ", and an npm package your organization hosts itself belongs under private npm scopes";
  // A phrase ends its line: nothing more is said after it.
  const lines = (summary: string) => summary.split("\n");
  const endsWith = (text: string) => new RegExp(`${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
  const UNPINNED =
    "the lockfile pins no hash Drydock can check for this update, so it cannot be tied to the public release";

  test.each<[string, Partial<DependencyBump>, string]>([
    ["an npm public pin", { pinnedHashes: ["sha512-a"] }, `${LOOKED_UP}${SCOPE_ADVICE}`],
    [
      "an npm mirror pin",
      { privateSource: true, mirror: { fromHashes: ["sha512-a"], toHashes: ["sha512-b"] } },
      `${LOOKED_UP}${SCOPE_ADVICE}`,
    ],
    [
      "a PyPI pin",
      { ecosystem: "pypi", lockfilePath: "uv.lock", pinnedHashes: ["sha256:a"] },
      LOOKED_UP,
    ],
  ])("%s that failed its lookup offers Re-run", (_, overrides, expected) => {
    const { summary } = render(
      [{ bump: bump(overrides), verdict: AGE_HOLD, approved: false }],
      "held",
    );
    expect(lines(summary)).toContainEqual(expect.stringMatching(endsWith(expected)));
  });

  test.each<[string, Partial<DependencyBump>]>([
    ["a public entry", { pinnedHashes: [] }],
    ["a re-pin", { fromVersion: null, repinned: true, pinnedHashes: [] }],
    [
      "a mirror entry with an unpinned side",
      { privateSource: true, mirror: { fromHashes: [], toHashes: ["sha512-b"] } },
    ],
  ])("%s that pins nothing checkable says so and never offers Re-run", (_, overrides) => {
    const unpinned = bump(overrides);
    const held = render([{ bump: unpinned, verdict: AGE_HOLD, approved: false }], "held");
    expect(lines(held.summary)).toContainEqual(
      expect.stringMatching(endsWith(`no Drydock verdict (${UNPINNED}); it holds until approved`)),
    );
    const holdOnUnreviewed = render(
      [
        {
          bump: unpinned,
          verdict: { ...AGE_HOLD, reasons: ["unreviewed"] },
          approved: false,
        },
      ],
      "held",
    );
    expect(holdOnUnreviewed.summary).toContain(`no Drydock verdict (${UNPINNED})`);
    const noFallback = render(
      [
        {
          bump: unpinned,
          verdict: { status: "unreviewed", unreviewed: "unverified-pin" },
          approved: false,
        },
      ],
      "clear",
    );
    expect(lines(noFallback.summary)).toContainEqual(
      expect.stringMatching(endsWith(`: ${UNPINNED}`)),
    );
    for (const { summary } of [held, holdOnUnreviewed, noFallback]) {
      expect(summary).not.toContain("Re-run checks again");
      expect(summary).not.toContain("private npm scopes");
      expect(summary).not.toContain("could not match");
    }
  });

  test("a re-pin reads as the same version with a new pin, not a new package", () => {
    const repin = bump({ fromVersion: null, repinned: true });
    const passed = render(
      [{ bump: repin, verdict: { status: "new-package" }, approved: false }],
      "clear",
    ).summary;
    expect(passed).toContain("### Same version, new pin (1)");
    expect(passed).not.toContain("### New packages");

    const held = render(
      [
        {
          bump: repin,
          verdict: { status: "hold", reasons: ["new-package"], evidence: null },
          approved: false,
        },
        {
          bump: bump({ name: "aged", fromVersion: null, repinned: true }),
          verdict: decideBump({ kind: "new-package", publishedAt: ONE_DAY_OLD }, POLICY, NOW),
          approved: false,
        },
      ],
      "held",
    ).summary;
    expect(held).toContain("`left-pad` `1.0.1`: same version, new pin");
    expect(held).toContain("`aged` `1.0.1`: same version, new pin; younger than");
    expect(held).not.toContain("new package with no previous version");
  });

  test("a bump past the review limit says so instead of an unknown publish time", () => {
    const capped = decideBump(
      { kind: "unreviewed", reason: "over-cap", pastReviewLimit: true },
      POLICY,
      NOW,
    );
    const added = decideBump({ kind: "new-package", pastReviewLimit: true }, POLICY, NOW);
    expect(capped).toMatchObject({ status: "hold", pastReviewLimit: true });
    expect(added).toMatchObject({ status: "hold", pastReviewLimit: true });
    // A known publish time wins over the marker.
    expect(
      decideBump(
        { kind: "new-package", publishedAt: ONE_DAY_OLD, pastReviewLimit: true },
        POLICY,
        NOW,
      ),
    ).not.toHaveProperty("pastReviewLimit");
    const { summary } = render(
      [
        { bump: bump({ name: "capped" }), verdict: capped, approved: false },
        { bump: bump({ name: "added", fromVersion: null }), verdict: added, approved: false },
      ],
      "held",
    );
    expect(summary).toContain(
      "no Drydock verdict (over the per-PR review limit); Drydock did not look up its age, so it holds until approved",
    );
    expect(summary).toContain(
      "new package with no previous version to compare; past the per-PR review limit, so Drydock did not look up its age",
    );
    expect(summary).not.toContain("publish time is unknown");
  });
});

describe("an added dependency's hold says which and why", () => {
  const render = (verdict: Extract<BumpVerdict, { status: "hold" }>) =>
    renderDependencyReviewCheck({
      bumps: [{ bump: bump(), verdict, approved: false }],
      conclusion: "held",
      diffUrl: () => null,
      approvedBy: null,
      unreadLockfiles: [],
    }).summary;
  const held = (newDependency?: NewDependencyCause) => ({
    status: "hold" as const,
    reasons: ["dependency-added" as const],
    evidence: CLEAN,
    ...(newDependency ? { newDependency } : {}),
  });
  const at = "2026-11-04T09:30:00.000Z";

  test.each<[string, NewDependencyCause | undefined, string]>([
    [
      "a young package",
      { cause: "young-package", name: "fresh", why: "first-published", at },
      "adds a dependency on `fresh`, a package new to the lockfile and first published 2026-11-04 09:30 UTC",
    ],
    [
      "a young version",
      { cause: "young-package", name: "@acme/util", why: "version-published", at },
      "adds a dependency on `@acme/util`, a package new to the lockfile whose installed version was published 2026-11-04 09:30 UTC",
    ],
    [
      "an unknown age",
      { cause: "young-package", name: "fresh", why: "age-unknown" },
      "adds a dependency on `fresh`, a package new to the lockfile whose age Drydock could not establish",
    ],
    [
      "no verdict",
      { cause: "young-package", name: "fresh", why: "no-verdict" },
      "adds a dependency on `fresh`, a package new to the lockfile with no Drydock verdict",
    ],
    [
      "a lockfile that does not pin the tree",
      { cause: "lockfile-unpinned" },
      "adds a dependency; this lockfile does not pin transitive dependencies, so Drydock cannot see what it installs",
    ],
    [
      "names it could not match",
      { cause: "unmatched" },
      "adds a dependency Drydock could not match against the lockfile",
    ],
    ["a verdict stored before the cause was recorded", undefined, ": adds a dependency"],
  ])("%s", (_, cause, phrase) => {
    expect(render(held(cause))).toContain(phrase);
  });
});

describe("registry settings validation", () => {
  test("private registries follow the mirror rules and normalize the same way", () => {
    expect(
      dependencyReviewPolicyInputError({ privateRegistries: ["https://npm.corp.example/npm"] }),
    ).toBeNull();
    expect(
      dependencyReviewPolicyInputError({ privateRegistries: ["http://npm.corp.example/"] }),
    ).toMatch(/private registry URLs/);
    const eleven = Array.from({ length: 11 }, (_, i) => `https://r${i}.example/`);
    expect(dependencyReviewPolicyInputError({ privateRegistries: eleven })).toMatch(/up to 10/);
    expect(
      parseDependencyReviewPolicy({
        privateRegistries: ["https://npm.corp.example/npm", "https://npm.corp.example/npm/", 7],
      }).privateRegistries,
    ).toEqual(["https://npm.corp.example/npm/"]);
  });

  test("a URL can't be both a mirror and a private registry", () => {
    expect(
      dependencyReviewPolicyInputError({
        publicMirrors: ["https://artifacts.example/npm/"],
        privateRegistries: ["https://artifacts.example/"],
      }),
    ).toMatch(/both a mirror and a private registry/);
    expect(
      dependencyReviewPolicyInputError({
        publicMirrors: ["https://artifacts.example/npm-remote/"],
        privateRegistries: ["https://artifacts.example/npm-private/"],
      }),
    ).toBeNull();
  });

  test.each(["corp", "@", "@.corp", "@_corp", "@corp/pkg", "@co rp", 7])(
    "refuses private scope %j",
    (scope) => {
      expect(dependencyReviewPolicyInputError({ privateScopes: [scope] })).toMatch(/npm scopes/);
    },
  );

  test("private scopes are lowercased, deduped, and bounded", () => {
    expect(
      dependencyReviewPolicyInputError({ privateScopes: ["@Corp", "@corp-tools"] }),
    ).toBeNull();
    expect(
      dependencyReviewPolicyInputError({
        privateScopes: Array.from({ length: 51 }, (_, i) => `@s${i}`),
      }),
    ).toMatch(/up to 50/);
    expect(
      parseDependencyReviewPolicy({ privateScopes: ["@Corp", "@corp", "bad", "@corp-tools"] })
        .privateScopes,
    ).toEqual(["@corp", "@corp-tools"]);
    expect(parseDependencyReviewPolicy({}).privateScopes).toEqual([]);
  });
});

describe("an aged release that adds an unheld native binary", () => {
  test("passes the age fallback but is listed as unread, and the title is not clear", () => {
    const evidence = extractBumpEvidence(
      diffWith([{ path: "bin/new.node", status: "added", flags: ["binary", "native-elf"] }]),
    );
    const policy = { ...POLICY, holdOnNativeBinaries: false };
    const young = decideBump({ kind: "diffed", evidence, publishedAt: ONE_DAY_OLD }, policy, NOW);
    expect(young).toMatchObject({ status: "hold", reasons: ["too-new"] });
    const aged = decideBump({ kind: "diffed", evidence, publishedAt: TEN_DAYS_OLD }, policy, NOW);
    expect(aged).toEqual({ status: "clear", evidence });

    const { title, summary } = renderDependencyReviewCheck({
      bumps: [{ bump: bump({ name: "gains-a-binary" }), verdict: aged, approved: false }],
      conclusion: "clear",
      diffUrl: () => null,
      approvedBy: null,
      unreadLockfiles: [],
    });
    expect(title).toBe("No updates held");
    expect(summary).toContain("### Passed with unread changes (1)");
    expect(summary).toContain("adds 1 native binary no rule reads");
    expect(summary).not.toContain("### Clear");
  });
});
