import { describe, expect, test } from "vitest";
import {
  bundledDependencyNames,
  classifyDependencySpec,
  dependencyLookupQueue,
  dependencyReadinessAppliesToScan,
  dependencyReadinessTargets,
  evaluateDependencyReadiness,
  packedDependencyNames,
  planDependencyReadiness,
  runDependencyLookups,
  type PackageVersionsLookup,
  type PackageVersionsReadMode,
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

describe("dependencyReadinessAppliesToScan", () => {
  const gate = (ecosystem: string) => ({
    status: "complete",
    source: "workflow_gate",
    summaryJson: { stagedPublish: { provenance: { ecosystem } } },
  });

  test("only completed npm reviews that still await a decision", () => {
    const staged = { status: "complete", source: "auto_discovery", summaryJson: null };
    expect(dependencyReadinessAppliesToScan(staged)).toBe(true);
    expect(dependencyReadinessAppliesToScan({ ...staged, source: "manual" })).toBe(true);
    expect(dependencyReadinessAppliesToScan(gate("npm"))).toBe(true);
    expect(dependencyReadinessAppliesToScan(gate("pypi"))).toBe(false);
    expect(dependencyReadinessAppliesToScan({ ...staged, status: "running" })).toBe(false);
    expect(dependencyReadinessAppliesToScan({ ...staged, source: "published" })).toBe(false);
  });

  test("a gate scan without provenance is never guessed to be npm", () => {
    expect(dependencyReadinessAppliesToScan({ ...gate("npm"), summaryJson: null })).toBe(false);
  });
});

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
    const packed = packedDependencyNames([
      "package.json",
      "node_modules/local-only/package.json",
      "node_modules/@scope/inner/package.json",
      "node_modules/local-only/node_modules/deep/package.json",
    ]);
    expect([...packed].sort()).toEqual(["@scope/inner", "local-only"]);
    const bundled = bundledDependencyNames(packed, { bundleDependencies: ["local-only"] });
    expect([...bundled]).toEqual(["local-only"]);
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

  test("a packed node_modules directory counts only when the manifest bundles it", () => {
    const packed = new Set(["a", "b", "stray"]);
    expect([...bundledDependencyNames(packed, { bundledDependencies: ["a", "missing"] })]).toEqual([
      "a",
    ]);
    expect(
      [
        ...bundledDependencyNames(packed, {
          bundleDependencies: true,
          dependencies: { a: "^1", b: "^1" },
        }),
      ].sort(),
    ).toEqual(["a", "b"]);
    expect([...bundledDependencyNames(packed, {})]).toEqual([]);
    expect([...bundledDependencyNames(packed, null)]).toEqual([]);
  });

  test("an oversized manifest keeps changed dependencies before truncating", () => {
    const dependencies: Record<string, string> = {};
    for (let i = 0; i < 1_005; i++) dependencies[`dep-${String(i).padStart(4, "0")}`] = "^1.0.0";
    const plan = planDependencyReadiness(
      { dependencies },
      { changed: [{ key: "dep-1004", section: "dependencies", status: "modified" }] },
    );
    expect(plan.requirements).toHaveLength(1_000);
    const names = plan.requirements.map((r) => r.name);
    expect(names).toContain("dep-1004");
    expect(names.at(-1)).toBe("dep-1004");
    expect(names[0]).toBe("dep-0000");
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

  test.each(["x", ">=0.0.0", "* || 2.0.0-rc.1"])(
    "%j matches every stable version but never a prerelease latest",
    (spec) => {
      const plan = planDependencyReadiness({ dependencies: { b: spec } });
      const report = evaluate({
        plan,
        siblings: [],
        candidates: [],
        lookups: new Map([["b", found(["1.0.0-beta.1"], { latest: "1.0.0-beta.1" })]]),
      });
      expect(report.issues.map((i) => i.kind)).toEqual(["unpublished"]);
    },
  );

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

  // A registry whose packuments land in a cache, like the real read path.
  function cachedRegistry(packuments: (name: string) => PackageVersionsLookup) {
    const cache = new Map<string, PackageVersionsLookup>();
    const calls: Array<[string, PackageVersionsReadMode]> = [];
    const lookup = async (name: string, mode: PackageVersionsReadMode) => {
      calls.push([name, mode]);
      if (mode === "cache") return cache.get(name) ?? null;
      const answer = packuments(name);
      if (answer.status === "found") cache.set(name, answer);
      return answer;
    };
    return { cache, calls, lookup };
  }

  test("cache hits cost no registry read; misses come before revalidations", async () => {
    const plan = planDependencyReadiness({
      dependencies: { a: "^2.0.0", b: "^1.0.0", c: "^1.0.0", d: "^1.0.0" },
    });
    const registry = cachedRegistry((name) =>
      name === "b" ? { status: "error" } : found(name === "a" ? ["2.0.0"] : ["1.0.0"]),
    );
    registry.cache.set("a", found(["1.0.0"])); // stale "not yet"
    registry.cache.set("c", found(["1.0.0"])); // satisfied
    const { answers } = await runDependencyLookups(plan, ["a", "b", "c", "d"], registry.lookup, {
      maxRegistryReads: 2,
      concurrency: 1,
    });
    expect(registry.calls.filter(([, mode]) => mode === "network")).toEqual([
      ["b", "network"],
      ["d", "network"],
    ]);
    // `a` keeps its cached answer: the budget went to targets with no answer.
    expect(answers.get("a")).toEqual(found(["1.0.0"]));
    expect(answers.get("b")).toEqual({ status: "error" });
    expect(answers.get("c")).toEqual(found(["1.0.0"]));
    expect(answers.get("d")).toEqual(found(["1.0.0"]));
  });

  test("leftover budget re-reads an unsatisfied cached answer; a failed re-read keeps it", async () => {
    const plan = planDependencyReadiness({ dependencies: { a: "^2.0.0", e: "^2.0.0" } });
    const registry = cachedRegistry((name) =>
      name === "a" ? found(["1.0.0", "2.0.0"]) : { status: "error" },
    );
    registry.cache.set("a", found(["1.0.0"]));
    registry.cache.set("e", found(["1.0.0"]));
    const { answers } = await runDependencyLookups(plan, ["a", "e"], registry.lookup);
    expect(answers.get("a")).toEqual(found(["1.0.0", "2.0.0"]));
    expect(answers.get("e")).toEqual(found(["1.0.0"]));
  });

  test("a lockstep release past the read budget is fully checked across re-checks", async () => {
    // Babel-style: 70 dependencies all bumped to a version that is only staged.
    const names = Array.from({ length: 70 }, (_, i) => `@babel/dep-${i}`);
    const plan = planDependencyReadiness({
      dependencies: Object.fromEntries(names.map((name) => [name, "^7.30.0"])),
    });
    const candidates = names.map((name) => staged(name, "7.30.0"));
    const registry = cachedRegistry(() => found(["7.29.0"], { latest: "7.29.0" }));
    const check = async () => {
      const queue = dependencyLookupQueue(plan, [], candidates);
      const { answers, beyondLimit } = await runDependencyLookups(plan, queue, registry.lookup);
      return evaluate({ plan, siblings: [], candidates, lookups: answers, beyondLimit });
    };
    const count = (report: Awaited<ReturnType<typeof check>>, kind: string, reason?: string) =>
      report.issues.filter((i) => i.kind === kind && (reason === undefined || i.reason === reason))
        .length;

    const networkReads = () => {
      const reads = registry.calls.filter(([, mode]) => mode === "network").map(([n]) => n);
      registry.calls.length = 0;
      return reads;
    };

    const first = await check();
    expect(count(first, "staged")).toBe(40);
    expect(count(first, "unchecked", "lookup-skipped")).toBe(30);
    expect(count(first, "unchecked", "lookup-failed")).toBe(0);
    const firstReads = networkReads();
    expect(firstReads).toHaveLength(40);

    const second = await check();
    expect(count(second, "staged")).toBe(70);
    expect(count(second, "unchecked")).toBe(0);
    // The second check read the 30 it had not answered before reusing the budget.
    const unanswered = names.filter((name) => !firstReads.includes(name)).sort();
    expect(networkReads().slice(0, 30).sort()).toEqual(unanswered);
  });

  test("targets past the check's limit are reported as beyond it, never read", async () => {
    const plan = planDependencyReadiness({ dependencies: { a: "^1.0.0", b: "^1.0.0" } });
    const registry = cachedRegistry(() => found(["1.0.0"]));
    const { answers, beyondLimit } = await runDependencyLookups(plan, ["a", "b"], registry.lookup, {
      maxTargets: 1,
    });
    expect(registry.calls.map(([name]) => name)).not.toContain("b");
    const report = evaluate({ plan, siblings: [], candidates: [], lookups: answers, beyondLimit });
    expect(report.issues.map((i) => [i.name, i.reason])).toEqual([["b", "lookup-limit"]]);
  });

  test("stops starting registry reads once the time budget is spent", async () => {
    const plan = planDependencyReadiness({ dependencies: { a: "^1.0.0", b: "^1.0.0" } });
    let clock = 0;
    const { answers } = await runDependencyLookups(
      plan,
      ["a", "b"],
      async (_name, mode) => {
        if (mode === "cache") return null;
        clock += 5_000;
        return found(["1.0.0"]);
      },
      { concurrency: 1, budgetMs: 4_000, now: () => clock },
    );
    expect([...answers.keys()]).toEqual(["a"]);
  });
});
