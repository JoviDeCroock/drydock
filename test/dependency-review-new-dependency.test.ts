import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import type { PublicPackageDiff } from "../server/lib/public-diff";
import { bumpIdentityKey } from "../server/lib/dependency-review/identity";
import {
  diffLockfileChanges,
  mergeBump,
  parseLockfile,
  PUBLIC_ROUTE,
  routedBump,
} from "../server/lib/dependency-review/lockfiles";
import {
  decideBump,
  evaluateBumpEvidence,
  extractBumpEvidence,
  needsReleaseAge,
  YOUNG_PACKAGE_DAYS,
  YOUNG_VERSION_DAYS,
} from "../server/lib/dependency-review/policy";
import { summarizePackageJsonDiff, type PackageJsonSummary } from "../server/lib/review";
import {
  DEFAULT_DEPENDENCY_REVIEW_POLICY,
  type BumpEvidence,
  type BumpOutcome,
  type BumpVerdict,
  type DependencyBump,
  type DependencyEcosystem,
  type DependencyReviewPolicy,
  type LockfileKind,
} from "../server/lib/dependency-review/types";
import { POLICY_SWITCHES } from "../src/features/dependency-review/wording";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-11-10T12:00:00.000Z");
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();
const POLICY = DEFAULT_DEPENDENCY_REVIEW_POLICY;
const sha512 = (seed: string) => `sha512-${createHash("sha512").update(seed).digest("base64")}`;
const sha256 = (seed: string) => createHash("sha256").update(seed).digest("hex");

