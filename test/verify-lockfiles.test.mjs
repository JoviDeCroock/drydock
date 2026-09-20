import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  discoverDependencyPairs,
  diffPackageVersions,
  parsePackageLock,
  parsePnpmLock,
} from "../packages/verify/src/index.mjs";

const fixture = (name) =>
  readFileSync(new URL(`fixtures/verify-lockfiles/${name}`, import.meta.url), "utf8");

function packageLock(version, registryOrigin = "https://registry.npmjs.org") {
  return JSON.stringify({
    lockfileVersion: 3,
    packages: {
      "": {},
      "node_modules/left-pad": {
        version,
        resolved: `${registryOrigin}/left-pad/-/left-pad-${version}.tgz`,
      },
    },
  });
}

function publicPnpmLock(version) {
  return `lockfileVersion: 9.0\npackages:\n  left-pad@${version}:\n    resolution: { integrity: sha512-${version} }\n`;
}

function repositoryWith(filePath, contents) {
  const cwd = mkdtempSync(path.join(tmpdir(), "drydock-lockfiles-"));
  execFileSync("git", ["init", "-q"], { cwd });
  execFileSync("git", ["config", "user.email", "verify@example.com"], { cwd });
  execFileSync("git", ["config", "user.name", "Verify Test"], { cwd });
  mkdirSync(path.dirname(path.join(cwd, filePath)), { recursive: true });
  writeFileSync(path.join(cwd, filePath), contents);
  execFileSync("git", ["add", "."], { cwd });
  execFileSync("git", ["commit", "-qm", "base"], { cwd });
  return cwd;
}

