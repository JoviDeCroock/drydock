import { describe, expect, test } from "vitest";
import {
  annotateFindingsWithDiffStatus,
  createPackageDiff,
  deterministicFindings,
  packageJsonDiffFindings,
  summarizePackageJsonDiff,
} from "../server/lib/review";

describe("package.json review", () => {
  test("package json diff summarizes release-review sensitive fields", () => {
    const summary = summarizePackageJsonDiff(
      {
        name: "pkg",
        version: "1.0.0",
        scripts: {},
        dependencies: { a: "1.0.0" },
        main: "index.js",
      },
      {
        name: "pkg",
        version: "1.0.1",
        scripts: { postinstall: "node install.js" },
        dependencies: { a: "1.1.0", b: "2.0.0" },
        main: "dist/index.js",
      },
    );

    expect(summary.previousVersion).toBe("1.0.0");
    expect(summary.stagedVersion).toBe("1.0.1");
    expect(summary.scripts).toEqual([
      { key: "postinstall", status: "added", staged: "node install.js" },
    ]);
    expect(summary.entrypointsChanged).toBe(true);
  });

  test("diffs bin commands and flags newly added executables", () => {
    const objectForm = summarizePackageJsonDiff(
      { name: "tool", version: "1.0.0" },
      { name: "tool", version: "1.0.1", bin: { tool: "cli.js", helper: "helper.js" } },
    );
    expect(objectForm.bin).toEqual([
      { key: "helper", status: "added", staged: "helper.js" },
      { key: "tool", status: "added", staged: "cli.js" },
    ]);

    // A string bin installs one command named after the package (unscoped part).
    const stringForm = summarizePackageJsonDiff(
      { name: "@scope/tool", version: "1.0.0" },
      { name: "@scope/tool", version: "1.0.1", bin: "cli.js" },
    );
    expect(stringForm.bin).toEqual([{ key: "tool", status: "added", staged: "cli.js" }]);

    expect(packageJsonDiffFindings(objectForm)).toEqual([
      expect.objectContaining({
        ruleId: "diff.bin-added",
        severity: "medium",
        evidence: "bin helper: helper.js",
      }),
      expect.objectContaining({
        ruleId: "diff.bin-added",
        severity: "medium",
        evidence: "bin tool: cli.js",
      }),
    ]);

    // A bin command whose target only moves (build-path churn) is not flagged.
    const retarget = summarizePackageJsonDiff(
      { name: "tool", version: "1.0.0", bin: { tool: "cli.js" } },
      { name: "tool", version: "1.0.1", bin: { tool: "dist/cli.js" } },
    );
    expect(retarget.bin).toEqual([
      { key: "tool", status: "modified", previous: "cli.js", staged: "dist/cli.js" },
    ]);
    expect(packageJsonDiffFindings(retarget)).toEqual([]);
  });

  test("flags unusual dependency specs in package json diffs", () => {
    const diff = summarizePackageJsonDiff(
      { name: "pkg", version: "1.0.0", dependencies: { safe: "^1.0.0" } },
      {
        name: "pkg",
        version: "1.0.1",
        dependencies: {
          safe: "github:example/safe#main",
          remote: "https://example.invalid/pkg.tgz",
          local: "file:../local.tgz",
          alias: "npm:other-package@^1.0.0",
        },
      },
    );

    const findings = packageJsonDiffFindings(diff);

    expect(findings).toEqual([
      expect.objectContaining({
        severity: "high",
        file: "package.json",
        evidence: "alias: npm:other-package@^1.0.0",
        ruleId: "dependency.unusual-spec",
      }),
      expect.objectContaining({
        evidence: "local: file:../local.tgz",
        ruleId: "dependency.unusual-spec",
      }),
      expect.objectContaining({
        evidence: "remote: https://example.invalid/pkg.tgz",
        ruleId: "dependency.unusual-spec",
      }),
      expect.objectContaining({
        evidence: "safe: github:example/safe#main",
        ruleId: "dependency.unusual-spec",
      }),
    ]);
    // A plain registry-spec addition is no longer silent, but it downgrades to
    // the generic dependency.added rule instead of unusual-spec.
    expect(
      packageJsonDiffFindings({
        ...diff,
        dependencies: [{ key: "safe", status: "added", staged: "^1.0.0", section: "dependencies" }],
      }),
    ).toEqual([
      expect.objectContaining({
        ruleId: "dependency.added",
        severity: "medium",
        evidence: "safe: ^1.0.0",
      }),
    ]);
  });

  test("flags added dependencies and major version bumps", () => {
    const stagedPackageJsonText = `{
  "name": "pkg",
  "version": "11.0.0",
  "dependencies": {
    "event-pubsub": "5.0.0",
    "js-message": "1.0.3",
    "peacenotwar": "^9.1.3"
  }
}`;
    const diff = summarizePackageJsonDiff(
      {
        name: "pkg",
        version: "9.2.1",
        dependencies: { "event-pubsub": "4.3.0", "js-message": "1.0.3" },
      },
      JSON.parse(stagedPackageJsonText),
    );

    const findings = packageJsonDiffFindings(diff, stagedPackageJsonText);

    expect(findings).toEqual([
      expect.objectContaining({
        ruleId: "dependency.major-bump",
        severity: "low",
        file: "package.json",
        line: 5,
        evidence: "event-pubsub: 4.3.0 -> 5.0.0",
      }),
      expect.objectContaining({
        ruleId: "dependency.added",
        severity: "medium",
        file: "package.json",
        line: 7,
        evidence: "peacenotwar: ^9.1.3",
      }),
    ]);
  });

  test("dependency added and bump rules stay quiet on routine changes", () => {
    // Patch/minor bumps within the same major, removed deps, and unchanged deps
    // raise nothing.
    const routine = summarizePackageJsonDiff(
      {
        name: "pkg",
        version: "1.0.0",
        dependencies: { same: "^1.0.0", minor: "^1.1.0", gone: "^2.0.0" },
      },
      { name: "pkg", version: "1.0.1", dependencies: { same: "^1.0.0", minor: "^1.2.4" } },
    );
    expect(packageJsonDiffFindings(routine)).toEqual([]);

    // An added optional dependency keeps the single higher-severity
    // optional-added finding rather than stacking dependency.added on top.
    const optional = summarizePackageJsonDiff(
      { name: "pkg", version: "1.0.0" },
      { name: "pkg", version: "1.0.1", optionalDependencies: { maybe: "^2.0.0" } },
    );
    expect(packageJsonDiffFindings(optional).map((finding) => finding.ruleId)).toEqual([
      "dependency.optional-added",
    ]);

    // Specs without a version anchor (dist-tags, wildcards, bare `>` ranges)
    // cannot prove a major boundary crossing and stay quiet.
    const unanchored = summarizePackageJsonDiff(
      {
        name: "pkg",
        version: "1.0.0",
        dependencies: { tagged: "latest", wild: "*", open: ">1.0.0" },
      },
      {
        name: "pkg",
        version: "1.0.1",
        dependencies: { tagged: "next", wild: "2.0.0", open: ">3.0.0" },
      },
    );
    expect(packageJsonDiffFindings(unanchored)).toEqual([]);
  });

  test("dependency delta rules stay silent without a baseline manifest", () => {
    // A first-ever publish (or a degraded baseline fetch) diffs every dep as
    // "added"; that is not the added-dependency vector, and flagging the whole
    // list would floor every first release at medium risk.
    const firstPublish = summarizePackageJsonDiff(undefined, {
      name: "pkg",
      version: "1.0.0",
      dependencies: { "left-pad": "^1.3.0", "event-pubsub": "4.3.0" },
      peerDependencies: { preact: "^10.0.0" },
      optionalDependencies: { fsevents: "^2.0.0" },
    });

    const ruleIds = packageJsonDiffFindings(firstPublish).map((finding) => finding.ruleId);

    // optional-added still fires: it describes the staged manifest itself,
    // not the delta against a previous release.
    expect(ruleIds).toEqual(["dependency.optional-added"]);
  });

  test("treats a section move as a modification, not a new dependency", () => {
    // Same spec moved optionalDependencies -> dependencies: nothing new ships.
    const pureMove = summarizePackageJsonDiff(
      { name: "pkg", version: "1.0.0", optionalDependencies: { fsevents: "^2.0.0" } },
      { name: "pkg", version: "1.0.1", dependencies: { fsevents: "^2.0.0" } },
    );
    expect(packageJsonDiffFindings(pureMove)).toEqual([]);

    // A move that also crosses a major boundary reports the bump, with the
    // removed section's spec as the previous side.
    const moveWithBump = summarizePackageJsonDiff(
      { name: "pkg", version: "1.0.0", optionalDependencies: { fsevents: "^1.0.0" } },
      { name: "pkg", version: "1.0.1", dependencies: { fsevents: "^2.0.0" } },
    );
    expect(packageJsonDiffFindings(moveWithBump)).toEqual([
      expect.objectContaining({
        ruleId: "dependency.major-bump",
        evidence: "fsevents: ^1.0.0 -> ^2.0.0",
      }),
    ]);

    // Moving a dependency into optionalDependencies is still a relocation, so
    // the high optional-added finding does not fire on already-shipped code.
    const moveIntoOptional = summarizePackageJsonDiff(
      { name: "pkg", version: "1.0.0", dependencies: { fsevents: "^2.0.0" } },
      { name: "pkg", version: "1.0.1", optionalDependencies: { fsevents: "^2.0.0" } },
    );
    expect(packageJsonDiffFindings(moveIntoOptional)).toEqual([]);

    // peerDependencies do not install, so moving a peer requirement into
    // dependencies genuinely starts shipping code and is a real addition.
    const peerToRuntime = summarizePackageJsonDiff(
      { name: "pkg", version: "1.0.0", peerDependencies: { lodash: "^4.0.0" } },
      { name: "pkg", version: "1.0.1", dependencies: { lodash: "^4.0.0" } },
    );
    expect(packageJsonDiffFindings(peerToRuntime)).toEqual([
      expect.objectContaining({ ruleId: "dependency.added", evidence: "lodash: ^4.0.0" }),
    ]);
  });

  test("emits one finding per dependency key across sections", () => {
    // The common dependencies + peerDependencies pairing must not double-flag.
    const bothSections = summarizePackageJsonDiff(
      { name: "pkg", version: "1.0.0" },
      {
        name: "pkg",
        version: "1.0.1",
        dependencies: { react: "^18.0.0" },
        peerDependencies: { react: "^18.0.0" },
      },
    );
    expect(packageJsonDiffFindings(bothSections)).toEqual([
      expect.objectContaining({ ruleId: "dependency.added", evidence: "react: ^18.0.0" }),
    ]);

    // A genuinely new optional+runtime listing keeps only the higher-severity
    // optional-added finding.
    const optionalAndRuntime = summarizePackageJsonDiff(
      { name: "pkg", version: "1.0.0" },
      {
        name: "pkg",
        version: "1.0.1",
        dependencies: { sharp: "^0.33.0" },
        optionalDependencies: { sharp: "^0.33.0" },
      },
    );
    expect(packageJsonDiffFindings(optionalAndRuntime)).toEqual([
      expect.objectContaining({ ruleId: "dependency.optional-added", evidence: "sharp: ^0.33.0" }),
    ]);

    // optionalDependencies overrides a same-named dependencies entry, so the
    // high finding must cite the effective optional spec rather than the
    // lower-ranked runtime row.
    const differentOptionalSpec = summarizePackageJsonDiff(
      { name: "pkg", version: "1.0.0" },
      {
        name: "pkg",
        version: "1.0.1",
        dependencies: { sharp: "^0.32.0" },
        optionalDependencies: { sharp: "^0.33.0" },
      },
    );
    expect(packageJsonDiffFindings(differentOptionalSpec)).toEqual([
      expect.objectContaining({ ruleId: "dependency.optional-added", evidence: "sharp: ^0.33.0" }),
    ]);

    // An unusual spec in ANY changed section outranks the added/bump rules:
    // npm 7+ installs peer dependencies too, so a git spec added under
    // peerDependencies must not hide behind a benign spec in dependencies and
    // downgrade the key to the medium added finding.
    const unusualBehindBenign = summarizePackageJsonDiff(
      { name: "pkg", version: "1.0.0", dependencies: { evil: "^1.0.0" } },
      {
        name: "pkg",
        version: "1.0.1",
        dependencies: { evil: "^2.0.0" },
        peerDependencies: { evil: "git+https://example.invalid/evil.git" },
      },
    );
    expect(packageJsonDiffFindings(unusualBehindBenign)).toEqual([
      expect.objectContaining({
        ruleId: "dependency.unusual-spec",
        severity: "high",
        evidence: "evil: git+https://example.invalid/evil.git",
      }),
    ]);
  });

  test("does not treat a duplicate declaration as a new dependency", () => {
    const existingRuntimeGetsPeer = summarizePackageJsonDiff(
      { name: "pkg", version: "1.0.0", dependencies: { react: "^18.0.0" } },
      {
        name: "pkg",
        version: "1.0.1",
        dependencies: { react: "^18.0.0" },
        peerDependencies: { react: "^18.0.0" },
      },
    );
    expect(existingRuntimeGetsPeer.dependencies).toEqual([
      {
        key: "react",
        status: "added",
        staged: "^18.0.0",
        section: "peerDependencies",
        previouslyDeclared: true,
        previouslyInstalled: true,
        previousDeclaredSpecs: ["^18.0.0"],
      },
    ]);
    expect(packageJsonDiffFindings(existingRuntimeGetsPeer)).toEqual([]);

    const existingRuntimeGetsNewMajorPeer = summarizePackageJsonDiff(
      { name: "pkg", version: "1.0.0", dependencies: { react: "^18.0.0" } },
      {
        name: "pkg",
        version: "1.0.1",
        dependencies: { react: "^18.0.0" },
        peerDependencies: { react: "^19.0.0" },
      },
    );
    expect(packageJsonDiffFindings(existingRuntimeGetsNewMajorPeer)).toEqual([
      expect.objectContaining({
        ruleId: "dependency.major-bump",
        evidence: "react: ^18.0.0 -> ^19.0.0",
      }),
    ]);

    // A peer-only requirement becoming an installed dependency still ships
    // code from the package, even if the peer declaration remains in place.
    const existingPeerGetsRuntime = summarizePackageJsonDiff(
      { name: "pkg", version: "1.0.0", peerDependencies: { react: "^18.0.0" } },
      {
        name: "pkg",
        version: "1.0.1",
        dependencies: { react: "^18.0.0" },
        peerDependencies: { react: "^18.0.0" },
      },
    );
    expect(packageJsonDiffFindings(existingPeerGetsRuntime)).toEqual([
      expect.objectContaining({ ruleId: "dependency.added", evidence: "react: ^18.0.0" }),
    ]);
  });

  test("compares an added optional override with the previous installed spec", () => {
    const optionalOverride = summarizePackageJsonDiff(
      { name: "pkg", version: "1.0.0", dependencies: { dep: "^1.0.0" } },
      {
        name: "pkg",
        version: "1.0.1",
        dependencies: { dep: "^1.0.0" },
        optionalDependencies: { dep: "^2.0.0" },
      },
    );

    expect(optionalOverride.dependencies).toEqual([
      {
        key: "dep",
        status: "added",
        staged: "^2.0.0",
        section: "optionalDependencies",
        previouslyDeclared: true,
        previouslyInstalled: true,
        previousInstalledSpec: "^1.0.0",
      },
    ]);
    expect(packageJsonDiffFindings(optionalOverride)).toEqual([
      expect.objectContaining({
        ruleId: "dependency.major-bump",
        evidence: "dep: ^1.0.0 -> ^2.0.0",
      }),
    ]);
  });

  test("does not report newly added optional peer dependencies as mandatory", () => {
    const optionalPeer = summarizePackageJsonDiff(
      { name: "pkg", version: "1.0.0" },
      {
        name: "pkg",
        version: "1.0.1",
        peerDependencies: { dep: "^1.0.0" },
        peerDependenciesMeta: { dep: { optional: true } },
      },
    );

    expect(optionalPeer.dependencies).toEqual([
      {
        key: "dep",
        status: "added",
        staged: "^1.0.0",
        section: "peerDependencies",
        stagedPeerOptional: true,
      },
    ]);
    expect(packageJsonDiffFindings(optionalPeer)).toEqual([]);

    const optionalGitPeer = summarizePackageJsonDiff(
      { name: "pkg", version: "1.0.0" },
      {
        name: "pkg",
        version: "1.0.1",
        peerDependencies: { dep: "git+https://example.invalid/dep.git" },
        peerDependenciesMeta: { dep: { optional: true } },
      },
    );
    expect(packageJsonDiffFindings(optionalGitPeer)).toEqual([]);
  });

  test("tracks optional peer changes and required transitions", () => {
    const modifiedOptionalPeer = summarizePackageJsonDiff(
      {
        name: "pkg",
        version: "1.0.0",
        peerDependencies: { dep: "^1.0.0" },
        peerDependenciesMeta: { dep: { optional: true } },
      },
      {
        name: "pkg",
        version: "1.0.1",
        peerDependencies: { dep: "git+https://example.invalid/dep.git" },
        peerDependenciesMeta: { dep: { optional: true } },
      },
    );
    expect(modifiedOptionalPeer.dependencies).toEqual([
      {
        key: "dep",
        status: "modified",
        previous: "^1.0.0",
        staged: "git+https://example.invalid/dep.git",
        section: "peerDependencies",
        previousPeerOptional: true,
        stagedPeerOptional: true,
      },
    ]);
    expect(packageJsonDiffFindings(modifiedOptionalPeer)).toEqual([]);

    const optionalBecomesRequired = summarizePackageJsonDiff(
      {
        name: "pkg",
        version: "1.0.0",
        peerDependencies: { dep: "^1.0.0" },
        peerDependenciesMeta: { dep: { optional: true } },
      },
      {
        name: "pkg",
        version: "1.0.1",
        peerDependencies: { dep: "^1.0.0" },
      },
    );
    expect(optionalBecomesRequired.dependencies).toEqual([
      {
        key: "dep",
        status: "modified",
        previous: "^1.0.0",
        staged: "^1.0.0",
        section: "peerDependencies",
        previousPeerOptional: true,
      },
    ]);
    expect(packageJsonDiffFindings(optionalBecomesRequired)).toEqual([
      expect.objectContaining({
        ruleId: "dependency.added",
        evidence: "dep: ^1.0.0",
      }),
    ]);

    const requiredBecomesOptional = summarizePackageJsonDiff(
      {
        name: "pkg",
        version: "1.0.0",
        peerDependencies: { dep: "^1.0.0" },
      },
      {
        name: "pkg",
        version: "1.0.1",
        peerDependencies: { dep: "^1.0.0" },
        peerDependenciesMeta: { dep: { optional: true } },
      },
    );
    expect(packageJsonDiffFindings(requiredBecomesOptional)).toEqual([]);
  });

  test("gates delta rules on baseline-manifest presence, not its version string", () => {
    // A prior release whose manifest parsed but declared no version must not be
    // able to switch off the next release's added/major-bump checks.
    const prevWithoutVersion = summarizePackageJsonDiff(
      { name: "pkg", dependencies: { existing: "^1.0.0" } },
      {
        name: "pkg",
        version: "1.0.1",
        dependencies: { existing: "^2.0.0", "evil-dep": "^1.0.0" },
      },
    );
    const ruleIds = packageJsonDiffFindings(prevWithoutVersion)
      .map((finding) => finding.ruleId)
      .sort();
    expect(ruleIds).toEqual(["dependency.added", "dependency.major-bump"]);
  });

  test("major-bump follows the highest major a union admits, not its floor", () => {
    // npm installs the highest published version a spec admits, so widening
    // "^1.0.0" to a union that now admits 2.x ships 2.x to consumers even
    // though 1.x is still in range — that is a major change worth flagging.
    const unionAdmitsNewMajor = summarizePackageJsonDiff(
      { name: "pkg", version: "1.0.0", dependencies: { dep: "^1.0.0" } },
      { name: "pkg", version: "1.0.1", dependencies: { dep: "^2.0.0 || ^1.0.0" } },
    );
    expect(packageJsonDiffFindings(unionAdmitsNewMajor)).toEqual([
      expect.objectContaining({ ruleId: "dependency.major-bump" }),
    ]);

    // A no-op "|| " suffix (or an unparseable leading branch) must not suppress
    // the comparison: the parseable branch still admits major 9.
    const unionEvasion = summarizePackageJsonDiff(
      { name: "pkg", version: "1.0.0", dependencies: { dep: "^1.0.0" } },
      { name: "pkg", version: "1.0.1", dependencies: { dep: "^9.0.0 || " } },
    );
    expect(packageJsonDiffFindings(unionEvasion)).toEqual([
      expect.objectContaining({ ruleId: "dependency.major-bump" }),
    ]);

    // A union whose highest admitted major is unchanged raises nothing.
    const unionSameMajor = summarizePackageJsonDiff(
      { name: "pkg", version: "1.0.0", dependencies: { dep: "^1.0.0" } },
      { name: "pkg", version: "1.0.1", dependencies: { dep: "~1.2.0 || ^1.5.0" } },
    );
    expect(packageJsonDiffFindings(unionSameMajor)).toEqual([]);

    // A hyphen range installs up to its high endpoint, and a bare ">=" with no
    // upper bound admits every future major — widening into either form fires.
    const hyphenWidening = summarizePackageJsonDiff(
      { name: "pkg", version: "1.0.0", dependencies: { dep: "^1.0.0" } },
      { name: "pkg", version: "1.0.1", dependencies: { dep: "1.0.0 - 2.0.0" } },
    );
    expect(packageJsonDiffFindings(hyphenWidening)).toEqual([
      expect.objectContaining({ ruleId: "dependency.major-bump" }),
    ]);
    const unboundedWidening = summarizePackageJsonDiff(
      { name: "pkg", version: "1.0.0", dependencies: { dep: "^1.0.0" } },
      { name: "pkg", version: "1.0.1", dependencies: { dep: ">=1.0.0" } },
    );
    expect(packageJsonDiffFindings(unboundedWidening)).toEqual([
      expect.objectContaining({ ruleId: "dependency.major-bump" }),
    ]);

    // A downgrade admits a major the prior range never did and fires; a pure
    // narrowing stays inside the previously reviewed span and stays quiet, as
    // does a rewrite whose upper-bound comparator keeps ">=" finite.
    const downgrade = summarizePackageJsonDiff(
      { name: "pkg", version: "1.0.0", dependencies: { dep: "^2.0.0" } },
      { name: "pkg", version: "1.0.1", dependencies: { dep: "^1.0.0" } },
    );
    expect(packageJsonDiffFindings(downgrade)).toEqual([
      expect.objectContaining({ ruleId: "dependency.major-bump" }),
    ]);
    const upperOnlyDowngrade = summarizePackageJsonDiff(
      { name: "pkg", version: "1.0.0", dependencies: { dep: "^2.0.0" } },
      { name: "pkg", version: "1.0.1", dependencies: { dep: "<=1.9.9" } },
    );
    expect(packageJsonDiffFindings(upperOnlyDowngrade)).toEqual([
      expect.objectContaining({
        ruleId: "dependency.major-bump",
        evidence: "dep: ^2.0.0 -> <=1.9.9",
      }),
    ]);
    const narrowing = summarizePackageJsonDiff(
      { name: "pkg", version: "1.0.0", dependencies: { dep: ">=1.0.0" } },
      { name: "pkg", version: "1.0.1", dependencies: { dep: "^1.0.0" } },
    );
    expect(packageJsonDiffFindings(narrowing)).toEqual([]);
    const boundedRewrite = summarizePackageJsonDiff(
      { name: "pkg", version: "1.0.0", dependencies: { dep: "^1.0.0" } },
      { name: "pkg", version: "1.0.1", dependencies: { dep: ">=1.0.0 <2.0.0" } },
    );
    expect(packageJsonDiffFindings(boundedRewrite)).toEqual([]);

    // A higher upper bound admits 2.x and must not be collapsed to the 1.x
    // floor of the comparator set.
    const boundedWidening = summarizePackageJsonDiff(
      { name: "pkg", version: "1.0.0", dependencies: { dep: "^1.0.0" } },
      { name: "pkg", version: "1.0.1", dependencies: { dep: ">=1.0.0 <3.0.0" } },
    );
    expect(packageJsonDiffFindings(boundedWidening)).toEqual([
      expect.objectContaining({ ruleId: "dependency.major-bump" }),
    ]);

    // Comparator sets are intersections, so reordering the upper and lower
    // bounds must not hide the newly admitted major.
    const reorderedComparators = summarizePackageJsonDiff(
      { name: "pkg", version: "1.0.0", dependencies: { dep: "^1.0.0" } },
      { name: "pkg", version: "1.0.1", dependencies: { dep: "<3.0.0 >=1.0.0" } },
    );
    expect(packageJsonDiffFindings(reorderedComparators)).toEqual([
      expect.objectContaining({ ruleId: "dependency.major-bump" }),
    ]);

    // Comparator-set intersections use the strongest lower bound. The previous
    // range admits only 2.x, so moving to 1.x is a downgrade even though an
    // earlier redundant comparator mentioned 1.x.
    const strongestLowerBound = summarizePackageJsonDiff(
      { name: "pkg", version: "1.0.0", dependencies: { dep: ">=1 >=2 <3" } },
      { name: "pkg", version: "1.0.1", dependencies: { dep: "^1.0.0" } },
    );
    expect(packageJsonDiffFindings(strongestLowerBound)).toEqual([
      expect.objectContaining({ ruleId: "dependency.major-bump" }),
    ]);

    // Disjoint unions must keep their holes: the previous range admitted 1.x
    // and 3.x, but never the staged 2.x major.
    const unionHole = summarizePackageJsonDiff(
      { name: "pkg", version: "1.0.0", dependencies: { dep: "^1.0.0 || ^3.0.0" } },
      { name: "pkg", version: "1.0.1", dependencies: { dep: "^2.0.0" } },
    );
    expect(packageJsonDiffFindings(unionHole)).toEqual([
      expect.objectContaining({ ruleId: "dependency.major-bump" }),
    ]);

    // Every modified row compares its own spec pair: a major change confined
    // to the peer row of a dependencies + peerDependencies pairing cannot hide
    // behind an unchanged-major dependencies row.
    const peerRowBump = summarizePackageJsonDiff(
      {
        name: "pkg",
        version: "1.0.0",
        dependencies: { dep: "^1.0.0" },
        peerDependencies: { dep: "^1.0.0" },
      },
      {
        name: "pkg",
        version: "1.0.1",
        dependencies: { dep: "^1.1.0" },
        peerDependencies: { dep: "^2.0.0" },
      },
    );
    expect(packageJsonDiffFindings(peerRowBump)).toEqual([
      expect.objectContaining({
        ruleId: "dependency.major-bump",
        evidence: "dep: ^1.0.0 -> ^2.0.0",
      }),
    ]);

    // npm treats an empty spec like "*" — the loosest range must not be the
    // one silent path through the added rule.
    const emptySpec = summarizePackageJsonDiff(
      { name: "pkg", version: "1.0.0", dependencies: { anchor: "1.0.0" } },
      { name: "pkg", version: "1.0.1", dependencies: { anchor: "1.0.0", loose: "" } },
    );
    expect(packageJsonDiffFindings(emptySpec)).toEqual([
      expect.objectContaining({ ruleId: "dependency.added", evidence: "loose: " }),
    ]);
  });

  test("flags newly added optional dependencies", () => {
    const stagedPackageJsonText = `{
  "name": "pkg",
  "version": "1.0.1",
  "optionalDependencies": {
    "existing": "^1.0.0",
    "maybe": "^2.0.0"
  }
}`;
    const diff = summarizePackageJsonDiff(
      { name: "pkg", version: "1.0.0", optionalDependencies: { existing: "^1.0.0" } },
      JSON.parse(stagedPackageJsonText),
    );

    const findings = packageJsonDiffFindings(diff, stagedPackageJsonText);

    expect(diff.dependencies).toContainEqual({
      key: "maybe",
      status: "added",
      staged: "^2.0.0",
      section: "optionalDependencies",
    });
    expect(findings).toContainEqual(
      expect.objectContaining({
        severity: "high",
        file: "package.json",
        line: 6,
        evidence: "maybe: ^2.0.0",
        ruleId: "dependency.optional-added",
      }),
    );
  });
});

