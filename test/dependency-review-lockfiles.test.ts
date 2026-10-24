import { describe, expect, test } from "vitest";
import {
  diffLockfileSnapshots,
  lockfileKindForPath,
  MAX_LOCKFILE_CHARS,
  parseLockfile,
  unpinnedRequirementsChanged,
  type LockfilePackage,
  type LockfileSnapshot,
} from "../server/lib/dependency-review/lockfiles";

type Summary = Record<string, { versions: string[]; direct: boolean; privateSource?: true }>;

// `privateSource` appears only when set, so public-only expectations stay short.
function summary(snapshot: LockfileSnapshot): Summary {
  const out: Summary = {};
  for (const [key, pkg] of snapshot.packages) {
    out[key] = {
      versions: [...pkg.versions].sort(),
      direct: pkg.direct,
      ...(pkg.privateSource ? { privateSource: true as const } : {}),
    };
  }
  return out;
}

function snapshotOf(
  ecosystem: LockfilePackage["ecosystem"],
  packages: Record<string, { versions: string[]; direct?: boolean; privateSource?: boolean }>,
  complete = true,
): LockfileSnapshot {
  return {
    complete,
    unpinned: [],
    packages: new Map(
      Object.entries(packages).map(
        ([name, { versions, direct = false, privateSource = false }]) => [
          `${ecosystem}:${name}`,
          { ecosystem, name, versions: new Set(versions), direct, privateSource },
        ],
      ),
    ),
  };
}

const bumpsOf = (base: LockfileSnapshot | null, head: LockfileSnapshot) =>
  diffLockfileSnapshots(base, head, "package-lock.json").map(
    ({ name, fromVersion, toVersion, direct, privateSource }) => ({
      name,
      fromVersion,
      toVersion,
      direct,
      ...(privateSource ? { privateSource } : {}),
    }),
  );

