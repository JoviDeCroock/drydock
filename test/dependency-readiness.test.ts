import { describe, expect, test } from "vitest";
import {
  bundledDependencyNames,
  classifyDependencySpec,
  dependencyLookupQueue,
  dependencyReadinessTargets,
  evaluateDependencyReadiness,
  planDependencyReadiness,
  runDependencyLookups,
  type PackageVersionsLookup,
  type StagedDependencyCandidate,
} from "../server/lib/ecosystems/npm/dependency-readiness";

const found = (
  versions: string[],
  distTags: Record<string, string> = {},
): PackageVersionsLookup => ({
  status: "found",
  versions,
  distTags,
});

const evaluate = (input: Omit<Parameters<typeof evaluateDependencyReadiness>[0], "credentialed">) =>
  evaluateDependencyReadiness({ credentialed: true, ...input });

function staged(
  packageName: string,
  version: string,
  extra: Partial<StagedDependencyCandidate> = {},
): StagedDependencyCandidate {
  return {
    scanId: `scan_${packageName}_${version}`,
    packageName,
    version,
    decision: null,
    registryVersionStatus: "staged",
    ...extra,
  };
}

describe("classifyDependencySpec", () => {
  test.each([
    ["^2.0.0", "registry"],
    ["", "registry"],
    ["latest", "registry"],
    ["npm:@scope/real@^1.0.0", "registry"],
    ["workspace:^", "local"],
    ["catalog:", "local"],
    ["file:../b", "local"],
    ["link:../b", "local"],
    ["../b", "local"],
    ["./vendor/b.tgz", "local"],
    ["github:owner/repo", "remote"],
    ["owner/repo#v1", "remote"],
    ["git+https://github.com/owner/repo.git", "remote"],
    ["https://example.com/b.tgz", "remote"],
    ["npm:b@workspace:*", "invalid"],
    ["^1 ||| junk", "invalid"],
  ])("%j is %s", (spec, kind) => {
    expect(classifyDependencySpec("b", spec).kind).toBe(kind);
  });

  test("an npm: alias resolves to its target package and range", () => {
    const classified = classifyDependencySpec("b", "npm:@scope/real@^1.0.0");
    expect(classified).toMatchObject({ kind: "registry", target: "@scope/real", tag: null });
    const bare = classifyDependencySpec("b", "npm:real");
    expect(bare).toMatchObject({ kind: "registry", target: "real" });
  });
});

describe("planDependencyReadiness", () => {
  test("installs dependencies and optional dependencies, labels peers, skips optional peers", () => {
    const plan = planDependencyReadiness({
      dependencies: { a: "^1.0.0", shared: "^1.0.0" },
      optionalDependencies: { shared: "^2.0.0", opt: "^1.0.0" },
      peerDependencies: { a: "^1.0.0", peer: "^3.0.0", optPeer: "^4.0.0" },
      peerDependenciesMeta: { optPeer: { optional: true } },
      devDependencies: { dev: "^1.0.0" },
    });
    expect(plan.requirements.map((r) => [r.section, r.name, r.spec])).toEqual([
      ["dependencies", "a", "^1.0.0"],
      ["optionalDependencies", "shared", "^2.0.0"],
      ["optionalDependencies", "opt", "^1.0.0"],
      ["peerDependencies", "peer", "^3.0.0"],
    ]);
  });

  test("ignores non-string specs from hostile manifests", () => {
    const plan = planDependencyReadiness({
      dependencies: { ok: "^1.0.0", bad: 42 as unknown as string },
    });
    expect(plan.requirements.map((r) => r.name)).toEqual(["ok"]);
  });

  test("dependencies named like Object.prototype members are checked as themselves", () => {
    const plan = planDependencyReadiness({
      dependencies: { constructor: "^1.0.0", toString: "^2.0.0" },
      peerDependencies: { valueOf: "^3.0.0", hasOwnProperty: "^1.0.0" },
    });
    expect(plan.requirements.map((r) => [r.section, r.name])).toEqual([
      ["dependencies", "constructor"],
      ["dependencies", "toString"],
      ["peerDependencies", "valueOf"],
      ["peerDependencies", "hasOwnProperty"],
    ]);
  });

  test("bundled dependencies are satisfied by the tarball itself", () => {
    const bundled = bundledDependencyNames([
      "package.json",
      "node_modules/local-only/package.json",
      "node_modules/@scope/inner/package.json",
      "node_modules/local-only/node_modules/deep/package.json",
    ]);
    expect([...bundled].sort()).toEqual(["@scope/inner", "local-only"]);
    const plan = planDependencyReadiness(
      { dependencies: { "local-only": "file:./local-only" } },
      { bundled },
    );
    const report = evaluate({
      plan,
      siblings: [],
      candidates: [],
      lookups: new Map(),
    });
    expect(report.issues).toEqual([]);
    expect(dependencyReadinessTargets(plan)).toEqual([]);
  });
});

