import { describe, expect, test } from "vitest";
import type { PublicPackageDiff } from "../server/lib/public-diff";
import { mergeBump, parseLockfile } from "../server/lib/dependency-review/lockfiles";
import {
  decideBump,
  extractBumpEvidence,
  MAX_ADDED_DEPENDENCY_NAMES,
  needsReleaseAge,
  newDependencyScopes,
  YOUNG_PACKAGE_DAYS,
  YOUNG_VERSION_DAYS,
} from "../server/lib/dependency-review/policy";
import { emptyProgress, ProgressWriter } from "../server/lib/dependency-review/progress";
import { summarizePackageJsonDiff, type PackageJsonSummary } from "../server/lib/review";
import {
  DEFAULT_DEPENDENCY_REVIEW_POLICY,
  type BumpEvidence,
  type BumpOutcome,
  type DependencyBump,
  type DependencyEcosystem,
} from "../server/lib/dependency-review/types";
import { POLICY_SWITCHES } from "../src/features/dependency-review/wording";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-11-10T12:00:00.000Z");
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();
const POLICY = DEFAULT_DEPENDENCY_REVIEW_POLICY;

function releaseAdding(
  added: Record<string, string>,
  options: {
    ecosystem?: DependencyEcosystem;
    previous?: PackageJsonSummary;
    staged?: Partial<PackageJsonSummary>;
  } = {},
): PublicPackageDiff {
  const previous = options.previous ?? { name: "host", version: "1.0.0" };
  const staged: PackageJsonSummary = {
    name: "host",
    version: "1.0.1",
    ...previous,
    ...options.staged,
    dependencies: { ...previous.dependencies, ...added },
  };
  staged.version = "1.0.1";
  return {
    ecosystem: options.ecosystem ?? "npm",
    packageName: "host",
    fromVersion: "1.0.0",
    toVersion: "1.0.1",
    fromPackageJson: previous,
    toPackageJson: staged,
    fromFiles: [],
    toFiles: [],
    diff: [{ path: "index.js", status: "modified", flags: [] }],
    packageJsonDiff: summarizePackageJsonDiff(previous, staged),
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

const bump = (name: string, overrides: Partial<DependencyBump> = {}): DependencyBump => ({
  ecosystem: "npm",
  name,
  fromVersion: "1.0.0",
  toVersion: "1.0.1",
  direct: true,
  lockfilePath: "package-lock.json",
  lockfilePinsTree: true,
  ...overrides,
});

const newPackage = (name: string, overrides: Partial<DependencyBump> = {}) =>
  bump(name, { fromVersion: null, direct: false, ...overrides });

const dated = (firstDays: number, versionDays: number): BumpOutcome => ({
  kind: "new-package",
  firstPublishedAt: ago(firstDays),
  publishedAt: ago(versionDays),
});

/**
 * Decides the first bump (a release whose diff is `evidence`) inside a review
 * that also carries `others`, the way the job does.
 */
function decideHost(
  evidence: BumpEvidence,
  others: Array<[DependencyBump, BumpOutcome]>,
  host: Partial<DependencyBump> = {},
  policy = POLICY,
) {
  const bumps = [bump("host", host), ...others.map(([b]) => b)];
  const outcomes: BumpOutcome[] = [
    { kind: "diffed", evidence },
    ...others.map(([, outcome]) => outcome),
  ];
  const scopes = newDependencyScopes(bumps, outcomes, NOW);
  return decideBump(outcomes[0], policy, NOW, scopes[0]);
}

const ADDS_FRESH = extractBumpEvidence(releaseAdding({ fresh: "^1.0.0" }));

describe("added dependency names in the evidence", () => {
  test("are the newly declared names, normalized for the ecosystem and sorted", () => {
    const npm = extractBumpEvidence(
      releaseAdding(
        { "@acme/util": "^1", zeta: "^2", kept: "^3" },
        { previous: { name: "host", version: "1.0.0", peerDependencies: { kept: "^3" } } },
      ),
    );
    // `kept` was already declared in another section: not a new dependency.
    expect(npm.addedDependencies).toEqual({ names: ["@acme/util", "zeta"], complete: true });
    expect(npm.dependenciesAdded).toBe(2);

    const pypi = extractBumpEvidence(releaseAdding({ Foo_Bar: "*" }, { ecosystem: "pypi" }));
    expect(pypi.addedDependencies).toEqual({ names: ["foo-bar"], complete: true });
  });

  test("an invalid name or more than the bound marks the list incomplete", () => {
    const invalid = extractBumpEvidence(releaseAdding({ "../evil": "*", fine: "*" }));
    expect(invalid.addedDependencies).toEqual({ names: ["fine"], complete: false });

    const many = Object.fromEntries(
      Array.from({ length: MAX_ADDED_DEPENDENCY_NAMES + 1 }, (_, i) => [`dep-${i}`, "*"]),
    );
    const cut = extractBumpEvidence(releaseAdding(many));
    expect(cut.addedDependencies?.complete).toBe(false);
    expect(cut.addedDependencies?.names).toHaveLength(MAX_ADDED_DEPENDENCY_NAMES);
    expect(cut.dependenciesAdded).toBe(MAX_ADDED_DEPENDENCY_NAMES + 1);

    // Long names are bounded by their total length too.
    const long = Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [`${i}${"n".repeat(213)}`, "*"]),
    );
    const bounded = extractBumpEvidence(releaseAdding(long));
    expect(bounded.addedDependencies?.complete).toBe(false);
    expect(bounded.addedDependencies?.names.length).toBeLessThan(10);
  });

  test("progress past its size bound drops the names, which then read as unmatched", async () => {
    const saves: string[] = [];
    const writer = new ProgressWriter(emptyProgress(NOW), async (json) => {
      saves.push(json);
      return true;
    });
    const finding = {
      severity: "low" as const,
      ruleId: null,
      file: "f".repeat(300),
      reason: "r".repeat(300),
    };
    const evidence = { ...ADDS_FRESH, findings: Array.from({ length: 5 }, () => finding) };
    for (let i = 0; i < 300; i++) writer.progress.bumps[`bump-${i}`] = { evidence };
    await writer.flush();
    const stored = JSON.parse(saves[0]).bumps["bump-0"].evidence as BumpEvidence;
    expect(stored.addedDependencies).toEqual({ names: [], complete: false });
    expect(decideHost(stored, [])).toMatchObject({ newDependency: { cause: "unmatched" } });
  });
});