function release(
  added: Record<string, string>,
  options: {
    ecosystem?: DependencyEcosystem;
    previous?: PackageJsonSummary;
    staged?: Partial<PackageJsonSummary>;
  } = {},
): PublicPackageDiff {
  const previous = options.previous ?? { name: "host", version: "1.0.0" };
  const staged: PackageJsonSummary = {
    ...previous,
    ...options.staged,
    name: "host",
    version: "1.0.1",
    dependencies: { ...previous.dependencies, ...options.staged?.dependencies, ...added },
  };
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

const CLEAN = extractBumpEvidence(release({}));
const ADDS_ONE = extractBumpEvidence(release({ carrier: "^1.0.0" }));

const dated = (
  firstDays: number,
  versionDays: number,
): Extract<BumpOutcome, { kind: "new-package" }> => ({
  kind: "new-package",
  firstPublishedAt: ago(firstDays),
  publishedAt: ago(versionDays),
});

type Hold = Extract<BumpVerdict, { status: "hold" }>;

// ── Lockfile to verdict, the way collection and the review stage settle it ──

type NpmEntry = { name?: string; version: string; integrity?: string };

/** package-lock.json v3; `root` is what the repository's own manifest declares. */
function npmLock(
  entries: Record<string, NpmEntry>,
  root: Record<string, unknown> = { dependencies: { host: "^1.0.0" } },
): string {
  const packages: Record<string, unknown> = { "": { name: "app", version: "1.0.0", ...root } };
  for (const [path, entry] of Object.entries(entries)) {
    const name = entry.name ?? path.split("node_modules/").at(-1)!;
    packages[`node_modules/${path}`] = {
      ...(entry.name ? { name: entry.name } : {}),
      version: entry.version,
      resolved: `https://registry.npmjs.org/${name}/-/${name}-${entry.version}.tgz`,
      integrity: entry.integrity ?? sha512(`${name}@${entry.version}`),
    };
  }
  return JSON.stringify({ name: "app", lockfileVersion: 3, requires: true, packages });
}

interface LockfilePair {
  kind?: LockfileKind;
  path?: string;
  before: string | null;
  after: string;
}

interface ReviewOptions {
  // Each new package's [days since first publish, days since its version].
  times?: Record<string, [number, number]>;
  // Each diffed release's evidence; CLEAN otherwise.
  evidence?: Record<string, BumpEvidence>;
  policy?: DependencyReviewPolicy;
}

/**
 * Verdicts by package name for the changes these lockfiles make, collected
 * and merged as `collect.ts` does, with every pin proven and every listed
 * time found, then settled as the review stage settles them.
 */
function review(pairs: LockfilePair[], options: ReviewOptions = {}): Map<string, BumpVerdict> {
  const merged = new Map<string, DependencyBump>();
  for (const pair of pairs) {
    const kind = pair.kind ?? "npm";
    const head = parseLockfile(kind, pair.after);
    const base = pair.before === null ? null : parseLockfile(kind, pair.before);
    const pinsTree = !head.partialTree;
    for (const change of diffLockfileChanges(base, head, pair.path ?? "package-lock.json")) {
      const bump = routedBump(change, PUBLIC_ROUTE, {
        publicMirrors: [],
        privateRegistries: [],
        privateScopes: [],
      });
      if (pinsTree) bump.lockfilePinsTree = true;
      const key = bumpIdentityKey(bump);
      const existing = merged.get(key);
      if (existing) mergeBump(existing, bump);
      else merged.set(key, bump);
    }
  }
  const verdicts = new Map<string, BumpVerdict>();
  for (const bump of merged.values()) {
    const times = options.times?.[bump.name];
    const outcome: BumpOutcome =
      bump.fromVersion === null
        ? {
            kind: "new-package",
            ...(times ? { firstPublishedAt: ago(times[0]), publishedAt: ago(times[1]) } : {}),
            ...(bump.repinned ? { repinned: true as const } : {}),
            ...(bump.buildsFromSource ? { buildsFromSource: true as const } : {}),
          }
        : {
            kind: "diffed",
            evidence: options.evidence?.[bump.name] ?? CLEAN,
            lockfilePinsTree: bump.lockfilePinsTree === true,
          };
    verdicts.set(bump.name, decideBump(outcome, options.policy ?? POLICY, NOW));
  }
  return verdicts;
}

const OLD: [number, number] = [400, 30];
const HOST_BEFORE = npmLock({ host: { version: "1.0.0" } });

describe("a package new to the lockfile holds while young", () => {
  test("host → carrier → payload: the young package beneath a newly added one holds", () => {
    const verdicts = review(
      [
        {
          before: HOST_BEFORE,
          after: npmLock({
            host: { version: "1.0.1" },
            carrier: { version: "1.0.0" },
            payload: { version: "1.0.0" },
          }),
        },
      ],
      { times: { carrier: OLD, payload: [5, 5] }, evidence: { host: ADDS_ONE } },
    );
    expect(verdicts.get("host")).toEqual({ status: "clear", evidence: ADDS_ONE });
    expect(verdicts.get("carrier")).toEqual({ status: "new-package" });
    expect(verdicts.get("payload")).toEqual({
      status: "hold",
      reasons: ["young-package"],
      evidence: null,
      young: { why: "first-published", at: ago(5) },
    });
  });

  test("an alias (`innocent: npm:payload@^1.0.0`) enters under the real name and holds", () => {
    const aliased = extractBumpEvidence(release({ innocent: "npm:payload@^1.0.0" }));
    const verdicts = review(
      [
        {
          before: HOST_BEFORE,
          after: npmLock({
            host: { version: "1.0.1" },
            innocent: { name: "payload", version: "1.0.0" },
          }),
        },
      ],
      { times: { payload: [2, 2] }, evidence: { host: aliased } },
    );
    expect([...verdicts.keys()].sort()).toEqual(["host", "payload"]);
    expect(verdicts.get("host")?.status).toBe("clear");
    expect(verdicts.get("payload")).toMatchObject({
      status: "hold",
      reasons: ["young-package"],
      young: { why: "first-published" },
    });
  });

  test('a root override alias (`overrides: {shim: "npm:fresh@1.0.0"}`) holds the package it installs', () => {
    const root = { dependencies: { host: "^1.0.0" }, overrides: { shim: "npm:fresh@1.0.0" } };
    const verdicts = review(
      [
        {
          before: npmLock({ host: { version: "1.0.0" } }, root),
          after: npmLock(
            {
              host: { version: "1.0.1" },
              // npm writes the override's target under the overridden path.
              shim: { name: "fresh", version: "1.0.0" },
            },
            root,
          ),
        },
      ],
      {
        times: { fresh: [1, 1] },
        evidence: { host: extractBumpEvidence(release({ shim: "^1.0.0" })) },
      },
    );
    expect(verdicts.get("host")?.status).toBe("clear");
    expect(verdicts.get("fresh")).toMatchObject({
      status: "hold",
      reasons: ["young-package"],
      young: { why: "first-published", at: ago(1) },
    });
  });

  test("a young package no reviewed release declares", () => {
    const verdicts = review(
      [
        {
          before: HOST_BEFORE,
          after: npmLock({ host: { version: "1.0.0" }, payload: { version: "1.0.0" } }),
        },
      ],
      { times: { payload: [3, 3] } },
    );
    expect([...verdicts.keys()]).toEqual(["payload"]);
    expect(verdicts.get("payload")).toMatchObject({ reasons: ["young-package"] });
  });

  test("the release a bundled base copy names, now fetched from the registry, holds while young", () => {
    // The base's `payload` 1.0.0 shipped inside `bundler`'s tarball; npm never
    // fetched the registry's 1.0.0, so that release is new to the lockfile.
    const withBundled = (extra: Record<string, unknown>) =>
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": { dependencies: { bundler: "^1.0.0" } },
          "node_modules/bundler": {
            version: "1.0.0",
            resolved: "https://registry.npmjs.org/bundler/-/bundler-1.0.0.tgz",
            integrity: sha512("bundler@1.0.0"),
            bundleDependencies: ["payload"],
          },
          "node_modules/bundler/node_modules/payload": { version: "1.0.0", inBundle: true },
          ...extra,
        },
      });
    const verdicts = review(
      [
        {
          before: withBundled({}),
          after: withBundled({
            "node_modules/payload": {
              version: "1.0.0",
              resolved: "https://registry.npmjs.org/payload/-/payload-1.0.0.tgz",
              integrity: sha512("payload@1.0.0"),
            },
          }),
        },
      ],
      { times: { payload: [10, 10] } },
    );
    expect(verdicts.get("payload")).toEqual({
      status: "hold",
      reasons: ["young-package"],
      evidence: null,
      young: { why: "first-published", at: ago(10) },
    });
  });

  test("a new package the pull request adds directly", () => {
    const verdicts = review(
      [
        {
          before: HOST_BEFORE,
          after: npmLock(
            { host: { version: "1.0.0" }, fresh: { version: "1.0.0" } },
            { dependencies: { host: "^1.0.0", fresh: "^1.0.0" } },
          ),
        },
      ],
      { times: { fresh: [10, 10] } },
    );
    expect(verdicts.get("fresh")).toMatchObject({
      reasons: ["young-package"],
      young: { why: "first-published", at: ago(10) },
    });
  });

  test("a young version of an old package", () => {
    expect(decideBump(dated(400, 2), POLICY, NOW)).toEqual({
      status: "hold",
      reasons: ["young-package"],
      evidence: null,
      young: { why: "version-published", at: ago(2) },
    });
  });

  test.each<[string, BumpOutcome, Partial<Hold>]>([
    ["never looked up", { kind: "new-package" }, { young: { why: "age-unknown" } }],
    [
      "a failed lookup",
      { kind: "new-package", publishedAt: null, firstPublishedAt: null },
      { young: { why: "age-unknown" } },
    ],
    [
      "a listing with no first publish time",
      { kind: "new-package", publishedAt: ago(400), firstPublishedAt: null },
      { young: { why: "age-unknown" } },
    ],
    [
      "an unparseable time",
      { kind: "new-package", publishedAt: "soon", firstPublishedAt: ago(400) },
      { young: { why: "age-unknown" } },
    ],
    [
      "past the review limit",
      { kind: "new-package", pastReviewLimit: true },
      { young: { why: "age-unknown" }, pastReviewLimit: true },
    ],
    [
      "a git or URL source",
      { kind: "unreviewed", reason: "remote-source", newPackage: true },
      { young: { why: "no-verdict" }, unreviewed: "remote-source" },
    ],
    [
      "an unverified pin",
      { kind: "unreviewed", reason: "unverified-pin", newPackage: true },
      { young: { why: "no-verdict" }, unreviewed: "unverified-pin" },
    ],
    [
      "over the review limit with a pin to prove",
      { kind: "unreviewed", reason: "over-cap", pastReviewLimit: true, newPackage: true },
      { young: { why: "no-verdict" }, unreviewed: "over-cap", pastReviewLimit: true },
    ],
  ])("%s holds, however old", (_, outcome, fields) => {
    expect(decideBump(outcome, POLICY, NOW)).toEqual({
      status: "hold",
      reasons: ["young-package"],
      evidence: null,
      ...fields,
    });
  });

  test("a new package from a declared private registry is exempt, and holds only under holdOnUnreviewed", () => {
    const outcome = { kind: "unreviewed", reason: "private-source", newPackage: true } as const;
    expect(decideBump(outcome, POLICY, NOW)).toEqual({
      status: "unreviewed",
      unreviewed: "private-source",
    });
    expect(decideBump(outcome, { ...POLICY, holdOnUnreviewed: true }, NOW)).toMatchObject({
      status: "hold",
      reasons: ["unreviewed"],
    });
  });

  describe("a uv package new to the lockfile that is built from source", () => {
    // `wheels` are filename tag suffixes (`py3-none-any`); `sdist` defaults on.
    type UvEntry = { name: string; version: string; sdist?: boolean; wheels?: string[] };
    const uvLock = (packages: UvEntry[]) =>
      [
        "version = 1",
        ...packages.flatMap(({ name, version, sdist = true, wheels = [] }) => [
          "",
          "[[package]]",
          `name = "${name}"`,
          `version = "${version}"`,
          'source = { registry = "https://pypi.org/simple" }',
          ...(sdist
            ? [
                `sdist = { url = "https://files.pythonhosted.org/packages/ab/${name}-${version}.tar.gz", hash = "sha256:${sha256(`${name}${version}`)}", size = 1 }`,
              ]
            : []),
          ...(wheels.length > 0
            ? [
                "wheels = [",
                ...wheels.map(
                  (tags) =>
                    `    { url = "https://files.pythonhosted.org/packages/ab/${name}-${version}-${tags}.whl", hash = "sha256:${sha256(`${name}${version}${tags}`)}", size = 1 },`,
                ),
                "]",
              ]
            : []),
        ]),
      ].join("\n");
    const ADDS_CARRIER = extractBumpEvidence(
      release({ carrier: "==1.0.0" }, { ecosystem: "pypi" }),
    );
    // carrier: project 400 days old, release 30; its sdist's
    // `build-system.requires = ["builder>=1"]` resolves a day-old builder.
    const carrierVerdict = (carrier: Omit<UvEntry, "name" | "version">) =>
      review(
        [
          {
            kind: "uv",
            path: "uv.lock",
            before: uvLock([{ name: "host", version: "1.0.0", wheels: ["py3-none-any"] }]),
            after: uvLock([
              { name: "host", version: "1.0.1", wheels: ["py3-none-any"] },
              { name: "carrier", version: "1.0.0", ...carrier },
            ]),
          },
        ],
        { times: { carrier: OLD }, evidence: { host: ADDS_CARRIER } },
      ).get("carrier");
    const BUILT = {
      status: "hold",
      reasons: ["young-package"],
      evidence: null,
      young: { why: "built-from-source" },
    };

    test("however old, it holds: the lock records an sdist and no wheel", () => {
      expect(carrierVerdict({})).toEqual(BUILT);
    });

    test.each<[string, Omit<UvEntry, "name" | "version">]>([
      ["an sdist and a pure-Python wheel", { wheels: ["py3-none-any"] }],
      [
        "an sdist and platform wheels (which one installs is not modelled)",
        {
          wheels: [
            "cp312-cp312-manylinux_2_17_x86_64.manylinux2014_x86_64",
            "cp312-cp312-macosx_11_0_arm64",
          ],
        },
      ],
      ["an sdist and one wheel for another platform", { wheels: ["cp311-cp311-win_amd64"] }],
      ["wheels only, no sdist", { sdist: false, wheels: ["cp311-cp311-win_amd64"] }],
    ])("judged by its age as before: %s", (_, carrier) => {
      expect(carrierVerdict(carrier)).toEqual({ status: "new-package" });
    });
  });

  test("a change new in one lockfile and re-pinned in another holds as new", () => {
    const repinned = sha512("new pin");
    const verdicts = review(
      [
        {
          path: "a/package-lock.json",
          before: npmLock({ fresh: { version: "1.0.0", integrity: sha512("old pin") } }),
          after: npmLock({ fresh: { version: "1.0.0", integrity: repinned } }),
        },
        {
          path: "b/package-lock.json",
          before: npmLock({}),
          after: npmLock({ fresh: { version: "1.0.0", integrity: repinned } }),
        },
      ],
      { times: { fresh: [1, 1] } },
    );
    expect(verdicts.size).toBe(1);
    expect(verdicts.get("fresh")).toMatchObject({ reasons: ["young-package"] });
  });

  test("a move off a private source onto the public registry is new: listed, held only while young", () => {
    expect(decideBump(dated(400, 30), POLICY, NOW)).toEqual({ status: "new-package" });
    expect(decideBump(dated(400, 3), POLICY, NOW)).toMatchObject({ reasons: ["young-package"] });
  });
});

