import { describe, expect, test } from "vitest";
import {
  compareRebuildOutput,
  computeRebuildPlan,
  extractRepositoryDirectory,
  normalizeRebuildAttestation,
} from "../server/lib/rebuild-attestation.ts";
import { runRebuildSteps } from "../server/lib/rebuild-steps.ts";
import { parseStagedPublishDetails } from "../server/lib/staged-publishes.ts";

const GIT_HEAD = "a".repeat(40);

function basePlanInput(overrides = {}) {
  return {
    ecosystem: "npm",
    repository: "https://github.com/owner/repo",
    gitHead: GIT_HEAD,
    packageName: "@scope/pkg",
    version: "2.0.0",
    shasum: "4f7f5f1d5bcf2f72f6e4d6c4f3b2812d8a2f6c19",
    manifestText: JSON.stringify({ name: "@scope/pkg" }),
    ...overrides,
  };
}

describe("computeRebuildPlan", () => {
  test("builds a plan with gitHead first, then version-tag candidates", () => {
    const plan = computeRebuildPlan(basePlanInput());
    expect(plan).toEqual({
      repository: "https://github.com/owner/repo",
      refs: [
        { kind: "git-head", value: GIT_HEAD },
        { kind: "version-tag", value: "v2.0.0" },
        { kind: "version-tag", value: "@scope/pkg@2.0.0" },
        { kind: "version-tag", value: "2.0.0" },
      ],
      directory: null,
      packageName: "@scope/pkg",
      version: "2.0.0",
      expectedShasum: "4f7f5f1d5bcf2f72f6e4d6c4f3b2812d8a2f6c19",
    });
  });

  test("requires the npm ecosystem and a normalized https repository", () => {
    expect(computeRebuildPlan(basePlanInput({ ecosystem: "pypi" }))).toBeNull();
    expect(computeRebuildPlan(basePlanInput({ repository: null }))).toBeNull();
    expect(computeRebuildPlan(basePlanInput({ repository: "git@github.com:o/r.git" }))).toBeNull();
  });

  test("drops malformed gitHead values but keeps version tags", () => {
    const plan = computeRebuildPlan(basePlanInput({ gitHead: "main; rm -rf /" }));
    expect(plan?.refs).toEqual([
      { kind: "version-tag", value: "v2.0.0" },
      { kind: "version-tag", value: "@scope/pkg@2.0.0" },
      { kind: "version-tag", value: "2.0.0" },
    ]);
  });

  test("returns null when no checkout candidate exists", () => {
    expect(computeRebuildPlan(basePlanInput({ gitHead: null, version: null }))).toBeNull();
    expect(computeRebuildPlan(basePlanInput({ gitHead: null, version: "$(evil)" }))).toBeNull();
  });

  test("rejects a non-sha1 staged shasum instead of carrying it", () => {
    expect(computeRebuildPlan(basePlanInput({ shasum: "not-a-sha" }))?.expectedShasum).toBeNull();
  });

  test("carries a validated repository.directory for monorepos", () => {
    const manifestText = JSON.stringify({
      repository: { url: "https://github.com/owner/repo", directory: "packages/core" },
    });
    expect(computeRebuildPlan(basePlanInput({ manifestText }))?.directory).toBe("packages/core");
  });
});

describe("extractRepositoryDirectory", () => {
  test("accepts plain relative paths and trims ./ and trailing slashes", () => {
    const text = (directory) => JSON.stringify({ repository: { url: "x", directory } });
    expect(extractRepositoryDirectory(text("./packages/core/"))).toBe("packages/core");
  });

  test("rejects traversal, absolute paths, and hostile segments", () => {
    const text = (directory) => JSON.stringify({ repository: { url: "x", directory } });
    expect(extractRepositoryDirectory(text("../secrets"))).toBeNull();
    expect(extractRepositoryDirectory(text("a/../../b"))).toBeNull();
    expect(extractRepositoryDirectory(text("/etc"))).toBeNull();
    expect(extractRepositoryDirectory(text("a/$(evil)"))).toBeNull();
    expect(extractRepositoryDirectory(text("a/b c"))).toBeNull();
  });

  test("string repository declarations have no directory", () => {
    expect(
      extractRepositoryDirectory(JSON.stringify({ repository: "github:owner/repo" })),
    ).toBeNull();
  });
});