describe("package-json.entrypoint-missing", () => {
  const manifestFile = (manifest) => ({
    path: "package.json",
    size: 120,
    sha256: "pkg",
    flags: [],
    textSample: JSON.stringify(manifest, null, 2),
  });
  const file = (path) => ({
    path,
    size: 10,
    sha256: path,
    flags: [],
    textSample: "module.exports={}",
  });

  function findingsFor(manifest, paths, previous = null, options = {}) {
    const staged = [manifestFile(manifest), ...paths.map(file)];
    const diff = previous ? createPackageDiff(previous, staged) : [];
    return deterministicFindings(staged, diff, manifest, {
      entrypointResolution: "npm",
      ...options,
    }).filter((finding) => finding.ruleId === "package-json.entrypoint-missing");
  }

  test("flags a main the package does not ship", () => {
    const findings = findingsFor({ name: "pkg", version: "1.0.0", main: "index.cjs" }, []);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: "medium", file: "package.json" });
    expect(findings[0].evidence).toContain("index.cjs");
  });

  test("escalates when the previous release shipped the entrypoint", () => {
    // The scan 163a1e40-c049-4587-8525-85b4393d2eed shape: the build output
    // left the tarball while the manifest kept pointing at it.
    const manifest = { name: "pkg", version: "0.1.0", main: "index.cjs" };
    const previous = [
      manifestFile({ name: "pkg", version: "0.0.1", main: "index.cjs" }),
      file("index.cjs"),
      file("acorn.wasm"),
    ];

    const findings = findingsFor(manifest, [], previous);

    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("high");
    expect(findings[0].evidence).toContain("the previous version shipped it");
  });

  test("escalates when the previous release shipped an implicitly resolved main", () => {
    const manifest = { name: "pkg", version: "0.1.0", main: "dist/index" };
    const previous = [manifestFile({ ...manifest, version: "0.0.1" }), file("dist/index.js")];

    const findings = findingsFor(manifest, [], previous);

    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("high");
  });

  function annotate(manifest, previous) {
    const staged = [manifestFile(manifest)];
    const diff = createPackageDiff(previous, staged);
    const findings = deterministicFindings(staged, diff, manifest, {
      entrypointResolution: "npm",
    }).filter((finding) => finding.ruleId === "package-json.entrypoint-missing");

    return annotateFindingsWithDiffStatus(findings, diff, {
      previousFiles: previous,
      stagedFiles: staged,
    });
  }

  test("is a release-scoped finding so a broken release counts against release risk", () => {
    const manifest = { name: "pkg", version: "0.1.0", main: "index.cjs" };
    const previous = [manifestFile({ ...manifest, version: "0.0.1" }), file("index.cjs")];

    const [annotated] = annotate(manifest, previous);

    expect(annotated).toMatchObject({ severity: "high", releaseDelta: true });
  });

  test("does not scope an always-over-claimed entrypoint to the release", () => {
    // The predecessor did not ship it either, so the manifest has been stale
    // for at least a release: package context, not this release's regression.
    const manifest = { name: "pkg", version: "0.1.0", main: "index.cjs" };
    const previous = [manifestFile({ ...manifest, version: "0.0.1" })];

    const [annotated] = annotate(manifest, previous);

    expect(annotated).toMatchObject({ severity: "medium", releaseDelta: false });
  });

  test("stays silent for an ecosystem that did not opt into entrypoint resolution", () => {
    // A Python sdist that bundles JS assets carries a root package.json; it must
    // not be held to npm's require() semantics.
    const manifest = { name: "pkg", version: "1.0.0", main: "lib/index.js" };
    const staged = [manifestFile(manifest), file("setup.py")];

    expect(
      deterministicFindings(staged, [], manifest, { codePatternSet: "python" }).filter(
        (finding) => finding.ruleId === "package-json.entrypoint-missing",
      ),
    ).toEqual([]);
  });

  test("flags every missing bin command and exports target once per path", () => {
    const findings = findingsFor(
      {
        name: "pkg",
        version: "1.0.0",
        main: "dist/index.js",
        bin: { pkg: "./bin/cli.js", "pkg-dev": "./bin/cli.js" },
        exports: { ".": { require: "./dist/index.cjs", import: "./dist/index.mjs" } },
      },
      [],
    );

    // Two bin commands point at the same file: one path, one finding.
    expect(findings.map((finding) => finding.evidence).sort()).toEqual([
      "bin pkg bin/cli.js is not in the package",
      "exports dist/index.cjs is not in the package",
      "exports dist/index.mjs is not in the package",
      "main dist/index.js is not in the package",
    ]);
  });

  test.each([
    ["extensionless main", { main: "index" }],
    ["extensionless bin", { bin: { pkg: "cli" } }],
  ])("flags a missing %s path", (_name, manifest) => {
    expect(findingsFor({ name: "pkg", version: "1.0.0", ...manifest }, [])).toHaveLength(1);
  });

  test.each([
    ["exports", { exports: "./dist/index" }, ["dist/index.js"]],
    ["bin", { bin: { pkg: "./bin/cli" } }, ["bin/cli.js"]],
  ])("requires an exact %s target", (_name, manifest, paths) => {
    expect(findingsFor({ name: "pkg", version: "1.0.0", ...manifest }, paths)).toHaveLength(1);
  });

  test("does not treat an arbitrary child as a resolvable directory main", () => {
    expect(
      findingsFor({ name: "pkg", version: "1.0.0", main: "lib" }, ["lib/thing.js"]),
    ).toHaveLength(1);
  });

  test.each(["cjs", "mjs"])("does not implicitly append .%s to an npm main", (extension) => {
    expect(
      findingsFor({ name: "pkg", version: "1.0.0", main: "dist/index" }, [
        `dist/index.${extension}`,
      ]),
    ).toHaveLength(1);
  });

  test.each(["js", "json", "node"])(
    "uses npm's package-root index.%s fallback after an unresolved main",
    (extension) => {
      const manifest = { name: "pkg", version: "1.0.0", main: "dist/index.js" };
      const previous = [
        manifestFile({ ...manifest, version: "0.9.0" }),
        file("dist/index.js"),
        file(`index.${extension}`),
      ];

      expect(findingsFor(manifest, [`index.${extension}`], previous)).toEqual([]);
    },
  );

  test.each([
    ["a later array fallback", { exports: ["./index.js", "./missing.js"] }, ["index.js"]],
    [
      "a condition after default",
      { exports: { default: "./index.js", node: "./missing.js" } },
      ["index.js"],
    ],
  ])("does not flag %s that cannot be selected", (_name, manifest, paths) => {
    expect(findingsFor({ name: "pkg", version: "1.0.0", ...manifest }, paths)).toEqual([]);
  });

  test.each([
    ["exact path", { main: "dist/index.js" }, ["dist/index.js"]],
    ["implicit extension", { main: "dist/index" }, ["dist/index.js"]],
    ["directory index", { main: "lib" }, ["lib/index.js"]],
    ["directory package manifest", { main: "lib" }, ["lib/package.json"]],
    ["leading ./", { main: "./index.js" }, ["index.js"]],
    ["bin string form", { bin: "./cli.js" }, ["cli.js"]],
    [
      "nested exports conditions",
      { exports: { ".": { node: { require: "./a.cjs" } } } },
      ["a.cjs"],
    ],
    ["exports array fallbacks", { exports: ["./a.js"] }, ["a.js"]],
  ])("stays silent when a declared entrypoint resolves: %s", (_name, manifest, paths) => {
    expect(findingsFor({ name: "pkg", version: "1.0.0", ...manifest }, paths)).toEqual([]);
  });

  test.each(["cjs", "mjs"])("uses VS Code's implicit .%s entrypoint resolution", (extension) => {
    expect(
      findingsFor(
        { name: "pkg", version: "1.0.0", main: "out/extension" },
        [`out/extension.${extension}`],
        null,
        { entrypointResolution: "vscode" },
      ),
    ).toEqual([]);
  });

  test("reports a missing VS Code browser entrypoint against the browser field", () => {
    const findings = findingsFor(
      { name: "pkg", version: "1.0.0", browser: "out/browser" },
      [],
      null,
      { entrypointResolution: "vscode" },
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      line: 4,
      evidence: "browser out/browser is not in the package",
    });
  });

  test.each([
    [
      "a types condition",
      { exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } } },
      ["dist/index.js"],
    ],
    [
      "a typings condition",
      { exports: { ".": { typings: "./dist/index.d.ts", default: "./dist/index.js" } } },
      ["dist/index.js"],
    ],
    ["a legacy exports folder mapping", { exports: { "./lib/": "./lib/" } }, ["lib/thing.js"]],
    ["a folder mapping consuming its array slot", { exports: ["./lib/", "./missing.js"] }, []],
  ])("does not flag %s", (_name, manifest, paths) => {
    expect(findingsFor({ name: "pkg", version: "1.0.0", ...manifest }, paths)).toEqual([]);
  });

  test.each([
    ["subpath patterns", { exports: { "./*": "./dist/*.js" } }],
    ["node: builtins", { exports: { node: "node:fs" } }],
    ["URL targets", { main: "https://example.invalid/index.js" }],
    ["package imports", { main: "#internal" }],
    ["bare specifiers", { exports: { default: "lodash" } }],
    ["blocked exports (null)", { exports: { "./private": null } }],
    ["paths escaping the package root", { main: "../outside.js" }],
  ])("does not treat %s as a packaged path", (_name, manifest) => {
    expect(findingsFor({ name: "pkg", version: "1.0.0", ...manifest }, [])).toEqual([]);
  });

  test("stays silent when the artifact has no manifest file to compare against", () => {
    // A metadata-only manifest (or a parse that produced no package.json) would
    // otherwise report every declared path as missing.
    const staged = [{ path: "index.js", size: 10, sha256: "a", flags: [], textSample: "" }];
    const manifest = { name: "pkg", version: "1.0.0", main: "missing.js" };

    expect(
      deterministicFindings(staged, [], manifest).filter(
        (finding) => finding.ruleId === "package-json.entrypoint-missing",
      ),
    ).toEqual([]);
  });
});