describe("an added dependency holds where the lockfile can't show what it installs", () => {
  const ADDS_PYPI = extractBumpEvidence(release({ carrier: ">=1" }, { ecosystem: "pypi" }));
  const hash = (seed: string) => ` --hash=sha256:${sha256(seed)}`;

  test("an unhashed requirements file", () => {
    const verdicts = review(
      [{ kind: "requirements", before: "host==1.0.0\n", after: "host==1.0.1\n" }],
      { evidence: { host: ADDS_PYPI } },
    );
    expect(verdicts.get("host")).toEqual({
      status: "hold",
      reasons: ["dependency-added"],
      evidence: ADDS_PYPI,
      dependencyUnseen: "lockfile-unpinned",
    });
  });

  test("a requirements file in hash-checking mode too: build requirements are outside it", () => {
    // The host adds `carrier==1.0.0`, an sdist whose `build-system.requires`
    // pip installs in an isolated environment the file's hashes never reach.
    const verdicts = review(
      [
        {
          kind: "requirements",
          before: `host==1.0.0${hash("a")}\n`,
          after: `host==1.0.1${hash("b")}\ncarrier==1.0.0${hash("c")}\n`,
        },
      ],
      { evidence: { host: ADDS_PYPI }, times: { carrier: OLD } },
    );
    expect(verdicts.get("host")).toMatchObject({
      status: "hold",
      reasons: ["dependency-added"],
      dependencyUnseen: "lockfile-unpinned",
    });
  });

  test("a Yarn classic lockfile: its frozen install fetches a transitive package it lacks", () => {
    const stanza = (name: string, version: string) =>
      [
        `${name}@^1.0.0:`,
        `  version "${version}"`,
        `  resolved "https://registry.yarnpkg.com/${name}/-/${name}-${version}.tgz"`,
        `  integrity ${sha512(`${name}@${version}`)}`,
        "",
      ].join("\n");
    const lock = (...stanzas: string[]) => ["# yarn lockfile v1", "", ...stanzas].join("\n");
    // host@1.0.1 declares `carrier`, which the lockfile does not lock; the
    // young `fresh` entering beside it still holds as young.
    const verdicts = review(
      [
        {
          kind: "yarn",
          path: "yarn.lock",
          before: lock(stanza("host", "1.0.0")),
          after: lock(stanza("host", "1.0.1"), stanza("fresh", "1.0.0")),
        },
      ],
      { evidence: { host: ADDS_ONE }, times: { fresh: [3, 3] } },
    );
    expect(verdicts.get("host")).toEqual({
      status: "hold",
      reasons: ["dependency-added"],
      evidence: ADDS_ONE,
      dependencyUnseen: "lockfile-unpinned",
    });
    expect(verdicts.get("fresh")).toMatchObject({ reasons: ["young-package"] });
  });

  test("any lockfile, when part of the review went unread", () => {
    expect(
      decideBump(
        { kind: "diffed", evidence: ADDS_ONE, lockfilePinsTree: true, coverageIncomplete: true },
        POLICY,
        NOW,
      ),
    ).toEqual({
      status: "hold",
      reasons: ["dependency-added"],
      evidence: ADDS_ONE,
      dependencyUnseen: "coverage-incomplete",
    });
  });

  test("an optional peer moved into dependencies counts as added", () => {
    const peer = { "optional-peer": "^1.0.0" };
    const moved = extractBumpEvidence(
      release(peer, {
        previous: {
          name: "host",
          version: "1.0.0",
          peerDependencies: peer,
          peerDependenciesMeta: { "optional-peer": { optional: true } },
        },
      }),
    );
    expect(moved.dependenciesAdded).toBe(1);
    expect(
      decideBump({ kind: "diffed", evidence: moved, lockfilePinsTree: false }, POLICY, NOW),
    ).toMatchObject({ reasons: ["dependency-added"], dependencyUnseen: "lockfile-unpinned" });
  });

  test("moving a dependency between installing sections, or into peers, adds nothing", () => {
    const evidence = extractBumpEvidence(
      release(
        {},
        {
          previous: {
            name: "host",
            version: "1.0.0",
            dependencies: { a: "^1", b: "^1" },
          },
          staged: { optionalDependencies: { a: "^1" }, peerDependencies: { b: "^1" } },
        },
      ),
    );
    expect(evidence.dependenciesAdded).toBe(0);
  });

  test("stored evidence or a bump without the pins-the-tree fact reads as not pinning it", () => {
    expect(decideBump({ kind: "diffed", evidence: ADDS_ONE }, POLICY, NOW)).toMatchObject({
      reasons: ["dependency-added"],
      dependencyUnseen: "lockfile-unpinned",
    });
    // A caller that does not say holds with the old wording.
    expect(evaluateBumpEvidence(ADDS_ONE, POLICY)).toEqual({
      status: "hold",
      reasons: ["dependency-added"],
      evidence: ADDS_ONE,
    });
  });
});