describe("compareRebuildOutput", () => {
  const stagedFiles = [
    { path: "package.json", sha256: "AA11" },
    { path: "dist/index.js", sha256: "bb22" },
  ];

  test("byte-identical when the tarball shasum matches and files agree", () => {
    const outcome = compareRebuildOutput({
      expectedShasum: "f".repeat(40),
      stagedFiles,
      output: {
        tarballSha1: "F".repeat(40),
        files: [
          { path: "./package/package.json", sha256: "aa11" },
          { path: "package/dist/index.js", sha256: "BB22" },
        ],
      },
    });
    expect(outcome?.status).toBe("byte-identical");
    expect(outcome?.comparison).toMatchObject({
      tarballShasumMatch: true,
      stagedFileCount: 2,
      rebuiltFileCount: 2,
      matchedFileCount: 2,
      divergentPaths: [],
      missingFromRebuild: [],
      extraInRebuild: [],
    });
  });

  test("file-identical when contents match but the tarball digest differs", () => {
    const outcome = compareRebuildOutput({
      expectedShasum: "f".repeat(40),
      stagedFiles,
      output: {
        tarballSha1: "e".repeat(40),
        files: [
          { path: "package.json", sha256: "aa11" },
          { path: "dist/index.js", sha256: "bb22" },
        ],
      },
    });
    expect(outcome?.status).toBe("file-identical");
    expect(outcome?.comparison.tarballShasumMatch).toBe(false);
  });

  test("a matching shasum with a differing file set stays diverged", () => {
    // Belt-and-braces: the tarball digest is compared against hostile output,
    // so byte-identical additionally requires the file sets to agree.
    const outcome = compareRebuildOutput({
      expectedShasum: "f".repeat(40),
      stagedFiles,
      output: {
        tarballSha1: "f".repeat(40),
        files: [{ path: "package.json", sha256: "aa11" }],
      },
    });
    expect(outcome?.status).toBe("diverged");
  });

  test("diverged reports sorted divergent/missing/extra path lists", () => {
    const outcome = compareRebuildOutput({
      expectedShasum: null,
      stagedFiles: [
        { path: "package.json", sha256: "aa11" },
        { path: "dist/index.js", sha256: "bb22" },
        { path: "dist/only-staged.js", sha256: "cc33" },
      ],
      output: {
        tarballSha1: null,
        files: [
          { path: "package.json", sha256: "aa11" },
          { path: "dist/index.js", sha256: "ff99" },
          { path: "dist/only-rebuilt.js", sha256: "dd44" },
        ],
      },
    });
    expect(outcome?.status).toBe("diverged");
    expect(outcome?.comparison).toMatchObject({
      tarballShasumMatch: null,
      matchedFileCount: 1,
      divergentPaths: ["dist/index.js"],
      missingFromRebuild: ["dist/only-staged.js"],
      extraInRebuild: ["dist/only-rebuilt.js"],
    });
  });

  test("returns null when staged hashes are incomplete", () => {
    expect(
      compareRebuildOutput({
        expectedShasum: null,
        stagedFiles: [{ path: "package.json", sha256: null }],
        output: { tarballSha1: null, files: [{ path: "package.json", sha256: "aa" }] },
      }),
    ).toBeNull();
    expect(
      compareRebuildOutput({
        expectedShasum: null,
        stagedFiles: [],
        output: { tarballSha1: null, files: [{ path: "package.json", sha256: "aa" }] },
      }),
    ).toBeNull();
  });
});