describe("evaluateDependencyReadiness", () => {
  test("names the staged sibling to approve first", () => {
    const plan = planDependencyReadiness({ dependencies: { b: "^2.0.0" } });
    const report = evaluate({
      plan,
      siblings: [],
      candidates: [staged("b", "2.0.0"), staged("b", "3.0.0")],
      lookups: new Map([["b", found(["1.0.0", "1.4.0"], { latest: "1.4.0" })]]),
    });
    expect(report.issues).toEqual([
      {
        name: "b",
        spec: "^2.0.0",
        section: "dependencies",
        kind: "staged",
        staged: {
          scanId: "scan_b_2.0.0",
          version: "2.0.0",
          decision: null,
          registryVersionStatus: "staged",
        },
      },
    ]);
  });

  test("a published satisfying version is enough, whatever is staged", () => {
    const plan = planDependencyReadiness({ dependencies: { b: "^2.0.0" } });
    const report = evaluate({
      plan,
      siblings: [],
      candidates: [staged("b", "2.1.0")],
      lookups: new Map([["b", found(["2.0.0"])]]),
    });
    expect(report.issues).toEqual([]);
  });

  test("reports unpublished dependencies, and whether the package exists at all", () => {
    const plan = planDependencyReadiness({
      dependencies: { b: "^2.0.0", ghost: "^1.0.0", tagged: "next" },
    });
    const report = evaluate({
      plan,
      siblings: [],
      // A blocked stage will never install, so it is not offered as the fix.
      candidates: [staged("b", "2.0.0", { registryVersionStatus: "blocked" })],
      lookups: new Map<string, PackageVersionsLookup>([
        ["b", found(["1.0.0"])],
        ["ghost", { status: "not-found" }],
        ["tagged", found(["1.0.0"], { latest: "1.0.0" })],
      ]),
    });
    expect(report.issues.map((i) => [i.name, i.kind, i.packageFound])).toEqual([
      ["b", "unpublished", true],
      ["ghost", "unpublished", false],
      ["tagged", "unpublished", true],
    ]);
  });

  test("prerelease ranges follow npm: a stable range never resolves to a prerelease", () => {
    const plan = planDependencyReadiness({ dependencies: { b: "^2.0.0", c: "^3.0.0-rc.0" } });
    const report = evaluate({
      plan,
      siblings: [],
      candidates: [staged("b", "2.0.0-rc.1")],
      lookups: new Map([
        ["b", found(["1.0.0", "2.0.0-rc.0"])],
        ["c", found(["3.0.0-rc.1"])],
      ]),
    });
    expect(report.issues.map((i) => [i.name, i.kind])).toEqual([["b", "unpublished"]]);
  });

  test("`*` resolves to latest even when latest is a prerelease", () => {
    const plan = planDependencyReadiness({ dependencies: { b: "*" } });
    const report = evaluate({
      plan,
      siblings: [],
      candidates: [],
      lookups: new Map([["b", found(["1.0.0-beta.1"], { latest: "1.0.0-beta.1" })]]),
    });
    expect(report.issues).toEqual([]);
  });

  test("aliases are checked against their target and report it", () => {
    const plan = planDependencyReadiness({ dependencies: { b: "npm:@scope/real@^2.0.0" } });
    const report = evaluate({
      plan,
      siblings: [],
      candidates: [],
      lookups: new Map([["@scope/real", found(["1.0.0"])]]),
    });
    expect(report.issues).toEqual([
      expect.objectContaining({ name: "b", target: "@scope/real", kind: "unpublished" }),
    ]);
  });

  test("a gated release's other packages satisfy each other", () => {
    const plan = planDependencyReadiness({ dependencies: { b: "^2.0.0", c: "^1.0.0" } });
    const siblings = [{ name: "b", version: "2.0.0" }];
    expect(dependencyLookupQueue(plan, siblings, [])).toEqual(["c"]);
    const report = evaluate({
      plan,
      siblings,
      candidates: [],
      lookups: new Map([["c", found(["1.0.0"])]]),
    });
    expect(report).toMatchObject({ satisfiedByRelease: 1, issues: [] });
  });

  test("a stage npm rejected or removed is never offered as the fix", () => {
    const plan = planDependencyReadiness({ dependencies: { b: "^2.0.0" } });
    const report = evaluate({
      plan,
      siblings: [],
      candidates: [staged("b", "2.0.0", { registryVersionStatus: "deleted" })],
      lookups: new Map([["b", found(["1.0.0"])]]),
    });
    expect(report.issues.map((i) => i.kind)).toEqual(["unpublished"]);
  });

  test("a stage npm already reports published needs no registry read", () => {
    const plan = planDependencyReadiness({ dependencies: { b: "^2.0.0" } });
    const candidates = [staged("b", "2.0.0", { registryVersionStatus: "published" })];
    expect(dependencyLookupQueue(plan, [], candidates)).toEqual([]);
    expect(evaluate({ plan, siblings: [], candidates, lookups: new Map() }).issues).toEqual([]);
  });

  test("local specs are flagged, remote specs are counted but not checked", () => {
    const plan = planDependencyReadiness({
      dependencies: { w: "workspace:^", g: "github:owner/repo", junk: "npm:b@file:x" },
    });
    const report = evaluate({
      plan,
      siblings: [],
      candidates: [],
      lookups: new Map(),
    });
    expect(report.notRegistry).toBe(1);
    expect(report.issues.map((i) => [i.name, i.kind, i.reason])).toEqual([
      ["w", "local-spec", undefined],
      ["junk", "unchecked", "unsupported-spec"],
    ]);
  });

  test("a failed or skipped lookup is unchecked, never unpublished", () => {
    const plan = planDependencyReadiness({ dependencies: { b: "^2.0.0", c: "^1.0.0" } });
    const report = evaluate({
      plan,
      siblings: [],
      candidates: [staged("b", "2.0.0")],
      lookups: new Map([["b", { status: "error" } as const]]),
    });
    expect(report.issues.map((i) => [i.name, i.kind, i.reason])).toEqual([
      ["b", "unchecked", "lookup-failed"],
      ["c", "unchecked", "lookup-skipped"],
    ]);
  });
});