describe("an added dependency that brings a young package into the lockfiles holds", () => {
  test("a package created yesterday that enters the lockfile as a new package", () => {
    const verdict = decideHost(ADDS_FRESH, [[newPackage("fresh"), dated(1, 1)]]);
    expect(verdict).toMatchObject({
      status: "hold",
      reasons: ["dependency-added"],
      newDependency: { cause: "young-package", name: "fresh", why: "first-published", at: ago(1) },
    });
  });

  test("an old package whose installed version was published two days ago", () => {
    const verdict = decideHost(ADDS_FRESH, [[newPackage("fresh"), dated(200, 2)]]);
    expect(verdict).toMatchObject({
      status: "hold",
      newDependency: {
        cause: "young-package",
        name: "fresh",
        why: "version-published",
        at: ago(2),
      },
    });
  });

  test.each<[string, DependencyBump, BumpOutcome, string]>([
    [
      "a git or URL source",
      newPackage("fresh", { privateSource: true, remoteSource: true }),
      { kind: "unreviewed", reason: "remote-source" },
      "no-verdict",
    ],
    [
      "an unverified pin",
      newPackage("fresh", { pinnedHashes: ["sha512-x"], privateSource: true, remoteSource: true }),
      { kind: "unreviewed", reason: "unverified-pin" },
      "no-verdict",
    ],
    [
      "a private registry's package",
      newPackage("fresh", { privateSource: true }),
      { kind: "unreviewed", reason: "private-source" },
      "no-verdict",
    ],
    [
      "past the review limit",
      newPackage("fresh"),
      { kind: "new-package", pastReviewLimit: true },
      "age-unknown",
    ],
    [
      "whose publish-time lookup failed",
      newPackage("fresh"),
      { kind: "new-package", publishedAt: null, firstPublishedAt: null },
      "age-unknown",
    ],
    [
      "whose listing has no times",
      newPackage("fresh"),
      { kind: "new-package", publishedAt: ago(400), firstPublishedAt: null },
      "age-unknown",
    ],
    [
      "whose times were never looked up",
      newPackage("fresh"),
      { kind: "new-package" },
      "age-unknown",
    ],
  ])("a new package that is %s, however old", (_, dependency, outcome, why) => {
    const verdict = decideHost(ADDS_FRESH, [[dependency, outcome]]);
    expect(verdict).toMatchObject({
      status: "hold",
      reasons: ["dependency-added"],
      newDependency: { cause: "young-package", name: "fresh", why },
    });
  });

  test("a lockfile that does not pin the whole tree holds on any added dependency", () => {
    // An unhashed requirements file: the old package below proves nothing.
    const verdict = decideHost(ADDS_FRESH, [[newPackage("fresh"), dated(900, 900)]], {
      lockfilePinsTree: undefined,
    });
    expect(verdict).toMatchObject({
      status: "hold",
      reasons: ["dependency-added"],
      newDependency: { cause: "lockfile-unpinned" },
    });
  });

  test.each<[string, BumpEvidence]>([
    ["evidence stored before names were recorded", { ...ADDS_FRESH, addedDependencies: undefined }],
    [
      "a names list cut at its bound",
      { ...ADDS_FRESH, addedDependencies: { names: ["fresh"], complete: false } },
    ],
    [
      "a stored name that is not a valid package name",
      { ...ADDS_FRESH, addedDependencies: { names: ["no spaces"], complete: true } },
    ],
  ])("%s holds: nothing can be matched", (_, evidence) => {
    const verdict = decideHost(evidence, [[newPackage("fresh"), dated(900, 900)]]);
    expect(verdict).toMatchObject({
      status: "hold",
      reasons: ["dependency-added"],
      newDependency: { cause: "unmatched" },
    });
  });

  test("a caller without the review's scope holds on any added dependency, as before", () => {
    const verdict = decideBump({ kind: "diffed", evidence: ADDS_FRESH }, POLICY, NOW);
    expect(verdict).toEqual({
      status: "hold",
      reasons: ["dependency-added"],
      evidence: ADDS_FRESH,
    });
  });

  test("a bump without the stored pins-the-tree fact holds (fail closed)", () => {
    const [scope] = newDependencyScopes(
      [{ ...bump("host"), lockfilePinsTree: undefined }],
      [{ kind: "diffed", evidence: ADDS_FRESH }],
      NOW,
    );
    expect(scope.lockfilePinsTree).toBe(false);
  });
});