describe("normalizeRebuildAttestation", () => {
  const plan = {
    repository: "https://github.com/owner/repo",
    refs: [{ kind: "git-head", value: GIT_HEAD }],
    directory: null,
    packageName: "@scope/pkg",
    version: "2.0.0",
    expectedShasum: null,
  };

  test("round-trips a valid completed attestation", () => {
    const value = {
      status: "file-identical",
      plan,
      ref: { kind: "git-head", value: GIT_HEAD },
      toolchain: { packageManager: "pnpm@11.1.1", node: "v22.11.0" },
      comparison: {
        tarballShasumMatch: false,
        stagedFileCount: 3,
        rebuiltFileCount: 3,
        matchedFileCount: 3,
        divergentPaths: [],
        missingFromRebuild: [],
        extraInRebuild: [],
      },
      signals: [{ kind: "rebuild", detail: "ok" }],
      completedAt: "2026-07-17T00:00:00.000Z",
    };
    expect(normalizeRebuildAttestation(value)).toEqual(value);
  });

  test("verdicts must carry their evidence", () => {
    expect(normalizeRebuildAttestation({ status: "file-identical", plan })).toBeNull();
    expect(normalizeRebuildAttestation({ status: "pending" })).toBeNull();
    expect(normalizeRebuildAttestation({ status: "made-up" })).toBeNull();
    expect(normalizeRebuildAttestation(null)).toBeNull();
    expect(normalizeRebuildAttestation("file-identical")).toBeNull();
  });

  test("byte-identical requires a persisted tarball shasum match", () => {
    const value = {
      status: "byte-identical",
      plan,
      ref: null,
      toolchain: null,
      comparison: {
        tarballShasumMatch: false,
        stagedFileCount: 1,
        rebuiltFileCount: 1,
        matchedFileCount: 1,
        divergentPaths: [],
        missingFromRebuild: [],
        extraInRebuild: [],
      },
      signals: [],
      completedAt: null,
    };
    expect(normalizeRebuildAttestation(value)).toBeNull();
  });

  test("pending records require an actionable plan with valid refs", () => {
    expect(
      normalizeRebuildAttestation({
        status: "pending",
        plan: { ...plan, refs: [{ kind: "git-head", value: "not-a-sha" }] },
      }),
    ).toBeNull();
    const pending = normalizeRebuildAttestation({ status: "pending", plan });
    expect(pending?.status).toBe("pending");
    expect(pending?.plan?.refs).toEqual([{ kind: "git-head", value: GIT_HEAD }]);
  });
});

describe("staged publish details gitHead extraction", () => {
  test("reads a valid gitHead from the staged version manifest", () => {
    const details = parseStagedPublishDetails(
      {
        id: "stage-abc-123",
        packageName: "@scope/pkg",
        version: "2.0.0",
        versions: { "2.0.0": { name: "@scope/pkg", version: "2.0.0", gitHead: GIT_HEAD } },
      },
      "stage-abc-123",
    );
    expect(details?.gitHead).toBe(GIT_HEAD);
  });

  test("drops non-sha gitHead values", () => {
    const details = parseStagedPublishDetails(
      {
        id: "stage-abc-123",
        packageName: "@scope/pkg",
        version: "2.0.0",
        manifest: { gitHead: "refs/heads/main" },
      },
      "stage-abc-123",
    );
    expect(details?.gitHead).toBeNull();
  });
});