describe("nothing young entering a tree-pinning lockfile does not hold for this reason", () => {
  test("a new package at least 90 days old whose version is at least 7 days old, at each exact bound", () => {
    const atBound: BumpOutcome = {
      kind: "new-package",
      firstPublishedAt: ago(YOUNG_PACKAGE_DAYS),
      publishedAt: ago(YOUNG_VERSION_DAYS),
    };
    expect(decideBump(atBound, POLICY, NOW)).toEqual({ status: "new-package" });
    const minute = 60_000;
    expect(
      decideBump(
        {
          ...atBound,
          firstPublishedAt: new Date(NOW - YOUNG_PACKAGE_DAYS * DAY + minute).toISOString(),
        },
        POLICY,
        NOW,
      ),
    ).toMatchObject({ young: { why: "first-published" } });
    expect(
      decideBump(
        {
          ...atBound,
          publishedAt: new Date(NOW - YOUNG_VERSION_DAYS * DAY + minute).toISOString(),
        },
        POLICY,
        NOW,
      ),
    ).toMatchObject({ young: { why: "version-published" } });
  });

  test("a release declaring a dependency the lockfile already had, or one that entered old", () => {
    const already = review(
      [
        {
          before: npmLock({ host: { version: "1.0.0" }, carrier: { version: "1.0.0" } }),
          after: npmLock({ host: { version: "1.0.1" }, carrier: { version: "1.0.0" } }),
        },
      ],
      { evidence: { host: ADDS_ONE } },
    );
    expect([...already.values()]).toEqual([{ status: "clear", evidence: ADDS_ONE }]);

    const entered = review(
      [
        {
          before: HOST_BEFORE,
          after: npmLock({ host: { version: "1.0.1" }, carrier: { version: "1.0.0" } }),
        },
      ],
      { times: { carrier: OLD }, evidence: { host: ADDS_ONE } },
    );
    expect(entered.get("host")?.status).toBe("clear");
    expect(entered.get("carrier")).toEqual({ status: "new-package" });
  });

  test("a re-pin", () => {
    const verdicts = review(
      [
        {
          before: npmLock({ host: { version: "1.0.0", integrity: sha512("old pin") } }),
          after: npmLock({ host: { version: "1.0.0", integrity: sha512("new pin") } }),
        },
      ],
      { times: { host: [1, 10] } },
    );
    expect(verdicts.get("host")).toEqual({ status: "new-package" });
    expect(decideBump({ ...dated(1, 1), repinned: true }, POLICY, NOW)).toMatchObject({
      reasons: ["too-new"],
    });
  });

  test("a version change", () => {
    const verdicts = review([
      { before: HOST_BEFORE, after: npmLock({ host: { version: "1.0.1" } }) },
    ]);
    expect(verdicts.get("host")).toEqual({ status: "clear", evidence: CLEAN });
  });
});