describe("drydock verify lockfile parsing", () => {
  test("extracts unambiguous dependency pairs from package-lock v3", () => {
    const before = parsePackageLock(fixture("package-lock.before.json"));
    const after = parsePackageLock(fixture("package-lock.after.json"));

    expect(diffPackageVersions(before, after)).toEqual([
      { ecosystem: "npm", name: "@scope/tool", from: "2.0.0", to: "2.1.0" },
      { ecosystem: "npm", name: "shared", from: "2.0.0", to: "3.0.0" },
    ]);
  });

  test("reads the nested dependency tree from package-lock v1", () => {
    const versions = parsePackageLock(
      JSON.stringify({
        lockfileVersion: 1,
        dependencies: {
          parent: {
            version: "1.0.0",
            resolved: "https://registry.npmjs.org/parent/-/parent-1.0.0.tgz",
            dependencies: {
              child: {
                version: "2.0.0",
                resolved: "https://registry.npmjs.org/child/-/child-2.0.0.tgz",
              },
            },
          },
        },
      }),
    );
    expect(versions).toEqual(
      new Map([
        ["parent", new Set(["1.0.0"])],
        ["child", new Set(["2.0.0"])],
      ]),
    );
  });

  test("extracts package locators without mistaking snapshots or peer suffixes for versions", () => {
    const before = parsePnpmLock(fixture("pnpm-lock.before.yaml"));
    const after = parsePnpmLock(fixture("pnpm-lock.after.yaml"));

    expect(diffPackageVersions(before, after)).toEqual([
      { ecosystem: "npm", name: "@scope/tool", from: "2.0.0", to: "2.1.0" },
      { ecosystem: "npm", name: "react-dom", from: "19.1.0", to: "19.2.0" },
    ]);
  });

  test("reads legacy pnpm slash locators", () => {
    const versions = parsePnpmLock("packages:\n  /left-pad/1.3.0:\n  /@scope/tool/2.0.0:\n");
    expect(versions).toEqual(
      new Map([
        ["left-pad", new Set(["1.3.0"])],
        ["@scope/tool", new Set(["2.0.0"])],
      ]),
    );
  });

  test("reports an ambiguous many-to-one version change as unavailable, not verified", () => {
    // Dropping it silently made "verified nothing" read exactly like "verified
    // clean": the pair vanished, no policy ran, and the CLI exited 0 saying no
    // changed pairs were found.
    const before = new Map([["shared", new Set(["1.0.0", "2.0.0"])]]);
    const after = new Map([["shared", new Set(["3.0.0"])]]);
    const [pair] = diffPackageVersions(before, after);
    expect(pair).toMatchObject({ name: "shared" });
    expect(pair.unavailableReason).toMatch(/several versions/);
  });

  test("reports an ambiguous many-to-many version change as unavailable", () => {
    const before = new Map([["shared", new Set(["1.0.0", "2.0.0"])]]);
    const after = new Map([["shared", new Set(["3.0.0", "4.0.0"])]]);
    const [pair] = diffPackageVersions(before, after);
    expect(pair.unavailableReason).toMatch(/several versions/);
  });

  test("keeps a peer-suffixed pnpm locator's real name and version", () => {
    // pnpm 6+ appends `(peer@version)`. Locating the name/version separator
    // before stripping it split `react-dom@18.2.0(react@18.2.0)` into the name
    // `react-dom@18.2.0(react`, so a real bump produced no pair at all.
    const before = parsePnpmLock(
      "packages:\n  /react-dom@18.2.0(react@18.2.0):\n    resolution: {integrity: sha512-a}\n",
    );
    const after = parsePnpmLock(
      "packages:\n  /react-dom@18.3.1(react@18.3.1):\n    resolution: {integrity: sha512-b}\n",
    );
    expect(before).toEqual(new Map([["react-dom", new Set(["18.2.0"])]]));
    expect(diffPackageVersions(before, after)).toEqual([
      { ecosystem: "npm", name: "react-dom", from: "18.2.0", to: "18.3.1" },
    ]);
  });

  test("does not project a git or file pnpm locator as a public registry package", () => {
    expect(
      parsePnpmLock(
        "packages:\n  /foo@git+ssh://git@github.com/o/r.git#abc:\n    resolution: {integrity: sha512-c}\n",
      ),
    ).toEqual(new Map());
    expect(
      parsePnpmLock("packages:\n  /mylib@file:../vendor:\n    resolution: {integrity: sha512-d}\n"),
    ).toEqual(new Map());
  });

  test("uses a pnpm entry's recorded registry over the .npmrc default", () => {
    // The lockfile itself records where the bytes came from. Discarding that left a private
    // package indistinguishable from a public one whenever the repository root
    // carried no .npmrc.
    expect(
      parsePnpmLock(
        "packages:\n  /@acme/internal@2.0.0:\n    resolution: {registry: https://npm.example.com/, integrity: sha512-e}\n",
      ),
    ).toEqual(new Map());
  });

  test("does not verify a package-lock entry whose resolved tarball names another package", () => {
    // The name and version are text in the diff under review; `resolved` is
    // what the installer fetches. Unbound, an entry could claim lodash and
    // install evil-pkg, and the verdict would describe the wrong bytes.
    expect(
      parsePackageLock(
        JSON.stringify({
          lockfileVersion: 3,
          packages: {
            "node_modules/lodash": {
              version: "4.17.21",
              resolved: "https://registry.npmjs.org/evil-pkg/-/evil-pkg-9.9.9.tgz",
              integrity: "sha512-zzz",
            },
          },
        }),
      ),
    ).toEqual(new Map());
  });

  test("resolves a lockfileVersion 1 npm: alias to the package actually installed", () => {
    expect(
      parsePackageLock(
        JSON.stringify({
          lockfileVersion: 1,
          dependencies: {
            foo: {
              version: "npm:bar@1.0.0",
              resolved: "https://registry.npmjs.org/bar/-/bar-1.0.0.tgz",
            },
          },
        }),
      ),
    ).toEqual(new Map([["bar", new Set(["1.0.0"])]]));
  });

  test("does not project non-public or workspace package-lock entries as public npm bytes", () => {
    const versions = parsePackageLock(
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": { name: "consumer", version: "1.0.0" },
          "packages/local": { name: "local", version: "2.0.0" },
          "node_modules/git-fork": {
            version: "3.0.0",
            resolved: "git+https://github.com/example/fork.git#abc123",
          },
          "node_modules/private-package": {
            version: "4.0.0",
            resolved: "https://npm.example.com/private-package/-/private-package-4.0.0.tgz",
          },
          "node_modules/public-package": {
            version: "5.0.0",
            resolved: "https://registry.npmjs.org/public-package/-/public-package-5.0.0.tgz",
          },
        },
      }),
    );

    expect(versions).toEqual(new Map([["public-package", new Set(["5.0.0"])]]));
  });

  test("marks changed private package-lock bytes unavailable instead of querying public npm", () => {
    const cwd = repositoryWith(
      "package-lock.json",
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": {},
          "node_modules/private-package": {
            version: "1.0.0",
            resolved: "https://npm.example.com/private-package/-/private-package-1.0.0.tgz",
          },
        },
      }),
    );
    writeFileSync(
      path.join(cwd, "package-lock.json"),
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": {},
          "node_modules/private-package": {
            version: "2.0.0",
            resolved: "https://npm.example.com/private-package/-/private-package-2.0.0.tgz",
          },
        },
      }),
    );

    expect(discoverDependencyPairs({ cwd, base: "HEAD", env: {} }).pairs).toEqual([
      {
        ecosystem: "npm",
        name: "private-package",
        from: "1.0.0",
        to: "2.0.0",
        unavailableReason: "dependency is not resolved from the public npm registry",
      },
    ]);
  });

  test("uses npmrc registry scope when classifying pnpm locators", () => {
    const cwd = repositoryWith(
      "pnpm-lock.yaml",
      "packages:\n  '@private/tool@1.0.0':\n    resolution: { integrity: sha512-old }\n",
    );
    writeFileSync(path.join(cwd, ".npmrc"), "@private:registry=https://npm.example.com/\n");
    writeFileSync(
      path.join(cwd, "pnpm-lock.yaml"),
      "packages:\n  '@private/tool@2.0.0':\n    resolution: { integrity: sha512-new }\n",
    );

    expect(discoverDependencyPairs({ cwd, base: "HEAD", env: {} }).pairs[0]).toMatchObject({
      name: "@private/tool",
      from: "1.0.0",
      to: "2.0.0",
      unavailableReason: "dependency is not resolved from the public npm registry",
    });
  });

  test("classifies each pnpm side with its checked-in registry scope", () => {
    const cwd = repositoryWith(
      "pnpm-lock.yaml",
      "packages:\n  '@private/tool@1.0.0':\n    resolution: { integrity: sha512-old }\n",
    );
    writeFileSync(path.join(cwd, ".npmrc"), "@private:registry=https://npm.example.com/\n");
    execFileSync("git", ["add", ".npmrc"], { cwd });
    execFileSync("git", ["commit", "--amend", "--no-edit", "-q"], { cwd });

    writeFileSync(path.join(cwd, ".npmrc"), "@private:registry=https://registry.npmjs.org/\n");
    writeFileSync(
      path.join(cwd, "pnpm-lock.yaml"),
      "packages:\n  '@private/tool@2.0.0':\n    resolution: { integrity: sha512-new }\n",
    );

    expect(discoverDependencyPairs({ cwd, base: "HEAD", env: {} }).pairs[0]).toMatchObject({
      name: "@private/tool",
      from: "1.0.0",
      to: "2.0.0",
      unavailableReason: "dependency is not resolved from the public npm registry",
    });
  });

  test("compares a lockfile through a repository directory rename", () => {
    const cwd = repositoryWith("old/package-lock.json", packageLock("1.0.0"));
    mkdirSync(path.join(cwd, "new"));
    renameSync(path.join(cwd, "old/package-lock.json"), path.join(cwd, "new/package-lock.json"));
    writeFileSync(path.join(cwd, "new/package-lock.json"), packageLock("2.0.0"));
    execFileSync("git", ["add", "-A"], { cwd });

    const discovery = discoverDependencyPairs({ cwd, base: "HEAD", env: {} });
    expect(discovery.lockfiles).toEqual(["new/package-lock.json"]);
    expect(discovery.pairs).toEqual([
      { ecosystem: "npm", name: "left-pad", from: "1.0.0", to: "2.0.0" },
    ]);
  });

  test("compares both supported lockfile format migration directions", () => {
    for (const migration of [
      {
        beforePath: "package-lock.json",
        beforeText: packageLock("1.0.0"),
        afterPath: "pnpm-lock.yaml",
        afterText: publicPnpmLock("2.0.0"),
      },
      {
        beforePath: "pnpm-lock.yaml",
        beforeText: publicPnpmLock("1.0.0"),
        afterPath: "package-lock.json",
        afterText: packageLock("2.0.0"),
      },
    ]) {
      const cwd = repositoryWith(migration.beforePath, migration.beforeText);
      unlinkSync(path.join(cwd, migration.beforePath));
      writeFileSync(path.join(cwd, migration.afterPath), migration.afterText);
      execFileSync("git", ["add", "-A"], { cwd });

      const discovery = discoverDependencyPairs({ cwd, base: "HEAD", env: {} });
      expect(discovery.lockfiles).toEqual([migration.afterPath]);
      expect(discovery.pairs).toEqual([
        { ecosystem: "npm", name: "left-pad", from: "1.0.0", to: "2.0.0" },
      ]);
    }
  });

  test("does not pair unrelated lockfile deletion and addition paths", () => {
    const cwd = repositoryWith("removed/package-lock.json", packageLock("1.0.0"));
    unlinkSync(path.join(cwd, "removed/package-lock.json"));
    mkdirSync(path.join(cwd, "added"));
    writeFileSync(path.join(cwd, "added/pnpm-lock.yaml"), publicPnpmLock("2.0.0"));
    execFileSync("git", ["add", "-A"], { cwd });

    expect(discoverDependencyPairs({ cwd, base: "HEAD", env: {} }).pairs).toEqual([]);
  });

  test("keeps unavailable provenance when duplicate pairs span public and private lockfiles", () => {
    const cwd = repositoryWith(
      "a-private/package-lock.json",
      packageLock("1.0.0", "https://npm.example.com"),
    );
    mkdirSync(path.join(cwd, "z-public"));
    writeFileSync(path.join(cwd, "z-public/package-lock.json"), packageLock("1.0.0"));
    execFileSync("git", ["add", "."], { cwd });
    execFileSync("git", ["commit", "--amend", "--no-edit", "-q"], { cwd });

    writeFileSync(
      path.join(cwd, "a-private/package-lock.json"),
      packageLock("2.0.0", "https://npm.example.com"),
    );
    writeFileSync(path.join(cwd, "z-public/package-lock.json"), packageLock("2.0.0"));

    expect(discoverDependencyPairs({ cwd, base: "HEAD", env: {} }).pairs).toEqual([
      {
        ecosystem: "npm",
        name: "left-pad",
        from: "1.0.0",
        to: "2.0.0",
        unavailableReason: "dependency is not resolved from the public npm registry",
      },
    ]);
  });
});