describe("names match where the ecosystem says they are the same", () => {
  test("PyPI: case and separators fold (PEP 503)", () => {
    const evidence = extractBumpEvidence(releaseAdding({ Foo_Bar: "*" }, { ecosystem: "pypi" }));
    const verdict = decideHost(
      evidence,
      [[newPackage("foo.BAR", { ecosystem: "pypi", lockfilePath: "uv.lock" }), dated(1, 1)]],
      { ecosystem: "pypi", lockfilePath: "uv.lock" },
    );
    expect(verdict).toMatchObject({
      status: "hold",
      newDependency: { cause: "young-package", name: "foo-bar" },
    });
  });

  test("npm: a scoped name matches itself; another ecosystem's same name does not", () => {
    const evidence = extractBumpEvidence(releaseAdding({ "@acme/util": "^1" }));
    expect(decideHost(evidence, [[newPackage("@acme/util"), dated(1, 1)]])).toMatchObject({
      newDependency: { cause: "young-package", name: "@acme/util" },
    });
    expect(
      decideHost(evidence, [[newPackage("@acme/util", { ecosystem: "pypi" }), dated(1, 1)]]),
    ).toMatchObject({ status: "clear" });
  });

  test("npm: a name that differs by case is another package", () => {
    const evidence = extractBumpEvidence(releaseAdding({ JSONStream: "^1" }));
    // `jsonstream` is a different npm package; the release's `JSONStream`
    // would enter the lockfile under its own name.
    expect(decideHost(evidence, [[newPackage("jsonstream"), dated(1, 1)]])).toMatchObject({
      status: "clear",
    });
    expect(decideHost(evidence, [[newPackage("JSONStream"), dated(1, 1)]])).toMatchObject({
      newDependency: { cause: "young-package", name: "JSONStream" },
    });
  });
});