describe("switches and precedence", () => {
  const OFF = { ...POLICY, holdOnNewDependencies: false };

  test("with the switch off only the age fallback and the other switches apply", () => {
    expect(decideBump(dated(1, 1), OFF, NOW)).toMatchObject({ reasons: ["too-new"] });
    expect(decideBump(dated(1, 10), OFF, NOW)).toEqual({ status: "new-package" });
    expect(
      decideBump({ kind: "unreviewed", reason: "private-source", newPackage: true }, OFF, NOW),
    ).toEqual({ status: "unreviewed", unreviewed: "private-source" });
    expect(decideBump({ kind: "diffed", evidence: ADDS_ONE }, OFF, NOW)).toEqual({
      status: "clear",
      evidence: ADDS_ONE,
    });
    expect(needsReleaseAge({ kind: "new-package" }, { ...OFF, unreadMinimumAgeDays: null })).toBe(
      false,
    );
  });

  test("with the age fallback off the young rule and its lookups still run", () => {
    const noAge = { ...POLICY, unreadMinimumAgeDays: null };
    expect(needsReleaseAge({ kind: "new-package" }, noAge)).toBe(true);
    expect(decideBump(dated(1, 1), noAge, NOW)).toMatchObject({ reasons: ["young-package"] });
    expect(decideBump(dated(400, 30), noAge, NOW)).toEqual({ status: "new-package" });
  });

  test("young wins over the age fallback; holdOnNewPackages wins over both", () => {
    expect(decideBump(dated(400, 1), POLICY, NOW)).toMatchObject({
      reasons: ["young-package"],
    });
    expect(decideBump(dated(1, 1), { ...POLICY, holdOnNewPackages: true }, NOW)).toEqual({
      status: "hold",
      reasons: ["new-package"],
      evidence: null,
    });
    expect(
      decideBump(
        { kind: "unreviewed", reason: "remote-source", newPackage: true },
        { ...POLICY, holdOnUnreviewed: true },
        NOW,
      ),
    ).toMatchObject({ reasons: ["unreviewed"] });
  });

  test("an unread diff with an added dependency still asks for its publish time", () => {
    // Coverage is known only after the stage, so `dependency-added` never
    // spares the age fallback's lookup.
    const evidence = { ...ADDS_ONE, uninspectedFiles: 1 };
    expect(needsReleaseAge({ kind: "diffed", evidence }, POLICY)).toBe(true);
  });
});