describe("lockfileKindForPath", () => {
  test.each([
    ["package-lock.json", "npm"],
    ["apps/web/npm-shrinkwrap.json", "npm"],
    ["pnpm-lock.yaml", "pnpm"],
    ["a/b/yarn.lock", "yarn"],
    ["uv.lock", "uv"],
    ["requirements.txt", "requirements"],
    ["svc/requirements-dev.txt", "requirements"],
    ["requirements/base.txt", "requirements"],
    ["dev-requirements.txt", "requirements"],
    ["svc/test_requirements.txt", "requirements"],
    ["requirements.pip", "requirements"],
    ["requirements_test.pip", "requirements"],
    ["requirements.in.txt", "requirements"],
    ["notrequirements.txt", "requirements"],
    ["constraints.txt", "requirements"],
    ["py/constraints-dev.txt", "requirements"],
    ["requirements-dev-py3.txt", "requirements"],
    ["requirements.dev.txt", "requirements"],
    ["constraints-dev-py3.txt", "requirements"],
    ["requirements_dev-py3.pip", "requirements"],
    ["deep/nested/requirements/prod.txt", "requirements"],
  ])("%s is %s", (path, kind) => {
    expect(lockfileKindForPath(path)).toBe(kind);
  });

  test.each([
    "package.json",
    "my-package-lock.json",
    "pnpm-lock.yml",
    "poetry.lock",
    "bun.lock",
    "requirements/sub/dir.txt",
    "requirements.in",
    "requirements.yaml",
    "constraints.pip",
    "myconstraints.txt",
    "requirements.txt/x",
    "requirements-.txt",
    "requirements..txt",
  ])("%s is not a supported lockfile", (path) => {
    expect(lockfileKindForPath(path)).toBeNull();
  });

  test("a long hostile file name is matched in linear time", () => {
    const started = performance.now();
    expect(lockfileKindForPath(`requirements${"-a".repeat(50_000)}!.txt`)).toBeNull();
    expect(lockfileKindForPath(`constraints${"-a".repeat(50_000)}!.txt`)).toBeNull();
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe("package-lock.json", () => {
  const lock = (packages: Record<string, unknown>) =>
    JSON.stringify({ name: "app", lockfileVersion: 3, packages });

  test("reads every installed package, marks importer dependencies direct, and reports aliases by their real name", () => {
    const text = lock({
      "": {
        dependencies: { lodash: "^4", aliased: "npm:real-pkg@^1", ws: "*" },
        devDependencies: { "@types/node": "^20" },
      },
      "packages/ws": { name: "ws", version: "0.0.0", dependencies: { chalk: "^5" } },
      "node_modules/ws": { resolved: "packages/ws", link: true },
      "node_modules/lodash": {
        version: "4.17.21",
        resolved: "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz",
      },
      "node_modules/aliased": { name: "real-pkg", version: "1.2.0" },
      "node_modules/@types/node": { version: "20.1.0" },
      "node_modules/debug": { version: "4.3.4" },
      "node_modules/debug/node_modules/ms": { version: "2.1.2" },
      "node_modules/ms": { version: "2.1.3" },
      "packages/ws/node_modules/chalk": {
        version: "5.3.0",
        resolved: "https://registry.yarnpkg.com/chalk/-/chalk-5.3.0.tgz",
      },
      "node_modules/bundled-parent": { version: "1.0.0" },
      "node_modules/bundled-parent/node_modules/inner": { version: "1.0.0", inBundle: true },
    });
    const snapshot = parseLockfile("npm", text);
    expect(snapshot.complete).toBe(true);
    expect(summary(snapshot)).toEqual({
      "npm:lodash": { versions: ["4.17.21"], direct: true },
      "npm:real-pkg": { versions: ["1.2.0"], direct: true },
      "npm:@types/node": { versions: ["20.1.0"], direct: true },
      "npm:debug": { versions: ["4.3.4"], direct: false },
      "npm:ms": { versions: ["2.1.2", "2.1.3"], direct: false },
      "npm:chalk": { versions: ["5.3.0"], direct: true },
      "npm:bundled-parent": { versions: ["1.0.0"], direct: false },
    });
  });

  test("keeps every remote source as private, identified by its resolved reference, and skips file sources", () => {
    const text = lock({
      "": { dependencies: { priv: "^1", gitdep: "github:a/b", tar: "https://x/t.tgz" } },
      "node_modules/priv": { version: "1.0.0", resolved: "https://npm.internal.example/priv.tgz" },
      "node_modules/gitdep": { version: "1.0.0", resolved: "git+ssh://git@github.com/a/b.git#abc" },
      "node_modules/tar": { version: "1.0.0", resolved: "https://example.com/t.tgz" },
      "node_modules/lookalike": {
        version: "1.0.0",
        resolved: "https://registry.npmjs.org.evil.example/lookalike.tgz",
      },
      "node_modules/local": { version: "1.0.0", resolved: "file:../local" },
      "node_modules/numeric": { version: "1.0.0", resolved: 42 },
    });
    expect(summary(parseLockfile("npm", text))).toEqual({
      "npm:priv": {
        versions: ["https://npm.internal.example/priv.tgz"],
        direct: true,
        privateSource: true,
      },
      "npm:gitdep": {
        versions: ["git+ssh://git@github.com/a/b.git#abc"],
        direct: true,
        privateSource: true,
      },
      "npm:tar": { versions: ["https://example.com/t.tgz"], direct: true, privateSource: true },
      "npm:lookalike": {
        versions: ["https://registry.npmjs.org.evil.example/lookalike.tgz"],
        direct: false,
        privateSource: true,
      },
      // A non-string `resolved` has no reference, so the version stands in.
      "npm:numeric": { versions: ["1.0.0"], direct: false, privateSource: true },
    });
  });

  test("git shorthands are remote sources, and link, bundled, and file entries are skipped", () => {
    const text = lock({
      "": { dependencies: { a: "github:org/a#v1", b: "git://host/b.git", ws: "*" } },
      "node_modules/a": { version: "1.2.0", resolved: "github:org/a#0123abc" },
      "node_modules/b": { version: "1.0.0", resolved: "git://host/b.git#fedcba" },
      "node_modules/ws": { resolved: "packages/ws", link: true },
      "node_modules/tgz": { version: "1.0.0", resolved: "file:vendor/tgz-1.0.0.tgz" },
      "node_modules/b/node_modules/inner": { version: "1.0.0", inBundle: true },
    });
    expect(summary(parseLockfile("npm", text))).toEqual({
      "npm:a": { versions: ["github:org/a#0123abc"], direct: true, privateSource: true },
      "npm:b": { versions: ["git://host/b.git#fedcba"], direct: true, privateSource: true },
    });
  });

  test("one private copy marks the package private", () => {
    const text = lock({
      "node_modules/a": { version: "1.0.0" },
      "node_modules/x/node_modules/a": {
        version: "1.0.0",
        resolved: "https://npm.internal.example/a.tgz",
      },
      "node_modules/y/node_modules/a": {
        version: "1.0.1",
        resolved: "https://registry.npmjs.org/a/-/a-1.0.1.tgz",
      },
    });
    expect(summary(parseLockfile("npm", text))).toEqual({
      "npm:a": {
        versions: ["1.0.0", "1.0.1", "https://npm.internal.example/a.tgz"],
        direct: false,
        privateSource: true,
      },
    });
  });

  test("drops invalid names and versions and ignores prototype keys", () => {
    const text =
      '{"lockfileVersion":3,"packages":{"":{"dependencies":{"__proto__":"1","constructor":"1"}},' +
      '"node_modules/__proto__":{"version":"1.0.0"},' +
      '"node_modules/constructor":{"version":"1.0.0"},' +
      '"node_modules/toString/node_modules/x":{"version":"1.0.0"},' +
      '"node_modules/bad name":{"version":"1.0.0"},' +
      '"node_modules/node_modules":{"version":"1.0.0"},' +
      '"node_modules/loose":{"version":"v1.0.0"},' +
      '"node_modules/zero":{"version":"01.0.0"},' +
      '"node_modules/range":{"version":"^1.0.0"},' +
      '"node_modules/obj":{"version":{"toString":"1.0.0"}},' +
      '"node_modules/inherited":{}}}';
    const snapshot = parseLockfile("npm", text);
    expect(summary(snapshot)).toEqual({
      "npm:constructor": { versions: ["1.0.0"], direct: true },
      "npm:x": { versions: ["1.0.0"], direct: false },
    });
    expect(Object.hasOwn(Object.prototype, "version")).toBe(false);
  });

  test("reads v1, malformed, and non-object lockfiles as incomplete", () => {
    for (const text of [
      JSON.stringify({ lockfileVersion: 1, dependencies: { a: { version: "1.0.0" } } }),
      "{",
      "null",
      '"text"',
      "[]",
      JSON.stringify({ packages: [] }),
    ]) {
      expect(parseLockfile("npm", text)).toEqual({
        packages: new Map(),
        complete: false,
        unpinned: [],
      });
    }
  });
});

describe("pnpm-lock.yaml", () => {
  test("v9: packages and snapshots keys, peer suffixes, aliases, and importer directness", () => {
    const text = [
      "lockfileVersion: '9.0'",
      "",
      "settings:",
      "  autoInstallPeers: true",
      "",
      "importers:",
      "",
      "  .:",
      "    dependencies:",
      "      react:",
      "        specifier: ^18.2.0",
      "        version: 18.3.1",
      "      ws-lib:",
      "        specifier: workspace:*",
      "        version: link:packages/ws-lib",
      "    devDependencies:",
      "      '@types/react':",
      "        specifier: ^18.0.0",
      "        version: 18.0.2(react@18.3.1)",
      "      string-width-cjs:",
      "        specifier: npm:string-width@^4.2.0",
      "        version: string-width@4.2.3",
      "",
      "  packages/ws-lib:",
      "    dependencies:",
      "      local:",
      "        specifier: file:../local",
      "        version: file:../local",
      "",
      "packages:",
      "",
      "  '@types/react@18.0.2':",
      "    resolution: {integrity: sha512-x}",
      "",
      "  react@18.3.1:",
      "    resolution: {integrity: sha512-y}",
      "    engines: {node: '>=0.10.0'}",
      "",
      "  string-width@4.2.3:",
      "    resolution: {integrity: sha512-z}",
      "",
      "  string-width@5.1.2:",
      "    resolution: {integrity: sha512-w}",
      "",
      "  loose-envify@1.4.0:",
      "    resolution:",
      "      integrity: sha512-v",
      "      tarball: https://registry.npmjs.org/loose-envify/-/loose-envify-1.4.0.tgz",
      "",
      "  priv@1.0.0:",
      "    resolution: {integrity: sha512-p, tarball: https://npm.corp.example/priv/-/priv-1.0.0.tgz}",
      "",
      "  gitpkg@1.0.0:",
      "    resolution: {commit: abc, repo: https://github.com/a/b.git, type: git}",
      "",
      "  blockgit@1.0.0:",
      "    resolution:",
      "      type: git",
      "      repo: https://github.com/a/b.git",
      "",
      "  local@file:../local:",
      "    resolution: {directory: ../local, type: directory}",
      "",
      "  tarpkg@https://codeload.github.com/a/b/tar.gz/abc:",
      "    resolution: {tarball: https://codeload.github.com/a/b/tar.gz/abc}",
      "",
      "snapshots:",
      "",
      "  '@types/react@18.0.2(react@18.3.1)':",
      "    dependencies:",
      "      react: 18.3.1",
      "",
      "  js-tokens@4.0.0: {}",
      "",
      "  priv@1.0.0: {}",
    ].join("\n");
    const snapshot = parseLockfile("pnpm", text);
    expect(snapshot.complete).toBe(true);
    expect(summary(snapshot)).toEqual({
      "npm:@types/react": { versions: ["18.0.2"], direct: true },
      "npm:react": { versions: ["18.3.1"], direct: true },
      "npm:string-width": { versions: ["4.2.3", "5.1.2"], direct: true },
      "npm:loose-envify": { versions: ["1.4.0"], direct: false },
      "npm:priv": {
        versions: ["https://npm.corp.example/priv/-/priv-1.0.0.tgz"],
        direct: false,
        privateSource: true,
      },
      "npm:gitpkg": {
        versions: ["https://github.com/a/b.git#abc"],
        direct: false,
        privateSource: true,
      },
      "npm:blockgit": {
        versions: ["https://github.com/a/b.git"],
        direct: false,
        privateSource: true,
      },
      "npm:tarpkg": {
        versions: ["https://codeload.github.com/a/b/tar.gz/abc"],
        direct: false,
        privateSource: true,
      },
      "npm:js-tokens": { versions: ["4.0.0"], direct: false },
    });
  });

  test("v9 git and tarball dependencies keep their URL keys and are direct by importer", () => {
    const lock = (sha: string) =>
      [
        "lockfileVersion: '9.0'",
        "importers:",
        "  .:",
        "    dependencies:",
        "      gitdep:",
        "        specifier: github:org/gitdep#v1",
        `        version: https://codeload.github.com/org/gitdep/tar.gz/${sha}`,
        "      repodep:",
        "        specifier: git+https://github.com/org/repodep.git",
        `        version: git+https://github.com/org/repodep.git#${sha}`,
        "packages:",
        `  gitdep@https://codeload.github.com/org/gitdep/tar.gz/${sha}:`,
        `    resolution: {tarball: https://codeload.github.com/org/gitdep/tar.gz/${sha}}`,
        "    version: 1.2.0",
        `  repodep@git+https://github.com/org/repodep.git#${sha}:`,
        `    resolution: {commit: ${sha}, repo: https://github.com/org/repodep.git, type: git}`,
        "    version: 1.2.0",
        "snapshots:",
        `  gitdep@https://codeload.github.com/org/gitdep/tar.gz/${sha}: {}`,
        `  repodep@git+https://github.com/org/repodep.git#${sha}: {}`,
      ].join("\n");
    expect(summary(parseLockfile("pnpm", lock("aaa111")))).toEqual({
      "npm:gitdep": {
        versions: ["https://codeload.github.com/org/gitdep/tar.gz/aaa111"],
        direct: true,
        privateSource: true,
      },
      "npm:repodep": {
        versions: ["https://github.com/org/repodep.git#aaa111"],
        direct: true,
        privateSource: true,
      },
    });
    // Both refs moved while package.json kept `version: 1.2.0`.
    const bumps = bumpsOf(
      parseLockfile("pnpm", lock("aaa111")),
      parseLockfile("pnpm", lock("bbb222")),
    );
    expect(bumps.map((b) => [b.name, b.fromVersion, b.toVersion])).toEqual([
      [
        "gitdep",
        "https://codeload.github.com/org/gitdep/tar.gz/aaa111",
        "https://codeload.github.com/org/gitdep/tar.gz/bbb222",
      ],
      [
        "repodep",
        "https://github.com/org/repodep.git#aaa111",
        "https://github.com/org/repodep.git#bbb222",
      ],
    ]);
  });

  test("v6 keys with a leading slash and parenthesized peers", () => {
    const text = [
      "lockfileVersion: '6.0'",
      "",
      "dependencies:",
      "  react-dom:",
      "    specifier: ^18.2.0",
      "    version: 18.2.0(react@18.2.0)",
      "",
      "packages:",
      "",
      "  /react-dom@18.2.0(react@18.2.0):",
      "    resolution: {integrity: sha512-a}",
      "",
      "  /@babel/core@7.22.0:",
      "    resolution: {integrity: sha512-b}",
    ].join("\n");
    expect(summary(parseLockfile("pnpm", text))).toEqual({
      "npm:react-dom": { versions: ["18.2.0"], direct: true },
      "npm:@babel/core": { versions: ["7.22.0"], direct: false },
    });
  });

  test("v5 slash keys, underscore peer suffixes, inline importer versions, and other-registry host keys", () => {
    const text = [
      "lockfileVersion: 5.4",
      "",
      "importers:",
      "",
      "  .:",
      "    specifiers:",
      "      react-dom: ^17.0.2",
      "    dependencies:",
      "      react-dom: 17.0.2_react@17.0.2",
      "      my-alias: /@scope/real/2.0.0_@types+react@17.0.1",
      "      private: registry.corp.example/private/1.0.0",
      "",
      "packages:",
      "",
      "  /react-dom/17.0.2_react@17.0.2:",
      "    resolution: {integrity: sha512-a}",
      "",
      "  /react/17.0.2:",
      "    resolution: {integrity: sha512-b}",
      "",
      "  /@scope/real/2.0.0_@types+react@17.0.1:",
      "    resolution: {integrity: sha512-c}",
      "",
      "  registry.corp.example/private/1.0.0:",
      "    resolution: {integrity: sha512-d}",
      "",
      "  github.com/a/b/0123456789abcdef:",
      "    resolution: {tarball: https://codeload.github.com/a/b/tar.gz/0123456789abcdef}",
      "    name: b",
      "    version: 1.0.0",
    ].join("\n");
    expect(summary(parseLockfile("pnpm", text))).toEqual({
      "npm:react-dom": { versions: ["17.0.2"], direct: true },
      "npm:react": { versions: ["17.0.2"], direct: false },
      "npm:@scope/real": { versions: ["2.0.0"], direct: true },
      // No URL in a host-prefixed key, so the version identifies it.
      "npm:private": { versions: ["1.0.0"], direct: true, privateSource: true },
      "npm:b": {
        versions: ["https://codeload.github.com/a/b/tar.gz/0123456789abcdef"],
        direct: false,
        privateSource: true,
      },
    });
  });

  test("ignores look-alike sections and malformed lines", () => {
    const text = [
      "lockfileVersion: '9.0'",
      "overrides:",
      "  evil@1.0.0: 1.0.0",
      "packages:",
      "  'unterminated@1.0.0:",
      "  key:value",
      "\tnested@1.0.0:",
      "  ok@1.0.0:",
      "    resolution: {integrity: sha512-x}",
      "  __proto__@1.0.0: {}",
      "  constructor@1.0.0: {}",
    ].join("\n");
    expect(summary(parseLockfile("pnpm", text))).toEqual({
      "npm:ok": { versions: ["1.0.0"], direct: false },
      "npm:constructor": { versions: ["1.0.0"], direct: false },
    });
  });
});

describe("yarn.lock", () => {
  test("v1: every entry, aliases by real name, manifest directness, and private resolved URLs", () => {
    const text = [
      "# yarn lockfile v1",
      "",
      '"@babel/core@^7.0.0", "@babel/core@^7.1.0":',
      '  version "7.2.0"',
      '  resolved "https://registry.yarnpkg.com/@babel/core/-/core-7.2.0.tgz#abc"',
      "  dependencies:",
      '    debug "^4.1.0"',
      '    version "^1.0.0"',
      "",
      "debug@^4.1.0:",
      '  version "4.3.4"',
      '  resolved "https://registry.yarnpkg.com/debug/-/debug-4.3.4.tgz"',
      "",
      '"string-width-cjs@npm:string-width@^4.2.0":',
      '  version "4.2.3"',
      '  resolved "https://registry.yarnpkg.com/string-width/-/string-width-4.2.3.tgz"',
      "",
      "private@^1.0.0:",
      '  version "1.0.0"',
      '  resolved "https://npm.internal.example/private.tgz"',
      "",
      '"gitdep@github:a/b":',
      '  version "1.0.0"',
      '  resolved "https://codeload.github.com/a/b/tar.gz/abc"',
      "",
      '"localdep@file:../local":',
      '  version "1.0.0"',
      "",
      '"mixed@^1.0.0", "other@^1.0.0":',
      '  version "1.0.0"',
    ].join("\n");
    const manifest = JSON.stringify({
      dependencies: { "string-width-cjs": "npm:string-width@^4.2.0", private: "^1.0.0" },
      devDependencies: { "@babel/core": "^7.1.0", localdep: "file:../local" },
    });
    expect(summary(parseLockfile("yarn", text, { manifestText: manifest }))).toEqual({
      "npm:@babel/core": { versions: ["7.2.0"], direct: true },
      "npm:debug": { versions: ["4.3.4"], direct: false },
      "npm:string-width": { versions: ["4.2.3"], direct: true },
      "npm:private": {
        versions: ["https://npm.internal.example/private.tgz"],
        direct: true,
        privateSource: true,
      },
      "npm:gitdep": {
        versions: ["https://codeload.github.com/a/b/tar.gz/abc"],
        direct: false,
        privateSource: true,
      },
    });
  });

  test("v1: git, URL, and user/repo descriptors are remote sources; file and path descriptors are skipped", () => {
    const text = [
      '"short@org/short#v1":',
      '  version "1.0.0"',
      '  resolved "https://codeload.github.com/org/short/tar.gz/abc123"',
      "",
      '"vcs@git+https://github.com/org/vcs.git#v2":',
      '  version "2.0.0"',
      '  resolved "git+https://github.com/org/vcs.git#def456"',
      "",
      '"tarball@https://cdn.example/tarball-1.0.0.tgz":',
      '  version "1.0.0"',
      '  resolved "https://cdn.example/tarball-1.0.0.tgz#sha1"',
      "",
      '"noref@github:org/noref":',
      '  version "3.0.0"',
      "",
      '"local@file:../local":',
      '  version "1.0.0"',
      "",
      '"rel@./vendor/rel":',
      '  version "1.0.0"',
      "",
      '"mixed@^1.0.0", "mixed@file:../mixed":',
      '  version "1.0.0"',
    ].join("\n");
    const manifest = JSON.stringify({ dependencies: { short: "org/short#v1" } });
    expect(summary(parseLockfile("yarn", text, { manifestText: manifest }))).toEqual({
      "npm:short": {
        versions: ["https://codeload.github.com/org/short/tar.gz/abc123"],
        direct: true,
        privateSource: true,
      },
      "npm:vcs": {
        versions: ["git+https://github.com/org/vcs.git#def456"],
        direct: false,
        privateSource: true,
      },
      "npm:tarball": {
        versions: ["https://cdn.example/tarball-1.0.0.tgz#sha1"],
        direct: false,
        privateSource: true,
      },
      "npm:noref": { versions: ["3.0.0"], direct: false, privateSource: true },
    });
  });

  test("v1 without a manifest still lists transitive packages, none direct", () => {
    const text = ["lodash@^4.17.0:", '  version "4.17.21"'].join("\n");
    for (const manifestText of [undefined, null, "{", "[]", '{"dependencies":"x"}']) {
      expect(summary(parseLockfile("yarn", text, { manifestText }))).toEqual({
        "npm:lodash": { versions: ["4.17.21"], direct: false },
      });
    }
  });

  test("Berry: resolutions, workspace dependency lists, patches, archive URLs, and non-npm protocols", () => {
    const text = [
      '# This file is generated by running "yarn install" inside your project.',
      "",
      "__metadata:",
      "  version: 8",
      "  cacheKey: 10c0",
      "",
      '"@babel/core@npm:^7.0.0, @babel/core@npm:^7.1.0":',
      "  version: 7.2.0",
      '  resolution: "@babel/core@npm:7.2.0"',
      "  dependencies:",
      '    debug: "npm:^4.1.0"',
      "  checksum: 10c0/abc",
      "  languageName: node",
      "  linkType: hard",
      "",
      '"debug@npm:^4.1.0":',
      "  version: 4.3.4",
      '  resolution: "debug@npm:4.3.4"',
      "",
      '"string-width-cjs@npm:string-width@^4.2.0":',
      "  version: 4.2.3",
      '  resolution: "string-width@npm:4.2.3"',
      "",
      '"resolve@patch:resolve@npm%3A^1.20.0#optional!builtin<compat/resolve>":',
      "  version: 1.22.8",
      '  resolution: "resolve@patch:resolve@npm%3A1.22.8#optional!builtin<compat/resolve>::version=1.22.8&hash=c3c19d"',
      "",
      '"odd@patch:odd@https%3A//example.com/odd.tgz#./fix.patch":',
      "  version: 1.0.0",
      '  resolution: "odd@patch:odd@https%3A//example.com/odd.tgz#./fix.patch::hash=1"',
      "",
      '"broken@patch:broken@npm%E0%A4%A#x":',
      "  version: 1.0.0",
      '  resolution: "broken@patch:broken@npm%E0%A4%A#x"',
      "",
      '"archived@npm:^1.0.0":',
      "  version: 1.0.0",
      '  resolution: "archived@npm:1.0.0::__archiveUrl=https%3A%2F%2Fnpm.corp.example%2Farchived.tgz"',
      "",
      '"portal-dep@portal:../p::locator=app%40workspace%3A.":',
      "  version: 0.0.0-use.local",
      '  resolution: "portal-dep@portal:../p::locator=app%40workspace%3A."',
      "",
      '"linked@link:../l::locator=app%40workspace%3A.":',
      "  version: 0.0.0-use.local",
      '  resolution: "linked@link:../l::locator=app%40workspace%3A."',
      "",
      '"gitdep@https://github.com/a/b.git#commit=abc":',
      "  version: 1.0.0",
      '  resolution: "gitdep@https://github.com/a/b.git#commit=abc"',
      "",
      '"app@workspace:.":',
      "  version: 0.0.0-use.local",
      '  resolution: "app@workspace:."',
      "  dependencies:",
      '    "@babel/core": "npm:^7.1.0"',
      "    string-width-cjs: npm:string-width@^4.2.0",
      "  languageName: unknown",
      "  linkType: soft",
      "",
      '"lib@workspace:packages/lib":',
      "  version: 0.0.0-use.local",
      '  resolution: "lib@workspace:packages/lib"',
      "  dependencies:",
      "    resolve: ^1.20.0",
    ].join("\n");
    const manifest = JSON.stringify({ devDependencies: { debug: "^4.1.0" } });
    expect(summary(parseLockfile("yarn", text, { manifestText: manifest }))).toEqual({
      "npm:@babel/core": { versions: ["7.2.0"], direct: true },
      "npm:debug": { versions: ["4.3.4"], direct: true },
      "npm:string-width": { versions: ["4.2.3"], direct: true },
      "npm:resolve": { versions: ["1.22.8"], direct: false },
      "npm:archived": {
        versions: ["1.0.0::__archiveUrl=https%3A%2F%2Fnpm.corp.example%2Farchived.tgz"],
        direct: false,
        privateSource: true,
      },
      "npm:odd": { versions: ["https://example.com/odd.tgz"], direct: false, privateSource: true },
      "npm:broken": {
        versions: ["patch:broken@npm%E0%A4%A#x"],
        direct: false,
        privateSource: true,
      },
      "npm:gitdep": {
        versions: ["https://github.com/a/b.git#commit=abc"],
        direct: false,
        privateSource: true,
      },
    });
  });

  test("Berry: a git ref bump with an unchanged version is a bump", () => {
    const lock = (commit: string) =>
      [
        "__metadata:",
        "  version: 8",
        "",
        '"lib@https://github.com/org/lib.git#v1":',
        "  version: 1.0.0",
        `  resolution: "lib@https://github.com/org/lib.git#commit=${commit}"`,
        "",
        '"tar@https://cdn.example/tar.tgz":',
        "  version: 2.0.0",
        '  resolution: "tar@https://cdn.example/tar.tgz"',
      ].join("\n");
    const bumps = bumpsOf(parseLockfile("yarn", lock("aaa")), parseLockfile("yarn", lock("bbb")));
    expect(bumps).toEqual([
      {
        name: "lib",
        fromVersion: "https://github.com/org/lib.git#commit=aaa",
        toVersion: "https://github.com/org/lib.git#commit=bbb",
        direct: false,
        privateSource: true,
      },
    ]);
  });

  test("Berry: workspace entries mark their dependencies direct without a manifest", () => {
    const text = [
      "__metadata:",
      "  version: 8",
      "",
      '"resolve@npm:^1.20.0":',
      "  version: 1.22.8",
      '  resolution: "resolve@npm:1.22.8"',
      "",
      '"lib@workspace:.":',
      "  version: 0.0.0-use.local",
      '  resolution: "lib@workspace:."',
      "  dependencies:",
      "    resolve: ^1.20.0",
    ].join("\n");
    expect(summary(parseLockfile("yarn", text))).toEqual({
      "npm:resolve": { versions: ["1.22.8"], direct: true },
    });
  });
});

describe("uv.lock", () => {
  const uv = (...blocks: string[][]) => ["version = 1", ...blocks.flat()].join("\n");

  test("registry packages (private off pypi.org), git and URL sources as private, and workspace-member directness", () => {
    const text = uv(
      [
        "[[package]]",
        'name = "app"',
        'version = "0.1.0"',
        'source = { virtual = "." }',
        "dependencies = [",
        '    { name = "httpx" },',
        '    { name = "Typing_Extensions", marker = "python_version < \'3.11\'" },',
        "]",
        "",
        "[package.optional-dependencies]",
        'socks = [{ name = "socksio" }]',
        "",
        "[package.metadata]",
        'requires-dist = [{ name = "httpx", specifier = ">=0.27" }]',
      ],
      [
        "[[package]]",
        'name = "member"',
        'version = "0.1.0"',
        'source = { editable = "packages/member" }',
        'dependencies = [{ name = "rich" }]',
      ],
      [
        "[[package]]",
        'name = "httpx"',
        'version = "0.27.2"',
        'source = { registry = "https://pypi.org/simple" }',
        "dependencies = [",
        '    { name = "anyio" },',
        "]",
        "",
        "[[package.wheels]]",
        'url = "https://files.pythonhosted.org/x.whl"',
      ],
      [
        "[[package]]",
        'name = "anyio"',
        'version = "4.4.0"',
        'source = { registry = "https://pypi.org/simple/" }',
      ],
      [
        "[[package]]",
        'name = "typing-extensions"',
        'version = "4.12.2"',
        'source = { registry = "https://pypi.org/simple" }',
      ],
      [
        "[[package]]",
        'name = "socksio"',
        'version = "1.0.0"',
        'source = { registry = "https://pypi.org/simple" }',
      ],
      [
        "[[package]]",
        'name = "rich"',
        'version = "13.7.1"',
        'source = { registry = "https://pypi.org/simple" }',
      ],
      [
        "[[package]]",
        'name = "numpy"',
        'version = "1.26.4"',
        'source = { registry = "https://pypi.org/simple" }',
      ],
      [
        "[[package]]",
        'name = "numpy"',
        'version = "2.0.0"',
        'source = { registry = "https://pypi.org/simple" }',
      ],
      [
        "[[package]]",
        'name = "internal"',
        'version = "1.0.0"',
        'source = { registry = "https://pypi.corp.example/simple" }',
      ],
      [
        "[[package]]",
        'name = "gitpkg"',
        'version = "1.0.0"',
        'source = { git = "https://github.com/a/b?rev=abc#abc" }',
      ],
      [
        "[[package]]",
        'name = "urlpkg"',
        'version = "1.0.0"',
        'source = { url = "https://example.com/u.tar.gz" }',
      ],
      [
        "[[package]]",
        'name = "pathpkg"',
        'version = "1.0.0"',
        'source = { path = "./wheels/p.whl" }',
      ],
      [
        "[manifest]",
        'members = ["app", "member"]',
        'overrides = [{ name = "numpy", specifier = "<3" }]',
      ],
    );
    expect(summary(parseLockfile("uv", text))).toEqual({
      "pypi:httpx": { versions: ["0.27.2"], direct: true },
      "pypi:anyio": { versions: ["4.4.0"], direct: false },
      "pypi:typing-extensions": { versions: ["4.12.2"], direct: true },
      "pypi:socksio": { versions: ["1.0.0"], direct: true },
      "pypi:rich": { versions: ["13.7.1"], direct: true },
      "pypi:numpy": { versions: ["1.26.4", "2.0.0"], direct: false },
      "pypi:internal": { versions: ["1.0.0"], direct: false, privateSource: true },
      "pypi:gitpkg": {
        versions: ["https://github.com/a/b?rev=abc#abc"],
        direct: false,
        privateSource: true,
      },
      "pypi:urlpkg": {
        versions: ["https://example.com/u.tar.gz"],
        direct: false,
        privateSource: true,
      },
    });
  });

  test("ignores indented look-alike fields and invalid names", () => {
    const text = uv([
      "[[package]]",
      'name = "-bad-"',
      'version = "1.0.0"',
      'source = { registry = "https://pypi.org/simple" }',
      "[[package]]",
      'name = "ok"',
      '  version = "9.9.9"',
      'version = "1.0.0"',
      'source = { registry = "https://pypi.org/simple" }',
    ]);
    expect(summary(parseLockfile("uv", text))).toEqual({
      "pypi:ok": { versions: ["1.0.0"], direct: false },
    });
  });
});

describe("requirements*.txt", () => {
  test("exact pins only, all direct, and PEP 503 names", () => {
    const text = [
      "# comment==1.0",
      "Django==4.2.1 \\",
      "    --hash=sha256:def",
      "requests>=2",
      "Flask[async] == 3.0.0 ; python_version >= '3.8'",
      "zope.interface==6.0",
      "repeated==1.0",
      "Repeated==1.0",
      "arbitrary===1.0",
      "wild==1.*",
      "-e git+https://github.com/a/b#egg=b",
      "-r other.txt",
      "url-dep @ https://example.com/x.whl",
    ].join("\n");
    expect(summary(parseLockfile("requirements", text))).toEqual({
      "pypi:django": { versions: ["4.2.1"], direct: true },
      "pypi:flask": { versions: ["3.0.0"], direct: true },
      "pypi:zope-interface": { versions: ["6.0"], direct: true },
      "pypi:repeated": { versions: ["1.0"], direct: true },
    });
  });

  test("non-pin lines are kept normalized and sorted; pins, comments, blanks, and the default index are not", () => {
    const text = [
      "-i https://pypi.org/simple",
      "Django==4.2.1 \\",
      "    --hash=sha256:abc \\",
      "    --hash=sha256:def",
      "requests  >=2.31   # http",
      "",
      "# a comment",
      "pkg @ https://example.com/pkg-1.0.tar.gz#sha256=abc",
      "git+https://github.com/org/vcs.git@v1.2#egg=vcs",
      "-e git+https://github.com/org/edit.git@abc#egg=edit",
      "-r base.txt",
      "flask~=3.0",
      "exact===1.0",
    ].join("\n");
    const snapshot = parseLockfile("requirements", text);
    expect(summary(snapshot)).toEqual({ "pypi:django": { versions: ["4.2.1"], direct: true } });
    expect(snapshot.unpinned).toEqual([
      "-e git+https://github.com/org/edit.git@abc#egg=edit",
      "-r base.txt",
      "exact===1.0",
      "flask~=3.0",
      "git+https://github.com/org/vcs.git@v1.2#egg=vcs",
      "pkg @ https://example.com/pkg-1.0.tar.gz#sha256=abc",
      "requests >=2.31",
    ]);
  });

  test.each([
    ["a range bump", "foo>=1.2\n", "foo>=1.3\n", true],
    ["a compatible-release bump", "foo~=1.2\n", "foo~=1.3\n", true],
    ["an upper-bound change", "foo<2\n", "foo<3\n", true],
    [
      "a URL bump",
      "foo @ https://x.example/foo-1.tgz\n",
      "foo @ https://x.example/foo-2.tgz\n",
      true,
    ],
    [
      "a VCS ref bump",
      "-e git+https://h/r.git@v1#egg=r\n",
      "-e git+https://h/r.git@v2#egg=r\n",
      true,
    ],
    ["an added range", "a==1.0\n", "a==1.0\nb>=1\n", true],
    ["a pin bump only", "a==1.0\nb>=1\n", "a==1.1\nb>=1\n", false],
    ["reordering, spacing, and comments", "b>=1\na  <2\n", "# deps\na <2  # note\n\nb>=1\n", false],
    [
      "a hash-only change on a pin",
      "a==1.0 \\\n  --hash=sha256:x\n",
      "a==1.0 \\\n  --hash=sha256:y\n",
      false,
    ],
  ])("%s: unpinned changed is %s", (_, before, after, changed) => {
    const base = parseLockfile("requirements", before);
    const head = parseLockfile("requirements", after);
    expect(unpinnedRequirementsChanged(base, head)).toBe(changed);
  });

  test("a new requirements file counts as changed only if it has non-pin lines", () => {
    expect(unpinnedRequirementsChanged(null, parseLockfile("requirements", "a==1.0\n"))).toBe(
      false,
    );
    expect(unpinnedRequirementsChanged(null, parseLockfile("requirements", "a>=1.0\n"))).toBe(true);
  });

  test("other lockfile kinds have no unpinned lines", () => {
    const lock = JSON.stringify({
      lockfileVersion: 3,
      packages: { "node_modules/a": { version: "1.0.0" } },
    });
    expect(parseLockfile("npm", lock).unpinned).toEqual([]);
  });

  test("a name pinned to two versions makes the snapshot incomplete", () => {
    const text = "markered==1.1; python_version<'3.9'\nmarkered==2.1; python_version>='3.9'\n";
    expect(parseLockfile("requirements", text).complete).toBe(false);
  });

  test.each([
    "-i https://pypi.corp.example/simple",
    "--index-url=https://pypi.corp.example/simple",
    "  --extra-index-url https://pypi.corp.example/simple",
    "--extra-index-url https://pypi.org/simple",
    "-ihttps://pypi.corp.example/simple",
    "-i https://pypi.org/simple.evil.example",
    "-i http://pypi.org/simple",
    "--index-url",
    "--find-links ./wheels",
    "-f ./wheels",
    "-f./wheels",
    "--no-index",
  ])("another package source (%s) makes the snapshot incomplete", (option) => {
    const snapshot = parseLockfile("requirements", `internal==1.0\n${option}\n`);
    expect(snapshot).toEqual({ packages: new Map(), complete: false, unpinned: [] });
  });

  test.each([
    "-i https://pypi.org/simple",
    "--index-url https://pypi.org/simple/",
    "--index-url=https://pypi.org/simple  # the default",
    "-ihttps://pypi.org/simple",
    '-i "https://pypi.org/simple"',
  ])("an explicit pypi.org index (%s) is the default", (option) => {
    const snapshot = parseLockfile("requirements", `${option}\nrequests==2.32.0\n`);
    expect(summary(snapshot)).toEqual({ "pypi:requests": { versions: ["2.32.0"], direct: true } });
    expect(snapshot.complete).toBe(true);
  });
});

describe("hostile input", () => {
  test("oversized text is incomplete without being parsed", () => {
    const huge = " ".repeat(MAX_LOCKFILE_CHARS + 1);
    for (const kind of ["npm", "pnpm", "yarn", "uv", "requirements"] as const) {
      expect(parseLockfile(kind, huge)).toEqual({
        packages: new Map(),
        complete: false,
        unpinned: [],
      });
    }
  });

  test("a non-string text is incomplete", () => {
    expect(parseLockfile("npm", 42 as unknown as string).complete).toBe(false);
  });

  test("the entry cap marks the snapshot incomplete", () => {
    const packages: Record<string, unknown> = { "": {} };
    for (let i = 0; i < 20_001; i++) packages[`node_modules/p${i}`] = { version: "1.0.0" };
    const snapshot = parseLockfile("npm", JSON.stringify({ lockfileVersion: 3, packages }));
    expect(snapshot.complete).toBe(false);
    expect(snapshot.packages.size).toBe(20_000);
  });

  test("the per-package version cap marks the snapshot incomplete", () => {
    const packages: Record<string, unknown> = { "": {} };
    for (let i = 0; i < 300; i++) {
      packages[`node_modules/a${i}/node_modules/same`] = { version: `1.0.${i}` };
    }
    const snapshot = parseLockfile("npm", JSON.stringify({ lockfileVersion: 3, packages }));
    expect(snapshot.complete).toBe(false);
    expect(snapshot.packages.get("npm:same")?.versions.size).toBe(256);
  });

  test("the intermediate record budget marks the snapshot incomplete", () => {
    const header = `${Array.from({ length: 200_001 }, (_, i) => `p${i}@^1.0.0`).join(", ")}:`;
    const snapshot = parseLockfile("yarn", `${header}\n  version "1.0.0"\n`);
    expect(snapshot.complete).toBe(false);
  });

  test("CRLF line endings read like LF", () => {
    const text = ["packages:", "  left-pad@1.0.0:", "    resolution: {integrity: sha512-x}", ""];
    expect(summary(parseLockfile("pnpm", text.join("\r\n")))).toEqual({
      "npm:left-pad": { versions: ["1.0.0"], direct: false },
    });
    expect(summary(parseLockfile("requirements", "a==1.0\r\nb==2.0\r\n"))).toEqual({
      "pypi:a": { versions: ["1.0"], direct: true },
      "pypi:b": { versions: ["2.0"], direct: true },
    });
  });

  test("pathological lines parse in linear time", () => {
    const n = 1_000_000;
    // A line separator `.` does not match, after a long run a pattern could
    // backtrack over.
    const separator = String.fromCharCode(0x2028);
    const lines = [
      `${"(".repeat(n)}${separator}`,
      `a:${" ".repeat(n)}${separator}x`,
      `'${"''".repeat(n / 2)}`,
      `${'{ name = "'.repeat(n / 10)}`,
      `${"a".repeat(n)}==`,
      `x${" ".repeat(n)}`,
    ];
    const opener = { pnpm: "packages:", yarn: "x@^1.0.0:", uv: "[[package]]", requirements: "" };
    const started = performance.now();
    for (const line of lines) {
      for (const [kind, first] of Object.entries(opener)) {
        const text = `${first}\n  ${line}\n${line}\n`;
        expect(parseLockfile(kind as keyof typeof opener, text).complete).toBe(true);
      }
    }
    expect(parseLockfile("requirements", "\n".repeat(n)).complete).toBe(true);
    expect(parseLockfile("requirements", "a \\\n".repeat(n / 4)).complete).toBe(true);
    expect(parseLockfile("requirements", "a#".repeat(n / 2)).complete).toBe(true);
    expect(parseLockfile("pnpm", `packages:\n  ${"a:b".repeat(n / 3)}:\n`).complete).toBe(true);
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});

describe("diffLockfileSnapshots", () => {
  test("pairs an upgrade and reports directness from the head", () => {
    const base = snapshotOf("npm", { lodash: { versions: ["4.17.20"] } });
    const head = snapshotOf("npm", { lodash: { versions: ["4.17.21"], direct: true } });
    expect(diffLockfileSnapshots(base, head, "web/package-lock.json")).toEqual([
      {
        ecosystem: "npm",
        name: "lodash",
        fromVersion: "4.17.20",
        toVersion: "4.17.21",
        direct: true,
        lockfilePath: "web/package-lock.json",
      },
    ]);
  });

  test("pairs a downgrade with the closest removed version", () => {
    const base = snapshotOf("npm", { a: { versions: ["2.0.0", "3.0.0"] } });
    const head = snapshotOf("npm", { a: { versions: ["1.5.0"] } });
    expect(bumpsOf(base, head)).toEqual([
      { name: "a", fromVersion: "2.0.0", toVersion: "1.5.0", direct: false },
    ]);
  });

  test("pairs several versions of one package, upgrades before downgrades", () => {
    const base = snapshotOf("npm", { ms: { versions: ["1.0.0", "2.0.0", "2.1.2"] } });
    const head = snapshotOf("npm", { ms: { versions: ["1.0.0", "2.1.3", "3.0.0-beta.1"] } });
    expect(bumpsOf(base, head)).toEqual([
      { name: "ms", fromVersion: "2.1.2", toVersion: "2.1.3", direct: false },
      { name: "ms", fromVersion: "2.0.0", toVersion: "3.0.0-beta.1", direct: false },
    ]);
  });

  test("an extra copy pairs with a version the base kept, and only a package the base lacked has no from version", () => {
    const base = snapshotOf("npm", {
      kept: { versions: ["1.0.0"] },
      gone: { versions: ["1.0.0"] },
    });
    const head = snapshotOf("npm", {
      kept: { versions: ["1.0.0", "1.2.0"] },
      fresh: { versions: ["0.1.0"], direct: true },
    });
    expect(bumpsOf(base, head)).toEqual([
      { name: "fresh", fromVersion: null, toVersion: "0.1.0", direct: true },
      { name: "kept", fromVersion: "1.0.0", toVersion: "1.2.0", direct: false },
    ]);
  });

  test("a version leftover after the removed ones are used pairs with the nearest base version", () => {
    const base = snapshotOf("npm", { a: { versions: ["1.0.0"] } });
    const head = snapshotOf("npm", { a: { versions: ["1.1.0", "2.0.0"] } });
    expect(bumpsOf(base, head)).toEqual([
      { name: "a", fromVersion: "1.0.0", toVersion: "1.1.0", direct: false },
      { name: "a", fromVersion: "1.0.0", toVersion: "2.0.0", direct: false },
    ]);
  });

  test("a new lockfile reports every version as new", () => {
    const head = snapshotOf("npm", {
      b: { versions: ["2.0.0", "1.0.0"] },
      a: { versions: ["1.0.0"] },
    });
    expect(bumpsOf(null, head)).toEqual([
      { name: "a", fromVersion: null, toVersion: "1.0.0", direct: false },
      { name: "b", fromVersion: null, toVersion: "1.0.0", direct: false },
      { name: "b", fromVersion: null, toVersion: "2.0.0", direct: false },
    ]);
  });

  test("unchanged and removed packages are not bumps", () => {
    const base = snapshotOf("npm", {
      same: { versions: ["1.0.0"] },
      gone: { versions: ["1.0.0"] },
    });
    const head = snapshotOf("npm", { same: { versions: ["1.0.0"] } });
    expect(bumpsOf(base, head)).toEqual([]);
  });

  test("an incomplete side produces no bumps", () => {
    const full = snapshotOf("npm", { a: { versions: ["1.0.0"] } });
    const partial = snapshotOf("npm", { a: { versions: ["2.0.0"] } }, false);
    expect(bumpsOf(partial, full)).toEqual([]);
    expect(bumpsOf(full, partial)).toEqual([]);
    expect(bumpsOf(null, partial)).toEqual([]);
  });

  test("orders PyPI versions by release segment, pre-release, and post-release", () => {
    const base = snapshotOf("pypi", { d: { versions: ["4.2", "1.9.0"] } });
    const head = snapshotOf("pypi", { d: { versions: ["4.2.0", "1.10.0rc1"] } });
    expect(bumpsOf(base, head)).toEqual([
      { name: "d", fromVersion: "1.9.0", toVersion: "1.10.0rc1", direct: false },
    ]);

    const order = ["1.0.dev1", "1.0a1", "1.0b2", "1.0rc1", "1.0", "1.0.post1", "1.1", "2!0.1"];
    const pre = snapshotOf("pypi", { p: { versions: ["0.9"] } });
    const post = snapshotOf("pypi", { p: { versions: [...order].reverse() } });
    expect(bumpsOf(pre, post).map((bump) => bump.toVersion)).toEqual(order);
  });

  test("a package private on either side marks its bumps private", () => {
    const base = snapshotOf("npm", {
      priv: { versions: ["1.0.0"], privateSource: true },
      moved: { versions: ["1.0.0"], privateSource: true },
      pub: { versions: ["1.0.0"] },
    });
    const head = snapshotOf("npm", {
      priv: { versions: ["1.1.0"], privateSource: true },
      moved: { versions: ["1.1.0"] },
      pub: { versions: ["1.1.0"] },
      fresh: { versions: ["1.0.0"], privateSource: true },
    });
    expect(bumpsOf(base, head)).toEqual([
      { name: "fresh", fromVersion: null, toVersion: "1.0.0", direct: false, privateSource: true },
      {
        name: "moved",
        fromVersion: "1.0.0",
        toVersion: "1.1.0",
        direct: false,
        privateSource: true,
      },
      {
        name: "priv",
        fromVersion: "1.0.0",
        toVersion: "1.1.0",
        direct: false,
        privateSource: true,
      },
      { name: "pub", fromVersion: "1.0.0", toVersion: "1.1.0", direct: false },
    ]);
    const [pub] = diffLockfileSnapshots(base, head, "x").filter((bump) => bump.name === "pub");
    expect(pub).not.toHaveProperty("privateSource");
  });

  test("a private registry version change is a bump, end to end", () => {
    const lock = (version: string) =>
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": { dependencies: { "@corp/sdk": "^1" } },
          "node_modules/@corp/sdk": {
            version,
            resolved: `https://npm.corp.example/@corp/sdk/-/sdk-${version}.tgz`,
          },
        },
      });
    expect(
      bumpsOf(parseLockfile("npm", lock("1.0.0")), parseLockfile("npm", lock("1.0.1"))),
    ).toEqual([
      {
        name: "@corp/sdk",
        fromVersion: "https://npm.corp.example/@corp/sdk/-/sdk-1.0.0.tgz",
        toVersion: "https://npm.corp.example/@corp/sdk/-/sdk-1.0.1.tgz",
        direct: true,
        privateSource: true,
      },
    ]);
  });

  test("a remote reference over 200 characters keeps both ends, so a changed commit still differs", () => {
    const lock = (sha: string) =>
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "node_modules/long": {
            version: "1.0.0",
            resolved: `git+https://git.example/${"x".repeat(400)}.git#${sha}`,
          },
        },
      });
    const base = parseLockfile("npm", lock("1111111"));
    const head = parseLockfile("npm", lock("2222222"));
    const [identity] = head.packages.get("npm:long")?.versions ?? [];
    expect(identity).toHaveLength(200);
    expect(identity.startsWith("git+https://git.example/")).toBe(true);
    expect(identity.endsWith(".git#2222222")).toBe(true);
    expect(bumpsOf(base, head)).toHaveLength(1);
  });

  test("parsed lockfiles diff end to end", () => {
    const lock = (lodash: string, ms: string[]) =>
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": { dependencies: { lodash: "^4" } },
          "node_modules/lodash": { version: lodash },
          ...Object.fromEntries(
            ms.map((v, i) => [
              i ? `node_modules/x${i}/node_modules/ms` : "node_modules/ms",
              { version: v },
            ]),
          ),
        },
      });
    const base = parseLockfile("npm", lock("4.17.20", ["2.1.2"]));
    const head = parseLockfile("npm", lock("4.17.21", ["2.1.3", "2.1.2"]));
    expect(bumpsOf(base, head)).toEqual([
      { name: "lodash", fromVersion: "4.17.20", toVersion: "4.17.21", direct: true },
      { name: "ms", fromVersion: "2.1.2", toVersion: "2.1.3", direct: false },
    ]);
  });
});