describe("dependencyLookupQueue + runDependencyLookups", () => {
  test("looks up changed specs first, then dependencies, optional, peers", () => {
    const plan = planDependencyReadiness(
      {
        dependencies: { a: "^1.0.0", z: "^1.0.0" },
        optionalDependencies: { o: "^1.0.0" },
        peerDependencies: { p: "^1.0.0" },
      },
      { changed: [{ key: "z", section: "dependencies", status: "modified" }] },
    );
    expect(dependencyLookupQueue(plan, [], [])).toEqual(["z", "a", "o", "p"]);
  });

  test("caps lookups, and an unsatisfied cached answer is re-read fresh once", async () => {
    const plan = planDependencyReadiness({
      dependencies: { a: "^2.0.0", b: "^1.0.0", c: "^1.0.0" },
    });
    const calls: Array<[string, boolean]> = [];
    const lookups = await runDependencyLookups(
      plan,
      ["a", "b", "c"],
      async (name, { fresh }) => {
        calls.push([name, fresh]);
        if (name === "a") return found(fresh ? ["2.0.0"] : ["1.0.0"]);
        if (name === "b") throw new Error("boom");
        return found(["1.0.0"]);
      },
      { maxLookups: 2, concurrency: 1 },
    );
    expect(calls).toEqual([
      ["a", false],
      ["a", true],
      ["b", false],
    ]);
    expect(lookups.get("a")).toEqual(found(["2.0.0"]));
    expect(lookups.get("b")).toEqual({ status: "error" });
    expect(lookups.has("c")).toBe(false);
  });

  test("an answer just read from the registry is not read again", async () => {
    const plan = planDependencyReadiness({ dependencies: { a: "^2.0.0" } });
    const calls: boolean[] = [];
    await runDependencyLookups(plan, ["a"], async (_name, { fresh }) => {
      calls.push(fresh);
      return { ...found(["1.0.0"]), fromCache: false };
    });
    expect(calls).toEqual([false]);
  });

  test("stops starting lookups once the time budget is spent", async () => {
    const plan = planDependencyReadiness({ dependencies: { a: "^1.0.0", b: "^1.0.0" } });
    let clock = 0;
    const lookups = await runDependencyLookups(
      plan,
      ["a", "b"],
      async () => {
        clock += 5_000;
        return found(["1.0.0"]);
      },
      { concurrency: 1, budgetMs: 4_000, now: () => clock },
    );
    expect([...lookups.keys()]).toEqual(["a"]);
  });
});
