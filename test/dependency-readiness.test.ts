import { describe, expect, test } from "vitest";
import {
  bundledDependencyNames,
  clampLookupOffset,
  classifyDependencySpec,
  dependencyLookupQueue,
  dependencyReadinessAppliesToScan,
  dependencyReadinessTargets,
  evaluateDependencyReadiness,
  packedDependencyNames,
  planDependencyReadiness,
  runDependencyLookups,
  type DependencyLookupSource,
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
      // Only prereleases are published, and `latest` is one of them.
      const prereleaseOnly = found(["1.0.0-beta.1", "1.0.0-beta.2"], { latest: "1.0.0-beta.2" });
      const check = (s: string) =>
        evaluate({
          plan: planDependencyReadiness({ dependencies: { b: s } }),
          siblings: [],
          candidates: [],
          lookups: new Map([["b", prereleaseOnly]]),
        }).issues.map((i) => i.kind);
      // Each spec parses to the same match-anything range as `*`; only the
      // literal `*` takes npm's latest shortcut.
      expect(check("*")).toEqual([]);
      expect(check(spec)).toEqual(["unpublished"]);
    },
  );

  test("a registry document too large to read is its own non-retryable reason", () => {
    const plan = planDependencyReadiness({ dependencies: { next: "^15.0.0" } });
    const report = evaluate({
      plan,
      siblings: [],
      candidates: [],
      lookups: new Map([["next", { status: "too-large" } as const]]),
    });
    expect(report.issues.map((i) => [i.name, i.kind, i.reason])).toEqual([
      ["next", "unchecked", "too-large"],
    ]);
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

  // Workers KV as one colo sees it: reading a missing key caches the miss for a
  // minute, so a write made after that read stays invisible until the miss
  // expires, and entries expire after the 5-minute TTL. A plain Map would hide
  // exactly the behavior the resume offset exists for.
  function kvRegistry(packuments: (name: string) => PackageVersionsLookup) {
    const clock = { now: 0 };
    const store = new Map<string, { value: PackageVersionsLookup; expires: number }>();
    const cachedMisses = new Map<string, number>();
    const batches: string[][] = [];
    const source: DependencyLookupSource = {
      async cached(name) {
        const missUntil = cachedMisses.get(name);
        if (missUntil !== undefined && missUntil > clock.now) return null;
        const entry = store.get(name);
        if (entry && entry.expires > clock.now) return entry.value;
        cachedMisses.set(name, clock.now + 60_000);
        return null;
      },
      async fetch(names) {
        batches.push(names);
        return names.map((name) => {
          const lookup = packuments(name);
          if (lookup.status !== "error") {
            store.set(name, { value: lookup, expires: clock.now + 300_000 });
          }
          return { name, lookup };
        });
      },
    };
    const seed = (name: string, value: PackageVersionsLookup) =>
      store.set(name, { value, expires: Number.POSITIVE_INFINITY });
    return { source, clock, batches, seed };
  }

  test("cache hits cost no registry read; misses come before revalidations", async () => {
    const plan = planDependencyReadiness({
      dependencies: { a: "^2.0.0", b: "^1.0.0", c: "^1.0.0", d: "^1.0.0" },
    });
    const kv = kvRegistry((name) =>
      name === "b" ? { status: "error" } : found(name === "a" ? ["2.0.0"] : ["1.0.0"]),
    );
    kv.seed("a", found(["1.0.0"])); // a stale "not yet"
    kv.seed("c", found(["1.0.0"])); // satisfied
    const { answers } = await runDependencyLookups(plan, ["a", "b", "c", "d"], kv.source, {
      maxRegistryReads: 2,
    });
    expect(kv.batches).toEqual([["b", "d"]]);
    // `a` keeps its cached answer: the budget went to targets with no answer.
    expect(answers.get("a")).toEqual(found(["1.0.0"]));
    expect(answers.get("b")).toEqual({ status: "error" });
    expect(answers.get("d")).toEqual(found(["1.0.0"]));
  });

  test("leftover budget re-reads cached negatives; a failed re-read keeps the cached answer", async () => {
    const plan = planDependencyReadiness({
      dependencies: { a: "^2.0.0", e: "^2.0.0", gone: "^1.0.0" },
    });
    const kv = kvRegistry((name) =>
      name === "a"
        ? found(["1.0.0", "2.0.0"])
        : name === "gone"
          ? found(["1.0.0"])
          : { status: "error" },
    );
    kv.seed("a", found(["1.0.0"]));
    kv.seed("e", found(["1.0.0"]));
    kv.seed("gone", { status: "not-found" });
    const { answers } = await runDependencyLookups(plan, ["a", "e", "gone"], kv.source);
    expect(kv.batches).toEqual([["a", "e", "gone"]]);
    expect(answers.get("a")).toEqual(found(["1.0.0", "2.0.0"]));
    expect(answers.get("e")).toEqual(found(["1.0.0"]));
    expect(answers.get("gone")).toEqual(found(["1.0.0"]));
  });

  test("a lockstep release past the read budget finishes across re-checks despite KV's cached misses", async () => {
    // Babel-style: 70 dependencies all bumped to a version that is only staged.
    const names = Array.from({ length: 70 }, (_, i) => `@babel/dep-${i}`);
    const plan = planDependencyReadiness({
      dependencies: Object.fromEntries(names.map((name) => [name, "^7.30.0"])),
    });
    const candidates = names.map((name) => staged(name, "7.30.0"));
    const kv = kvRegistry(() => found(["7.29.0"], { latest: "7.29.0" }));
    const check = async (offset?: number) => {
      const queue = dependencyLookupQueue(plan, [], candidates);
      const { answers, beyondLimit, nextOffset } = await runDependencyLookups(
        plan,
        queue,
        kv.source,
        { offset },
      );
      return evaluate({
        plan,
        siblings: [],
        candidates,
        lookups: answers,
        beyondLimit,
        nextOffset,
      });
    };
    const count = (report: Awaited<ReturnType<typeof check>>, reason?: string) =>
      report.issues.filter((i) => (reason ? i.reason === reason : i.kind === "staged")).length;

    const first = await check();
    expect(count(first)).toBe(40);
    expect(count(first, "lookup-skipped")).toBe(30);
    expect(first.nextOffset).toBe(40);

    // Clicked again at once: KV still hides the first check's 40 writes, so
    // only the offset keeps this check from re-reading them.
    const second = await check(first.nextOffset);
    const [firstReads, secondReads] = kv.batches;
    const unread = names.filter((name) => !firstReads.includes(name));
    expect(secondReads.slice(0, 30).sort()).toEqual(unread.sort());
    expect(secondReads.filter((name) => firstReads.includes(name))).toHaveLength(10);
    expect(count(second)).toBe(40);

    // Once KV's cached misses lapse (well inside the 5-minute TTL), every
    // answer is readable and the check is complete.
    kv.clock.now += 61_000;
    const third = await check(second.nextOffset);
    expect(count(third)).toBe(70);
    expect(count(third, "lookup-skipped")).toBe(0);
    expect(third.nextOffset).toBeUndefined();
  });

  test("failures that are never cached do not starve the dependencies after them", async () => {
    const names = Array.from({ length: 45 }, (_, i) => `dep-${String(i).padStart(2, "0")}`);
    const plan = planDependencyReadiness({
      dependencies: Object.fromEntries(names.map((name) => [name, "^1.0.0"])),
    });
    const failing = new Set(names.slice(0, 40));
    const kv = kvRegistry((name) => (failing.has(name) ? { status: "error" } : found(["1.0.0"])));
    const queue = dependencyLookupQueue(plan, [], []);
    const first = await runDependencyLookups(plan, queue, kv.source);
    expect(names.slice(40).some((name) => first.answers.has(name))).toBe(false);
    const second = await runDependencyLookups(plan, queue, kv.source, {
      offset: first.nextOffset ?? 0,
    });
    for (const name of names.slice(40)) expect(second.answers.get(name)).toEqual(found(["1.0.0"]));
  });

  test("a rejected batch fails every read in it and still advances the offset", async () => {
    const names = Array.from({ length: 45 }, (_, i) => `dep-${String(i).padStart(2, "0")}`);
    const plan = planDependencyReadiness({
      dependencies: Object.fromEntries(names.map((name) => [name, "^1.0.0"])),
    });
    const kv = kvRegistry(() => found(["1.0.0"]));
    kv.seed("dep-00", found(["0.9.0"])); // a cached negative the batch would re-read
    kv.source.fetch = async () => {
      throw new Error("broker call dropped");
    };
    const queue = dependencyLookupQueue(plan, [], []);
    const { answers, nextOffset } = await runDependencyLookups(plan, queue, kv.source);
    expect(answers.get("dep-01")).toEqual({ status: "error" });
    expect(answers.get("dep-00")).toEqual(found(["0.9.0"]));
    expect(nextOffset).toBe(41);
    const report = evaluate({ plan, siblings: [], candidates: [], lookups: answers, nextOffset });
    expect(report.issues.filter((i) => i.reason === "lookup-failed")).toHaveLength(40);
  });

  test("targets past the check's limit are reported as beyond it, never read", async () => {
    const plan = planDependencyReadiness({ dependencies: { a: "^1.0.0", b: "^1.0.0" } });
    const kv = kvRegistry(() => found(["1.0.0"]));
    const { answers, beyondLimit } = await runDependencyLookups(plan, ["a", "b"], kv.source, {
      maxTargets: 1,
    });
    expect(kv.batches.flat()).not.toContain("b");
    const report = evaluate({ plan, siblings: [], candidates: [], lookups: answers, beyondLimit });
    expect(report.issues.map((i) => [i.name, i.reason])).toEqual([["b", "lookup-limit"]]);
  });

  test("no registry batch starts once the time budget is spent", async () => {
    const plan = planDependencyReadiness({ dependencies: { a: "^1.0.0" } });
    let clock = 0;
    const kv = kvRegistry(() => found(["1.0.0"]));
    const cached = kv.source.cached;
    kv.source.cached = async (name) => {
      clock += 5_000;
      return cached(name);
    };
    const { answers, nextOffset } = await runDependencyLookups(plan, ["a"], kv.source, {
      budgetMs: 4_000,
      now: () => clock,
    });
    expect(kv.batches).toEqual([]);
    expect(answers.size).toBe(0);
    expect(nextOffset).toBe(0);
  });

  test("a client resume offset is clamped to the queue", () => {
    expect(clampLookupOffset("7")).toBe(7);
    expect(clampLookupOffset("299")).toBe(299);
    for (const value of [undefined, "", "-1", "1e3", "abc", "300", "99999", "4.5"]) {
      expect(clampLookupOffset(value)).toBe(0);
    }
  });
});