describe("an added dependency that brings nothing unread does not hold", () => {
  test("the dependency was already in the lockfile", () => {
    // No bump names `fresh`: the lockfile kept the copy it had.
    expect(decideHost(ADDS_FRESH, [])).toEqual({ status: "clear", evidence: ADDS_FRESH });
  });

  test("it arrives only as a version change of a package the lockfile had", () => {
    const verdict = decideHost(ADDS_FRESH, [
      [bump("fresh", { direct: false }), { kind: "diffed", evidence: ADDS_FRESH }],
    ]);
    expect(verdict.status).toBe("clear");
  });

  test("a re-pin of a package the lockfile had is not new to it", () => {
    const repin = newPackage("fresh", { repinned: true });
    expect(decideHost(ADDS_FRESH, [[repin, dated(1, 1)]]).status).toBe("clear");
  });

  test("an optional peer or a PyPI extra that is not installed", () => {
    const peer = extractBumpEvidence(
      releaseAdding(
        {},
        {
          staged: {
            peerDependencies: { "optional-peer": "^1" },
            peerDependenciesMeta: { "optional-peer": { optional: true } },
          },
        },
      ),
    );
    expect(peer.addedDependencies?.names).toEqual(["optional-peer"]);
    expect(decideHost(peer, []).status).toBe("clear");

    // Requires-Dist `socks-helper ; extra == "socks"`: declared, never installed.
    const extra = extractBumpEvidence(
      releaseAdding({ "socks-helper": '; extra == "socks"' }, { ecosystem: "pypi" }),
    );
    expect(decideHost(extra, [], { ecosystem: "pypi", lockfilePath: "uv.lock" }).status).toBe(
      "clear",
    );
  });

  test("a new package first published long ago whose installed version is past a week", () => {
    const old = decideHost(ADDS_FRESH, [
      [newPackage("fresh"), dated(YOUNG_PACKAGE_DAYS + 1, YOUNG_VERSION_DAYS + 1)],
    ]);
    expect(old.status).toBe("clear");
    // Exactly at each bound is old enough; a minute under is young.
    const minute = 60_000;
    const atBound: BumpOutcome = {
      kind: "new-package",
      firstPublishedAt: new Date(NOW - YOUNG_PACKAGE_DAYS * DAY).toISOString(),
      publishedAt: new Date(NOW - YOUNG_VERSION_DAYS * DAY).toISOString(),
    };
    expect(decideHost(ADDS_FRESH, [[newPackage("fresh"), atBound]]).status).toBe("clear");
    expect(
      decideHost(ADDS_FRESH, [
        [
          newPackage("fresh"),
          {
            ...atBound,
            publishedAt: new Date(NOW - YOUNG_VERSION_DAYS * DAY + minute).toISOString(),
          },
        ],
      ]),
    ).toMatchObject({ newDependency: { why: "version-published" } });
  });

  test("other holds the release earns stay", () => {
    const evidence = { ...ADDS_FRESH, installScriptsAdded: 1 };
    expect(decideHost(evidence, [])).toEqual({
      status: "hold",
      reasons: ["install-script-added"],
      evidence,
    });
  });

  test("the switch off never holds an added dependency", () => {
    const verdict = decideHost(
      ADDS_FRESH,
      [[newPackage("fresh"), dated(1, 1)]],
      {},
      {
        ...POLICY,
        holdOnNewDependencies: false,
      },
    );
    expect(verdict.status).toBe("clear");
  });
});

describe("the review-wide context", () => {
  test("lists every young new package once per ecosystem, from any lockfile", () => {
    const bumps = [
      bump("host"),
      newPackage("fresh", { lockfilePath: "a/package-lock.json" }),
      newPackage("fresh", { lockfilePath: "b/package-lock.json" }),
      newPackage("Old_Pkg", { ecosystem: "pypi", lockfilePath: "uv.lock" }),
    ];
    const outcomes: BumpOutcome[] = [
      { kind: "diffed", evidence: ADDS_FRESH },
      dated(400, 400),
      dated(1, 1),
      dated(400, 400),
    ];
    const [scope, , , pypi] = newDependencyScopes(bumps, outcomes, NOW);
    // One copy old enough does not vouch for another copy that is not.
    expect([...scope.youngNewPackages]).toEqual([
      ["fresh", { why: "first-published", at: ago(1) }],
    ]);
    expect(pypi.youngNewPackages.size).toBe(0);
  });

  test("an unread diff with an unheld added dependency still asks for its publish time", () => {
    // `dependency-added` may not hold once the review is known, so it never
    // spares the age fallback's lookup.
    const evidence = { ...ADDS_FRESH, uninspectedFiles: 1 };
    expect(needsReleaseAge({ kind: "diffed", evidence }, POLICY)).toBe(true);
  });
});

describe("collection says which lockfiles pin the whole tree", () => {
  const hash = `--hash=sha256:${"a".repeat(64)}`;

  test("a requirements file pins the tree only in pip's hash-checking mode", () => {
    expect(parseLockfile("requirements", `left-pad==1.0.0 ${hash}\n`).hashChecked).toBe(true);
    expect(parseLockfile("requirements", "left-pad==1.0.0\n").hashChecked).toBe(false);
    expect(
      parseLockfile("requirements", `left-pad==1.0.0 ${hash}\nright-pad==1.0.0\n`).hashChecked,
    ).toBe(false);
    expect(parseLockfile("requirements", "-r base.txt\n").hashChecked).toBe(false);
  });

  test("a change merged from two lockfiles pins the tree only if both do", () => {
    const merged = bump("left-pad");
    mergeBump(merged, { ...bump("left-pad"), lockfilePinsTree: undefined });
    expect(merged.lockfilePinsTree).toBeUndefined();
    const both = bump("left-pad");
    mergeBump(both, bump("left-pad"));
    expect(both.lockfilePinsTree).toBe(true);
  });
});

test("the settings hint states the same thresholds the policy applies", () => {
  const hint = POLICY_SWITCHES.find((entry) => entry.key === "holdOnNewDependencies")?.hint;
  expect(hint).toContain(`${YOUNG_PACKAGE_DAYS} days`);
  expect(hint).toContain(`${YOUNG_VERSION_DAYS} days`);
});