describe("collection says which lockfiles pin the whole tree", () => {
  test("a change merged from two lockfiles pins the tree only if both do", () => {
    const pinned: DependencyBump = {
      ecosystem: "pypi",
      name: "left-pad",
      fromVersion: "1.0.0",
      toVersion: "1.0.1",
      direct: true,
      lockfilePath: "uv.lock",
      lockfilePinsTree: true,
    };
    const merged = { ...pinned };
    mergeBump(merged, { ...pinned, lockfilePath: "requirements.txt", lockfilePinsTree: undefined });
    expect(merged.lockfilePinsTree).toBeUndefined();
    const both = { ...pinned };
    mergeBump(both, { ...pinned });
    expect(both.lockfilePinsTree).toBe(true);
  });
});

test("the settings hint states the same thresholds the policy applies", () => {
  const hint = POLICY_SWITCHES.find((entry) => entry.key === "holdOnNewDependencies")?.hint;
  expect(hint).toContain(`${YOUNG_PACKAGE_DAYS} days`);
  expect(hint).toContain(`${YOUNG_VERSION_DAYS} days`);
  // Every requirements file and Yarn classic lockfile holds an added
  // dependency, hashed or not.
  expect(hint).toContain("requirements files, Yarn classic lockfiles");
  expect(hint).not.toContain("without hashes");
});