describe("runRebuildSteps", () => {
  const plan = {
    repository: "https://github.com/owner/repo",
    refs: [
      { kind: "git-head", value: GIT_HEAD },
      { kind: "version-tag", value: "v2.0.0" },
    ],
    directory: null,
    packageName: "@scope/pkg",
    version: "2.0.0",
    expectedShasum: null,
  };

  const ok = (stdout = "") => ({
    success: true,
    exitCode: 0,
    stdout,
    stderr: "",
    duration: 10,
  });
  const fail = (stderr = "boom") => ({
    success: false,
    exitCode: 1,
    stdout: "",
    stderr,
    duration: 10,
  });

  function scriptedSandbox(script) {
    const commands = [];
    return {
      commands,
      exec: async (command) => {
        commands.push(command);
        for (const [pattern, result] of script) {
          if (command.includes(pattern)) return result;
        }
        return ok();
      },
    };
  }

  const manifestStdout = (manifest, listing) => `${JSON.stringify(manifest)}\n\n${listing}`;
  const hashStdout = [
    "f".repeat(40),
    `${"1".repeat(64)}  ./package.json`,
    `${"2".repeat(64)}  ./dist/index.js`,
  ].join("\n");

  test("happy path: npm strategy produces a hash manifest", async () => {
    const sandbox = scriptedSandbox([
      [
        "cat ",
        ok(
          manifestStdout(
            { name: "@scope/pkg", scripts: { build: "tsc" } },
            "package.json\npackage-lock.json",
          ),
        ),
      ],
      ["--version", ok("v22.11.0\n10.9.0")],
      ["sha1sum", ok(hashStdout)],
    ]);
    const execution = await runRebuildSteps(sandbox, plan);
    expect(execution.ok).toBe(true);
    expect(execution.ref).toEqual({ kind: "git-head", value: GIT_HEAD });
    expect(execution.toolchain).toEqual({ packageManager: "npm@10.9.0", node: "v22.11.0" });
    expect(execution.output).toEqual({
      tarballSha1: "f".repeat(40),
      files: [
        { path: "./package.json", sha256: "1".repeat(64) },
        { path: "./dist/index.js", sha256: "2".repeat(64) },
      ],
    });
    const joined = sandbox.commands.join("\n");
    expect(joined).toContain("npm ci --ignore-scripts");
    expect(joined).toContain("npm run build");
    expect(joined).toContain("npm pack --pack-destination");
  });

  test("falls back to the version tag when the sha fetch fails", async () => {
    const sandbox = scriptedSandbox([
      [`fetch -q --depth 1 origin '${GIT_HEAD}'`, fail("not found")],
      ["cat ", ok(manifestStdout({ name: "@scope/pkg" }, "package.json"))],
      ["--version", ok("v22.11.0\n10.9.0")],
      ["sha1sum", ok(hashStdout)],
    ]);
    const execution = await runRebuildSteps(sandbox, plan);
    expect(execution.ok).toBe(true);
    expect(execution.ref).toEqual({ kind: "version-tag", value: "v2.0.0" });
  });

  test("pnpm packageManager pins the toolchain through corepack", async () => {
    const sandbox = scriptedSandbox([
      [
        "cat ",
        ok(manifestStdout({ name: "@scope/pkg", packageManager: "pnpm@11.1.1" }, "pnpm-lock.yaml")),
      ],
      ["--version", ok("v22.11.0\n11.1.1")],
      ["sha1sum", ok(hashStdout)],
    ]);
    const execution = await runRebuildSteps(sandbox, plan);
    expect(execution.ok).toBe(true);
    expect(execution.toolchain?.packageManager).toBe("pnpm@11.1.1");
    const joined = sandbox.commands.join("\n");
    expect(joined).toContain("corepack prepare 'pnpm@11.1.1' --activate");
    expect(joined).toContain("pnpm install --ignore-scripts --frozen-lockfile");
    expect(joined).toContain("pnpm pack --pack-destination");
  });

  test("yarn repositories are reported as unsupported", async () => {
    const sandbox = scriptedSandbox([
      ["cat ", ok(manifestStdout({ name: "@scope/pkg" }, "yarn.lock"))],
    ]);
    const execution = await runRebuildSteps(sandbox, plan);
    expect(execution).toMatchObject({ ok: false, failure: "unsupported-package-manager" });
  });

  test("checkout failure across all refs surfaces step details", async () => {
    const sandbox = scriptedSandbox([["git ", fail("fatal: repository not found")]]);
    const execution = await runRebuildSteps(sandbox, plan);
    expect(execution).toMatchObject({ ok: false, failure: "checkout-failed" });
    const checkoutSteps = execution.steps.filter((step) => step.step.startsWith("checkout"));
    expect(checkoutSteps).toHaveLength(2);
    expect(checkoutSteps[0].detail).toContain("repository not found");
  });

  test("build failures stop before pack", async () => {
    const sandbox = scriptedSandbox([
      [
        "cat ",
        ok(manifestStdout({ name: "@scope/pkg", scripts: { build: "tsc" } }, "package.json")),
      ],
      ["--version", ok("v22.11.0\n10.9.0")],
      ["run build", fail("TS2304: Cannot find name")],
    ]);
    const execution = await runRebuildSteps(sandbox, plan);
    expect(execution).toMatchObject({ ok: false, failure: "build-failed" });
    expect(sandbox.commands.join("\n")).not.toContain("npm pack");
  });

  test("locates a workspace package by name when no directory is declared", async () => {
    const sandbox = scriptedSandbox([
      // Root manifest belongs to the workspace root, not the staged package.
      [
        "cat '/workspace/rebuild/repo/package.json'",
        ok(
          manifestStdout({ name: "monorepo-root", private: true }, "package.json\npnpm-lock.yaml"),
        ),
      ],
      ["grep -lE", ok("./packages/core/package.json\n")],
      [
        "cat '/workspace/rebuild/repo/packages/core/package.json'",
        ok(JSON.stringify({ name: "@scope/pkg", scripts: { build: "tsc" } })),
      ],
      ["--version", ok("v22.11.0\n11.1.1")],
      ["sha1sum", ok(hashStdout)],
    ]);
    const execution = await runRebuildSteps(sandbox, plan);
    expect(execution.ok).toBe(true);
    const joined = sandbox.commands.join("\n");
    // pnpm detected from the ROOT lockfile even though the package dir has none.
    expect(joined).toContain("pnpm install --ignore-scripts");
    expect(joined).toContain("cd '/workspace/rebuild/repo/packages/core' && pnpm run build");
    expect(joined).toContain('"name"[[:space:]]*:[[:space:]]*"@scope/pkg"');
  });

  test("fails as package-not-located when the workspace has no matching manifest", async () => {
    const sandbox = scriptedSandbox([
      [
        "cat '/workspace/rebuild/repo/package.json'",
        ok(manifestStdout({ name: "monorepo-root" }, "package.json")),
      ],
      ["grep -lE", fail("")],
    ]);
    const execution = await runRebuildSteps(sandbox, plan);
    expect(execution).toMatchObject({ ok: false, failure: "package-not-located" });
  });

  test("hostile locate output is rejected instead of trusted as a path", async () => {
    const sandbox = scriptedSandbox([
      [
        "cat '/workspace/rebuild/repo/package.json'",
        ok(manifestStdout({ name: "monorepo-root" }, "package.json")),
      ],
      ["grep -lE", ok("./../../../etc/package.json\n./a/$(evil)/package.json\n")],
    ]);
    const execution = await runRebuildSteps(sandbox, plan);
    expect(execution).toMatchObject({ ok: false, failure: "package-not-located" });
  });

  test("monorepo directory scopes build and pack, not install", async () => {
    const sandbox = scriptedSandbox([
      [
        "cat '/workspace/rebuild/repo/packages/core/package.json'",
        ok(JSON.stringify({ name: "@scope/pkg", scripts: { build: "tsc" } })),
      ],
      [
        "cat '/workspace/rebuild/repo/package.json'",
        ok(manifestStdout({ name: "monorepo-root", private: true }, "package.json")),
      ],
      ["--version", ok("v22.11.0\n10.9.0")],
      ["sha1sum", ok(hashStdout)],
    ]);
    await runRebuildSteps(sandbox, { ...plan, directory: "packages/core" });
    const joined = sandbox.commands.join("\n");
    expect(joined).toContain("cat '/workspace/rebuild/repo/packages/core/package.json'");
    expect(joined).toContain("cd '/workspace/rebuild/repo' && (npm ci --ignore-scripts");
    expect(joined).toContain("cd '/workspace/rebuild/repo/packages/core' && npm run build");
  });
});