describe("lockfiles whose frozen install can fetch what they leave out", () => {
  const classic = (...stanzas: string[]) => ["# yarn lockfile v1", "", ...stanzas].join("\n");
  const stanza = (descriptor: string, version: string, deps: string[] = []) =>
    [
      `${descriptor}:`,
      `  version "${version}"`,
      `  resolved "https://registry.yarnpkg.com/x/-/x-${version}.tgz"`,
      `  integrity ${sha512(descriptor + version)}`,
      ...(deps.length > 0 ? ["  dependencies:", ...deps.map((dep) => `    ${dep}`)] : []),
      "",
    ].join("\n");

  test.each([
    ["a transitive package the lockfile lacks", 'payload "^1.0.0"'],
    ["a workspace package, which Yarn classic never locks", 'lib "^1.0.0"'],
  ])("Yarn classic reads complete and never pins the tree: %s", (_, dep) => {
    const snapshot = parseLockfile("yarn", classic(stanza("host@^1.0.0", "1.0.1", [dep])));
    expect(snapshot.complete).toBe(true);
    expect(snapshot.partialTree).toBe(true);
  });

  test("a requirements file never pins the tree; Berry, npm, pnpm, and uv do", () => {
    expect(parseLockfile("requirements", "host==1.0.0\n").partialTree).toBe(true);
    const berry = "__metadata:\n  version: 8\n  cacheKey: 10\n";
    expect(parseLockfile("yarn", berry).partialTree).toBeUndefined();
    const npm = JSON.stringify({ lockfileVersion: 3, packages: { "": {} } });
    expect(parseLockfile("npm", npm).partialTree).toBeUndefined();
    expect(parseLockfile("pnpm", "lockfileVersion: '9.0'\n").partialTree).toBeUndefined();
    expect(parseLockfile("uv", "version = 1\n").partialTree).toBeUndefined();
  });
});
