import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  diffLockfileChanges,
  mergeBump,
  parseLockfile,
  PUBLIC_ROUTE,
  routedBump,
  type LockfileSnapshot,
  type NameRoute,
} from "../server/lib/dependency-review/lockfiles";
import {
  collectCustomRegistries,
  emptyCustomRegistries,
  npmNameRoute,
  unreadableCustomRegistries,
} from "../server/lib/dependency-review/registry-config";
import type { DependencyBump, LockfileKind } from "../server/lib/dependency-review/types";

const sha512 = (seed: string) => `sha512-${createHash("sha512").update(seed).digest("base64")}`;
const sha1 = (seed: string) => `sha1-${createHash("sha1").update(seed).digest("base64")}`;
const sha256 = (seed: string) => `sha256:${createHash("sha256").update(seed).digest("hex")}`;
const SHA1_HEX = "0123456789abcdef0123456789abcdef01234567";

const MIRROR = "https://m.example/npm/";
const PYPI_MIRROR = "https://m.example/pypi/";

function kindsOf(snapshot: LockfileSnapshot, name: string): Record<string, string> {
  const pkg = snapshot.packages.get(name);
  return Object.fromEntries([...(pkg?.sources ?? [])].map(([id, source]) => [id, source.kind]));
}

function changesOf(kind: LockfileKind, before: string | null, after: string) {
  return diffLockfileChanges(
    before === null ? null : parseLockfile(kind, before),
    parseLockfile(kind, after),
    "lock",
  );
}

function bumpsOf(kind: LockfileKind, before: string | null, after: string): DependencyBump[] {
  return changesOf(kind, before, after).map((change) => change.bump);
}

interface RouteOptions {
  route?: NameRoute;
  mirrors?: string[];
  privateRegistries?: string[];
  privateScopes?: string[];
}

function routed(
  kind: LockfileKind,
  before: string | null,
  after: string,
  options: RouteOptions = {},
): DependencyBump[] {
  return changesOf(kind, before, after).map((change) =>
    routedBump(change, options.route ?? PUBLIC_ROUTE, {
      publicMirrors: options.mirrors ?? [MIRROR, PYPI_MIRROR],
      privateRegistries: options.privateRegistries ?? [],
      privateScopes: options.privateScopes ?? [],
    }),
  );
}

type NpmEntry = { version?: unknown; resolved?: unknown; integrity?: unknown; name?: string };

function npmLock(entries: Record<string, NpmEntry>): string {
  const packages: Record<string, unknown> = { "": { dependencies: {} } };
  for (const [path, entry] of Object.entries(entries)) packages[`node_modules/${path}`] = entry;
  return JSON.stringify({ lockfileVersion: 3, packages });
}

function yarnV1(
  entries: Array<{ descriptor: string; version: string; resolved?: string; integrity?: string }>,
) {
  return [
    "# yarn lockfile v1",
    "",
    ...entries.flatMap(({ descriptor, version, resolved, integrity }) => [
      `"${descriptor}":`,
      `  version "${version}"`,
      ...(resolved ? [`  resolved "${resolved}"`] : []),
      ...(integrity ? [`  integrity ${integrity}`] : []),
      "",
    ]),
  ].join("\n");
}

function pnpmLock(entries: Array<{ key: string; resolution: string; extra?: string[] }>) {
  return [
    "lockfileVersion: '9.0'",
    "packages:",
    ...entries.flatMap(({ key, resolution, extra = [] }) => [
      `  ${key}:`,
      `    resolution: ${resolution}`,
      ...extra.map((line) => `    ${line}`),
    ]),
  ].join("\n");
}

describe("D1: a public-host tarball vouches only for its own name and version", () => {
  const canonical = "https://registry.npmjs.org/lodash/-/lodash-4.17.22.tgz";
  const forged: Array<[string, string]> = [
    ["another package's tarball", "https://registry.npmjs.org/evil-pkg/-/evil-pkg-1.0.0.tgz"],
    ["another version", "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz"],
    ["a query", `${canonical}?x=1`],
    ["an empty query", `${canonical}?`],
    ["a fragment that is not a sha1", `${canonical}#evil`],
    ["dot segments", "https://registry.npmjs.org/evil/../lodash/-/lodash-4.17.22.tgz"],
    ["an encoded slash", "https://registry.npmjs.org/evil%2f..%2flodash/-/lodash-4.17.22.tgz"],
    ["an uppercase host", "https://REGISTRY.npmjs.org/lodash/-/lodash-4.17.22.tgz"],
    ["an explicit port", "https://registry.npmjs.org:443/lodash/-/lodash-4.17.22.tgz"],
    ["plain http", "http://registry.npmjs.org/lodash/-/lodash-4.17.22.tgz"],
    ["trailing junk", `${canonical}/x`],
    ["a longer file name", "https://registry.npmjs.org/lodash/-/lodash-4.17.22.tgzx"],
    ["credentials", "https://u:p@registry.npmjs.org/lodash/-/lodash-4.17.22.tgz"],
  ];

  test.each(forged)("npm lock: %s is a remote source", (_, resolved) => {
    const snapshot = parseLockfile("npm", npmLock({ lodash: { version: "4.17.22", resolved } }));
    expect(Object.values(kindsOf(snapshot, "npm:lodash"))).toEqual(["remote"]);
  });

  test("a registry-shaped tarball on a look-alike host is a private registry, not public", () => {
    const resolved = "https://registry.npmjs.org.evil.example/lodash/-/lodash-4.17.22.tgz";
    const snapshot = parseLockfile("npm", npmLock({ lodash: { version: "4.17.22", resolved } }));
    expect(Object.values(kindsOf(snapshot, "npm:lodash"))).toEqual(["registry"]);
  });

  test("leading whitespace in a recorded URL is not canonical", () => {
    const resolved = ` ${canonical}`;
    const npm = parseLockfile("npm", npmLock({ lodash: { version: "4.17.22", resolved } }));
    expect(Object.values(kindsOf(npm, "npm:lodash"))).toEqual(["remote"]);
    const yarn = yarnV1([{ descriptor: "lodash@^4", version: "4.17.22", resolved }]);
    expect(Object.values(kindsOf(parseLockfile("yarn", yarn), "npm:lodash"))).toEqual(["remote"]);
  });

  test.each(forged)("Yarn classic: %s is a remote source", (_, resolved) => {
    const text = yarnV1([{ descriptor: "lodash@^4", version: "4.17.22", resolved }]);
    expect(Object.values(kindsOf(parseLockfile("yarn", text), "npm:lodash"))).toEqual(["remote"]);
  });

  test.each(forged)("pnpm: %s is a remote source", (_, tarball) => {
    const text = pnpmLock([
      { key: "lodash@4.17.22", resolution: `{integrity: sha512-x, tarball: ${tarball}}` },
    ]);
    expect(Object.values(kindsOf(parseLockfile("pnpm", text), "npm:lodash"))).toEqual(["remote"]);
  });

  test.each([
    canonical,
    "https://registry.yarnpkg.com/lodash/-/lodash-4.17.22.tgz",
    `https://registry.yarnpkg.com/lodash/-/lodash-4.17.22.tgz#${SHA1_HEX}`,
  ])("the canonical tarball %s is public", (resolved) => {
    const npm = parseLockfile("npm", npmLock({ lodash: { version: "4.17.22", resolved } }));
    expect(kindsOf(npm, "npm:lodash")).toEqual({ "4.17.22": "public" });
    const yarn = yarnV1([{ descriptor: "lodash@^4", version: "4.17.22", resolved }]);
    expect(kindsOf(parseLockfile("yarn", yarn), "npm:lodash")).toEqual({ "4.17.22": "public" });
  });

  test("scoped names: the literal scope path is canonical, an encoded one is not", () => {
    const at = (resolved: string) =>
      kindsOf(
        parseLockfile("npm", npmLock({ "@babel/core": { version: "7.2.0", resolved } })),
        "npm:@babel/core",
      );
    expect(at("https://registry.npmjs.org/@babel/core/-/core-7.2.0.tgz")).toEqual({
      "7.2.0": "public",
    });
    expect(Object.values(at("https://registry.npmjs.org/@babel%2fcore/-/core-7.2.0.tgz"))).toEqual([
      "remote",
    ]);
    expect(Object.values(at("https://registry.npmjs.org/@evil/core/-/core-7.2.0.tgz"))).toEqual([
      "remote",
    ]);
  });

  test("aliases are checked against the real package's name", () => {
    const real = "https://registry.npmjs.org/real-pkg/-/real-pkg-1.2.0.tgz";
    const npm = npmLock({
      aliased: { name: "real-pkg", version: "1.2.0", resolved: real },
      // No `name`: the path names the package, and the URL is someone else's.
      other: { version: "1.2.0", resolved: real },
    });
    const snapshot = parseLockfile("npm", npm);
    expect(kindsOf(snapshot, "npm:real-pkg")).toEqual({ "1.2.0": "public" });
    expect(Object.values(kindsOf(snapshot, "npm:other"))).toEqual(["remote"]);

    const yarn = yarnV1([
      { descriptor: "x@npm:real-pkg@^1", version: "1.2.0", resolved: real },
      {
        descriptor: "y@npm:real-other@^1",
        version: "1.2.0",
        resolved: "https://registry.npmjs.org/y/-/y-1.2.0.tgz",
      },
    ]);
    const yarnSnapshot = parseLockfile("yarn", yarn);
    expect(kindsOf(yarnSnapshot, "npm:real-pkg")).toEqual({ "1.2.0": "public" });
    expect(Object.values(kindsOf(yarnSnapshot, "npm:real-other"))).toEqual(["remote"]);
  });

  test("pnpm: name or version fields that disagree with the key make the entry remote", () => {
    const text = pnpmLock([
      { key: "lodash@4.17.22", resolution: "{integrity: sha512-x}", extra: ["name: evil-pkg"] },
      { key: "ms@2.1.3", resolution: "{integrity: sha512-y}", extra: ["version: 1.0.0"] },
      {
        key: "ok@1.0.0",
        resolution: "{integrity: sha512-z}",
        extra: ["name: ok", "version: 1.0.0"],
      },
    ]);
    const snapshot = parseLockfile("pnpm", text);
    expect(Object.values(kindsOf(snapshot, "npm:evil-pkg"))).toEqual(["remote"]);
    expect(Object.values(kindsOf(snapshot, "npm:ms"))).toEqual(["remote"]);
    expect(kindsOf(snapshot, "npm:ok")).toEqual({ "1.0.0": "public" });
  });

  test("the injected entry is reported as a remote change, never as the public bump", () => {
    const before = npmLock({
      lodash: {
        version: "4.17.21",
        resolved: "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz",
      },
    });
    const after = npmLock({
      lodash: {
        version: "4.17.22",
        resolved: "https://registry.npmjs.org/evil-pkg/-/evil-pkg-1.0.0.tgz",
        integrity: sha512("evil"),
      },
    });
    expect(bumpsOf("npm", before, after)).toEqual([
      expect.objectContaining({
        name: "lodash",
        fromVersion: "4.17.21",
        toVersion: `https://registry.npmjs.org/evil-pkg/-/evil-pkg-1.0.0.tgz (${sha512("evil")})`,
        privateSource: true,
        remoteSource: true,
      }),
    ]);
  });

  test("Berry: an archive URL on the public host for another package is remote", () => {
    const archive = encodeURIComponent("https://registry.npmjs.org/evil-pkg/-/evil-pkg-1.0.0.tgz");
    const text = [
      "__metadata:",
      "  version: 8",
      "",
      '"lodash@npm:^4":',
      "  version: 4.17.22",
      `  resolution: "lodash@npm:4.17.22::__archiveUrl=${archive}"`,
    ].join("\n");
    expect(Object.values(kindsOf(parseLockfile("yarn", text), "npm:lodash"))).toEqual(["remote"]);
  });
});

describe("D2: source is per version", () => {
  test("a public bump stays diffable beside a remote copy of the same name", () => {
    const git = { version: "1.0.0", resolved: "git+ssh://git@github.com/a/a.git#abc" };
    const before = npmLock({ a: { version: "1.0.0" }, "x/node_modules/a": git });
    const after = npmLock({ a: { version: "1.0.1" }, "x/node_modules/a": git });
    expect(bumpsOf("npm", before, after)).toEqual([
      expect.objectContaining({ name: "a", fromVersion: "1.0.0", toVersion: "1.0.1" }),
    ]);
    expect(bumpsOf("npm", before, after)[0]).not.toHaveProperty("privateSource");
  });

  test("the same holds in pnpm and Yarn classic", () => {
    const pnpm = (version: string) =>
      pnpmLock([
        { key: `a@${version}`, resolution: "{integrity: sha512-x}" },
        {
          key: "a@https://codeload.github.com/o/a/tar.gz/abc",
          resolution: "{tarball: https://codeload.github.com/o/a/tar.gz/abc}",
        },
      ]);
    expect(bumpsOf("pnpm", pnpm("1.0.0"), pnpm("1.0.1"))).toEqual([
      expect.not.objectContaining({ privateSource: true }),
    ]);
    const yarn = (version: string) =>
      yarnV1([
        { descriptor: "a@^1", version },
        {
          descriptor: "a@github:o/a",
          version: "1.0.0",
          resolved: "https://codeload.github.com/o/a/tar.gz/abc",
        },
      ]);
    expect(bumpsOf("yarn", yarn("1.0.0"), yarn("1.0.1"))).toEqual([
      expect.not.objectContaining({ privateSource: true }),
    ]);
  });

  test("a move off a private registry is still private, and off git still remote", () => {
    const priv = "https://npm.corp.example/a/-/a-1.0.0.tgz";
    expect(
      bumpsOf(
        "npm",
        npmLock({ a: { version: "1.0.0", resolved: priv } }),
        npmLock({ a: { version: "1.0.1" } }),
      ),
    ).toEqual([
      expect.objectContaining({ fromVersion: priv, toVersion: "1.0.1", privateSource: true }),
    ]);
    expect(
      bumpsOf(
        "npm",
        npmLock({ a: { version: "1.0.0", resolved: priv } }),
        npmLock({ a: { version: "1.0.1" } }),
      )[0],
    ).not.toHaveProperty("remoteSource");
    expect(
      bumpsOf(
        "npm",
        npmLock({ a: { version: "1.0.0", resolved: "github:o/a#abc" } }),
        npmLock({ a: { version: "1.0.1" } }),
      ),
    ).toEqual([expect.objectContaining({ privateSource: true, remoteSource: true })]);
  });

  test("a version that moves from the public registry to a private one is a bump", () => {
    const uv = (source: string, file: string, hash: string) =>
      [
        "version = 1",
        "[[package]]",
        'name = "a"',
        'version = "1.0.0"',
        `source = { registry = "${source}" }`,
        `sdist = { url = "${file}", hash = "${hash}", size = 1 }`,
      ].join("\n");
    expect(
      bumpsOf(
        "uv",
        uv(
          "https://pypi.org/simple",
          "https://files.pythonhosted.org/packages/ab/a-1.0.0.tar.gz",
          sha256("a"),
        ),
        uv("https://pypi.corp.example/simple", "https://files.example/a-1.0.0.tar.gz", sha256("a")),
      ),
    ).toEqual([
      expect.objectContaining({
        fromVersion: "1.0.0",
        toVersion: `1.0.0 (${sha256("a")})`,
        privateSource: true,
      }),
    ]);
  });
});

describe("a move off a non-public source onto the public registry is a new package", () => {
  const PRIVATE = "https://private.example/npm/";
  const declared = { privateRegistries: [PRIVATE] };
  const npmAt = (base: string, version: string) => ({
    version,
    resolved: `${base}fresh/-/fresh-${version}.tgz`,
    integrity: sha512(`${base}${version}`),
  });

  test("private fresh@1.0.0 to newly published public fresh@1.0.1", () => {
    const [bump] = routed(
      "npm",
      npmLock({ fresh: npmAt(PRIVATE, "1.0.0") }),
      npmLock({ fresh: npmAt("https://registry.npmjs.org/", "1.0.1") }),
      declared,
    );
    expect(bump).toEqual({
      ecosystem: "npm",
      name: "fresh",
      fromVersion: null,
      toVersion: "1.0.1",
      direct: false,
      lockfilePath: "lock",
      replacesPrivate: true,
      pinnedHashes: [sha512("https://registry.npmjs.org/1.0.1")],
    });
  });

  test("the same version number, a git source, or an undeclared host does the same", () => {
    const head = npmLock({ fresh: npmAt("https://registry.npmjs.org/", "1.0.0") });
    for (const before of [
      npmLock({ fresh: npmAt(PRIVATE, "1.0.0") }),
      npmLock({ fresh: { version: "1.0.0", resolved: "github:o/fresh#abc" } }),
      npmLock({ fresh: npmAt("https://npm.corp.example/", "1.0.0") }),
    ]) {
      const [bump] = routed("npm", before, head, declared);
      expect(bump).toMatchObject({ fromVersion: null, toVersion: "1.0.0", replacesPrivate: true });
      expect(bump).not.toHaveProperty("privateSource");
      expect(bump).not.toHaveProperty("repinned");
    }
  });

  test("onto a declared mirror: a candidate with only its target's pins to prove", () => {
    const [bump] = routed(
      "npm",
      npmLock({ fresh: npmAt(PRIVATE, "1.0.0") }),
      npmLock({ fresh: npmAt(MIRROR, "1.0.1") }),
      declared,
    );
    expect(bump).toMatchObject({
      fromVersion: null,
      replacesPrivate: true,
      privateSource: true,
      mirror: { fromHashes: null, toHashes: [sha512(`${MIRROR}1.0.1`)] },
    });
    expect(bump).not.toHaveProperty("repinned");
  });

  test("uv: a declared private index to PyPI", () => {
    const uv = (source: string, version: string, file: string) =>
      [
        "version = 1",
        "[[package]]",
        'name = "fresh"',
        `version = "${version}"`,
        `source = { registry = "${source}" }`,
        `sdist = { url = "${file}", hash = "${sha256(version)}", size = 1 }`,
      ].join("\n");
    const [bump] = routed(
      "uv",
      uv(
        "https://pypi.corp.example/simple",
        "1.0.0",
        "https://pypi.corp.example/f/fresh-1.0.0.tar.gz",
      ),
      uv(
        "https://pypi.org/simple",
        "1.0.1",
        "https://files.pythonhosted.org/packages/ab/fresh-1.0.1.tar.gz",
      ),
      { privateRegistries: ["https://pypi.corp.example/"] },
    );
    expect(bump).toMatchObject({
      ecosystem: "pypi",
      fromVersion: null,
      toVersion: "1.0.1",
      replacesPrivate: true,
      pinnedHashes: [sha256("1.0.1")],
    });
    expect(bump).not.toHaveProperty("privateSource");
  });

  test("private to private stays private", () => {
    const [kept] = routed(
      "npm",
      npmLock({ fresh: npmAt(PRIVATE, "1.0.0") }),
      npmLock({ fresh: npmAt(PRIVATE, "1.0.1") }),
      declared,
    );
    expect(kept.fromVersion).toMatch(
      /^https:\/\/private\.example\/npm\/fresh\/-\/fresh-1\.0\.0\.tgz /,
    );
    expect(kept.privateSource).toBe(true);
    expect(kept).not.toHaveProperty("replacesPrivate");
    expect(kept).not.toHaveProperty("remoteSource");
  });

  test("public to private stays a remote source, not a new package", () => {
    const [bump] = routed(
      "npm",
      npmLock({ fresh: npmAt("https://registry.npmjs.org/", "1.0.0") }),
      npmLock({ fresh: npmAt(PRIVATE, "1.0.1") }),
      declared,
    );
    expect(bump).toMatchObject({ fromVersion: "1.0.0", privateSource: true, remoteSource: true });
    expect(bump).not.toHaveProperty("replacesPrivate");
  });
});

describe("a name in a private scope is exempt only from a declared private registry", () => {
  const PRIVATE = "https://private.example/npm/";
  const NPMJS = "https://registry.npmjs.org/";
  const scope = { privateRegistries: [PRIVATE], privateScopes: ["@corp"] };
  const scoped = (base: string, version: string) =>
    npmLock({
      "@corp/fresh": {
        version,
        resolved: `${base}@corp/fresh/-/fresh-${version}.tgz`,
        integrity: sha512(`${base}${version}`),
      },
    });
  const confused = { privateSource: true, remoteSource: true, privateScopePublic: true };

  test("the reviewer's input: private @corp/fresh@1.0.0 to public @corp/fresh@1.0.1", () => {
    const [bump] = routed("npm", scoped(PRIVATE, "1.0.0"), scoped(NPMJS, "1.0.1"), scope);
    expect(bump).toMatchObject({ name: "@corp/fresh", ...confused });
    expect(bump).not.toHaveProperty("replacesPrivate");
    expect(bump).not.toHaveProperty("mirror");
    expect(bump).not.toHaveProperty("pinnedHashes");
  });

  test("new to the lockfile from the public registry", () => {
    const [bump] = routed("npm", npmLock({}), scoped(NPMJS, "1.0.1"), scope);
    expect(bump).toMatchObject({ fromVersion: null, ...confused });
  });

  test("onto a mirror from a declared private registry", () => {
    const [bump] = routed("npm", scoped(PRIVATE, "1.0.0"), scoped(MIRROR, "1.0.1"), scope);
    expect(bump).toMatchObject(confused);
    expect(bump).not.toHaveProperty("mirror");
  });

  test("on a declared private registry, or hosted behind a mirror, it stays private", () => {
    for (const [before, after] of [
      [scoped(PRIVATE, "1.0.0"), scoped(PRIVATE, "1.0.1")],
      [npmLock({}), scoped(PRIVATE, "1.0.1")],
      [scoped(MIRROR, "1.0.0"), scoped(MIRROR, "1.0.1")],
    ]) {
      const [bump] = routed("npm", before, after, scope);
      expect(bump.privateSource).toBe(true);
      expect(bump).not.toHaveProperty("remoteSource");
      expect(bump).not.toHaveProperty("privateScopePublic");
      expect(bump).not.toHaveProperty("mirror");
    }
  });

  test("pnpm records no URL: a scope the repository routes to the public registry", () => {
    const pnpm = (v: string) =>
      pnpmLock([{ key: `'@corp/fresh@${v}'`, resolution: `{integrity: ${sha512(v)}}` }]);
    const found = collectCustomRegistries(emptyCustomRegistries(), {
      npmrc: `@corp:registry=${NPMJS}`,
      yarnrc: null,
    });
    const route = npmNameRoute(found, "@corp/fresh");
    expect(route).toEqual({ kind: "public", explicit: true });
    const [bump] = routed("pnpm", pnpm("1.0.0"), pnpm("1.0.1"), { ...scope, route });
    expect(bump).toMatchObject(confused);

    // Routed nowhere in the repository: the registry is set outside it, which
    // is what declaring the scope private is for.
    const [unrouted] = routed("pnpm", pnpm("1.0.0"), pnpm("1.0.1"), scope);
    expect(unrouted.privateSource).toBe(true);
    expect(unrouted).not.toHaveProperty("privateScopePublic");
  });
});

describe("a mirror copy at the base is a predecessor only with the head's pins", () => {
  const at = (base: string) => `${base}payload/-/payload-1.0.0.tgz`;
  const lock = (base: string, integrity: string) =>
    npmLock({ payload: { version: "1.0.0", resolved: at(base), integrity } });

  test("the reviewer's input: a mirror copy pinned to other bytes, then the public release", () => {
    const [bump] = routed(
      "npm",
      lock(MIRROR, sha512("mirror bytes")),
      lock("https://registry.npmjs.org/", sha512("public bytes")),
    );
    expect(bump).toEqual({
      ecosystem: "npm",
      name: "payload",
      fromVersion: null,
      toVersion: "1.0.0",
      direct: false,
      lockfilePath: "lock",
      replacesPrivate: true,
      pinnedHashes: [sha512("public bytes")],
    });
  });

  test("the same strong pin is a plain move", () => {
    const [bump] = routed(
      "npm",
      lock(MIRROR, sha512("same")),
      lock("https://registry.npmjs.org/", sha512("same")),
    );
    expect(bump).toMatchObject({ fromVersion: null, toVersion: "1.0.0", repinned: true });
    expect(bump).not.toHaveProperty("replacesPrivate");
  });
});

describe("D3: a re-pin of a non-public source is a change", () => {
  test("npm and Yarn classic: same private URL, new integrity", () => {
    const url = "https://npm.corp.example/@corp/sdk/-/sdk-1.0.0.tgz";
    const npm = (seed: string) =>
      npmLock({ "@corp/sdk": { version: "1.0.0", resolved: url, integrity: sha512(seed) } });
    expect(bumpsOf("npm", npm("a"), npm("b"))).toEqual([
      expect.objectContaining({
        fromVersion: `${url} (${sha512("a")})`,
        toVersion: `${url} (${sha512("b")})`,
        privateSource: true,
      }),
    ]);
    const yarn = (seed: string) =>
      yarnV1([
        { descriptor: "@corp/sdk@^1", version: "1.0.0", resolved: url, integrity: sha512(seed) },
      ]);
    expect(bumpsOf("yarn", yarn("a"), yarn("b"))).toHaveLength(1);
  });

  test("an arbitrary tarball URL with a new integrity", () => {
    const url = "https://cdn.example/t.tgz";
    const npm = (seed: string) =>
      npmLock({ t: { version: "1.0.0", resolved: url, integrity: sha512(seed) } });
    expect(bumpsOf("npm", npm("a"), npm("b"))).toEqual([
      expect.objectContaining({ privateSource: true, remoteSource: true }),
    ]);
  });

  test("pnpm: a host key or private tarball with a new integrity", () => {
    const hostKey = (integrity: string) =>
      [
        "lockfileVersion: 5.4",
        "packages:",
        "  registry.corp.example/p/1.0.0:",
        `    resolution: {integrity: ${integrity}}`,
      ].join("\n");
    expect(bumpsOf("pnpm", hostKey(sha512("a")), hostKey(sha512("b")))).toHaveLength(1);
    const tarball = (integrity: string) =>
      pnpmLock([
        {
          key: "p@1.0.0",
          resolution: `{integrity: ${integrity}, tarball: https://npm.corp.example/p/-/p-1.0.0.tgz}`,
        },
      ]);
    expect(bumpsOf("pnpm", tarball(sha512("a")), tarball(sha512("b")))).toHaveLength(1);
  });

  test("uv: a private index re-pin of the same version, by any file hash", () => {
    const uv = (wheel: string) =>
      [
        "version = 1",
        "[[package]]",
        'name = "internal"',
        'version = "1.0.0"',
        'source = { registry = "https://pypi.corp.example/simple" }',
        `sdist = { url = "https://f/internal-1.0.0.tar.gz", hash = "${sha256("sdist")}", size = 1 }`,
        "wheels = [",
        `    { url = "https://f/internal-1.0.0-py3-none-any.whl", hash = "${sha256(wheel)}", size = 1 },`,
        "]",
      ].join("\n");
    expect(bumpsOf("uv", uv("w1"), uv("w2"))).toEqual([
      expect.objectContaining({ name: "internal", privateSource: true }),
    ]);
    expect(bumpsOf("uv", uv("w1"), uv("w1"))).toEqual([]);
  });

  test("Berry: a URL dependency whose checksum changed", () => {
    const berry = (checksum: string) =>
      [
        "__metadata:",
        "  version: 8",
        "",
        '"tar@https://cdn.example/tar.tgz":',
        "  version: 2.0.0",
        '  resolution: "tar@https://cdn.example/tar.tgz"',
        `  checksum: ${checksum}`,
      ].join("\n");
    expect(bumpsOf("yarn", berry("10c0/aaa"), berry("10c0/bbb"))).toEqual([
      expect.objectContaining({ privateSource: true, remoteSource: true }),
    ]);
  });

  test("two long references that differ only in the middle keep distinct identities", () => {
    const ref = (middle: string) =>
      `https://cdn.example/${"a".repeat(150)}${middle}${"b".repeat(150)}.tgz`;
    const npm = (middle: string) => npmLock({ t: { version: "1.0.0", resolved: ref(middle) } });
    const [identity] = parseLockfile("npm", npm("x")).packages.get("npm:t")!.versions;
    expect(identity).toHaveLength(200);
    expect(bumpsOf("npm", npm("x"), npm("y"))).toHaveLength(1);
  });
});

describe("D4: private registry versus git, URL, and tarball sources", () => {
  test.each([
    ["git", "git+ssh://git@github.com/a/b.git#abc", "remote"],
    ["a GitHub shorthand", "github:a/b#abc", "remote"],
    ["an arbitrary tarball", "https://cdn.example/b-1.0.0.tgz", "remote"],
    [
      "a registry-shaped tarball on another host",
      "https://npm.corp.example/b/-/b-1.0.0.tgz",
      "registry",
    ],
    [
      "a registry-shaped tarball under a path",
      "https://h.example/api/npm/r/b/-/b-1.0.0.tgz",
      "registry",
    ],
    [
      "a registry-shaped tarball for another version",
      "https://npm.corp.example/b/-/b-2.0.0.tgz",
      "remote",
    ],
    [
      "a registry-shaped tarball for another name",
      "https://npm.corp.example/c/-/c-1.0.0.tgz",
      "remote",
    ],
    [
      "an encoded separator in the registry path",
      "https://h.example/a%2f..%2fb/b/-/b-1.0.0.tgz",
      "remote",
    ],
  ])("npm lock: %s is %s", (_, resolved, kind) => {
    const snapshot = parseLockfile("npm", npmLock({ b: { version: "1.0.0", resolved } }));
    expect(Object.values(kindsOf(snapshot, "npm:b"))).toEqual([kind]);
  });

  test("a scoped registry-shaped tarball may encode the scope's slash", () => {
    const snapshot = parseLockfile(
      "npm",
      npmLock({
        "@corp/b": {
          version: "1.0.0",
          resolved: "https://npm.corp.example/@corp%2fb/-/b-1.0.0.tgz",
        },
      }),
    );
    expect(Object.values(kindsOf(snapshot, "npm:@corp/b"))).toEqual(["registry"]);
  });

  test("bumps carry remoteSource only for remote sides", () => {
    const registry = (v: string) =>
      npmLock({ b: { version: v, resolved: `https://npm.corp.example/b/-/b-${v}.tgz` } });
    expect(bumpsOf("npm", registry("1.0.0"), registry("1.0.1"))[0]).toEqual(
      expect.objectContaining({ privateSource: true }),
    );
    expect(bumpsOf("npm", registry("1.0.0"), registry("1.0.1"))[0]).not.toHaveProperty(
      "remoteSource",
    );
    const tar = (v: string) =>
      npmLock({ b: { version: v, resolved: `https://cdn.example/b-${v}.tgz` } });
    expect(bumpsOf("npm", tar("1.0.0"), tar("1.0.1"))[0]).toEqual(
      expect.objectContaining({ privateSource: true, remoteSource: true }),
    );
  });

  test("uv: another index is a registry, git and URL sources are remote", () => {
    const text = [
      "version = 1",
      "[[package]]",
      'name = "internal"',
      'version = "1.0.0"',
      'source = { registry = "https://pypi.corp.example/simple" }',
      "[[package]]",
      'name = "gitpkg"',
      'version = "1.0.0"',
      'source = { git = "https://github.com/a/b?rev=abc#abc" }',
      "[[package]]",
      'name = "urlpkg"',
      'version = "1.0.0"',
      'source = { url = "https://example.com/u.tar.gz" }',
      "[[package]]",
      'name = "odd"',
      'version = "1.0.0"',
      'source = { registry = "https://pypi.org/simple", subdirectory = "x" }',
    ].join("\n");
    const snapshot = parseLockfile("uv", text);
    expect(Object.values(kindsOf(snapshot, "pypi:internal"))).toEqual(["registry"]);
    expect(Object.values(kindsOf(snapshot, "pypi:gitpkg"))).toEqual(["remote"]);
    expect(Object.values(kindsOf(snapshot, "pypi:urlpkg"))).toEqual(["remote"]);
    // A registry source with anything beside it is not a plain registry.
    expect(Object.values(kindsOf(snapshot, "pypi:odd"))).toEqual(["remote"]);
  });

  test("a name routed to a declared private registry is private, not remote", () => {
    const [bump] = routed(
      "npm",
      npmLock({ a: { version: "1.0.0" } }),
      npmLock({ a: { version: "1.0.1" } }),
      {
        route: { kind: "registries", urls: ["https://npm.corp.example/"] },
        privateRegistries: ["https://npm.corp.example/"],
      },
    );
    expect(bump).toEqual(
      expect.objectContaining({ fromVersion: "1.0.0", toVersion: "1.0.1", privateSource: true }),
    );
    expect(bump).not.toHaveProperty("remoteSource");
    expect(bump).not.toHaveProperty("mirror");
  });
});

describe("mirror candidates", () => {
  const at = (v: string, base = MIRROR, name = "lodash") => `${base}${name}/-/${name}-${v}.tgz`;
  const mirrored = (v: string, integrity: string, base = MIRROR) =>
    npmLock({ lodash: { version: v, resolved: at(v, base), integrity } });

  test("npm lock: both sides under a declared mirror name real versions and their sha512", () => {
    const [bump] = routed(
      "npm",
      mirrored("4.17.21", sha512("a")),
      mirrored("4.17.22", sha512("b")),
    );
    expect(bump).toEqual(
      expect.objectContaining({
        fromVersion: "4.17.21",
        toVersion: "4.17.22",
        privateSource: true,
        mirror: { fromHashes: [sha512("a")], toHashes: [sha512("b")] },
      }),
    );
    expect(bump).not.toHaveProperty("remoteSource");
  });

  test("a new package has no from hashes", () => {
    const [bump] = routed("npm", npmLock({}), mirrored("4.17.22", sha512("b")));
    expect(bump.mirror).toEqual({ fromHashes: null, toHashes: [sha512("b")] });
    expect(bump.fromVersion).toBeNull();
  });

  test("a public from side counts as itself", () => {
    const before = npmLock({
      lodash: {
        version: "4.17.21",
        resolved: "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz",
        integrity: sha512("a"),
      },
    });
    const [bump] = routed("npm", before, mirrored("4.17.22", sha512("b")));
    expect(bump.mirror).toEqual({ fromHashes: [sha512("a")], toHashes: [sha512("b")] });
  });

  test("the prefix is a path boundary", () => {
    const base = "https://m.example/npm-private/";
    const [bump] = routed(
      "npm",
      mirrored("4.17.21", sha512("a"), base),
      mirrored("4.17.22", sha512("b"), base),
    );
    expect(bump).toEqual(expect.objectContaining({ privateSource: true }));
    expect(bump).not.toHaveProperty("mirror");
    expect(bump.toVersion).toBe(`${at("4.17.22", base)} (${sha512("b")})`);
  });

  test("extra path segments between the prefix and the package are not a candidate", () => {
    const base = `${MIRROR}nested/`;
    const [bump] = routed(
      "npm",
      mirrored("4.17.21", sha512("a"), base),
      mirrored("4.17.22", sha512("b"), base),
    );
    expect(bump).not.toHaveProperty("mirror");
  });

  test.each([
    ["sha1 only", () => sha1("b"), null],
    ["sha512 beside a weaker sha1", () => `${sha1("b")} ${sha512("b")}`, () => [sha512("b")]],
    [
      "two sha512 components",
      () => `${sha512("b")} ${sha512("c")}`,
      () => [sha512("b"), sha512("c")].sort(),
    ],
    [
      "an unknown algorithm beside sha512",
      () => `${sha512("b")} sha3-512-${"A".repeat(86)}==`,
      null,
    ],
    ["a malformed sha512", () => "sha512-short==", null],
    ["sha512 with options", () => `${sha512("b")}?opt`, null],
    ["no integrity", () => undefined, null],
  ])("integrity with %s", (_, integrity, hashes) => {
    const after = npmLock({
      lodash: { version: "4.17.22", resolved: at("4.17.22"), integrity: integrity() },
    });
    const [bump] = routed("npm", mirrored("4.17.21", sha512("a")), after);
    if (hashes === null) expect(bump).not.toHaveProperty("mirror");
    else expect(bump.mirror?.toHashes).toEqual(hashes());
  });

  test("a name routed to a registry outside the mirrors is never a candidate", () => {
    const routes: NameRoute[] = [
      { kind: "registries", urls: ["https://npm.corp.example/"] },
      { kind: "registries", urls: [MIRROR, "https://npm.corp.example/"] },
      { kind: "registries", urls: ["https://m.example/npm-private/"] },
      { kind: "unknown" },
    ];
    for (const route of routes) {
      const [bump] = routed(
        "npm",
        mirrored("4.17.21", sha512("a")),
        mirrored("4.17.22", sha512("b")),
        {
          route,
        },
      );
      expect(bump).toEqual(expect.objectContaining({ privateSource: true }));
      expect(bump).not.toHaveProperty("mirror");
    }
  });

  test("no declared mirrors, no candidates", () => {
    const [bump] = routed(
      "npm",
      mirrored("4.17.21", sha512("a")),
      mirrored("4.17.22", sha512("b")),
      {
        mirrors: [],
      },
    );
    expect(bump).not.toHaveProperty("mirror");
  });

  test("pnpm records no URL: the repository routing the name to a mirror makes it a candidate", () => {
    const pnpm = (v: string, seed: string) =>
      pnpmLock([{ key: `lodash@${v}`, resolution: `{integrity: ${sha512(seed)}}` }]);
    const [routedToMirror] = routed("pnpm", pnpm("4.17.21", "a"), pnpm("4.17.22", "b"), {
      route: { kind: "registries", urls: ["https://m.example/npm"] },
    });
    expect(routedToMirror).toEqual(
      expect.objectContaining({
        fromVersion: "4.17.21",
        toVersion: "4.17.22",
        mirror: { fromHashes: [sha512("a")], toHashes: [sha512("b")] },
      }),
    );
    const [publicRoute] = routed("pnpm", pnpm("4.17.21", "a"), pnpm("4.17.22", "b"));
    expect(publicRoute).not.toHaveProperty("privateSource");
    expect(publicRoute).not.toHaveProperty("mirror");
  });

  test("Yarn Berry is never a candidate", () => {
    const berry = (v: string) =>
      [
        "__metadata:",
        "  version: 8",
        '"lodash@npm:^4":',
        `  version: ${v}`,
        `  resolution: "lodash@npm:${v}"`,
        `  checksum: 10c0/${"a".repeat(128)}`,
      ].join("\n");
    const [bump] = routed("yarn", berry("4.17.21"), berry("4.17.22"), {
      route: { kind: "registries", urls: [MIRROR] },
    });
    expect(bump).toEqual(expect.objectContaining({ privateSource: true }));
    expect(bump).not.toHaveProperty("mirror");
  });

  test("Yarn classic resolved under a mirror, with its sha1 fragment, is a candidate", () => {
    const yarn = (v: string, seed: string) =>
      yarnV1([
        {
          descriptor: "lodash@^4",
          version: v,
          resolved: `${at(v)}#${SHA1_HEX}`,
          integrity: sha512(seed),
        },
      ]);
    const [bump] = routed("yarn", yarn("4.17.21", "a"), yarn("4.17.22", "b"));
    expect(bump.mirror).toEqual({ fromHashes: [sha512("a")], toHashes: [sha512("b")] });
  });

  test("the same version moved onto a mirror is a re-pin candidate: only its pins are proven", () => {
    const before = npmLock({
      lodash: {
        version: "4.17.22",
        resolved: "https://registry.npmjs.org/lodash/-/lodash-4.17.22.tgz",
        integrity: sha512("b"),
      },
    });
    const [bump] = routed("npm", before, mirrored("4.17.22", sha512("b")));
    expect(bump).toEqual(
      expect.objectContaining({
        fromVersion: null,
        toVersion: "4.17.22",
        privateSource: true,
        repinned: true,
        mirror: { fromHashes: null, toHashes: [sha512("b")] },
      }),
    );
  });

  test("two copies of one version with different pins fold into one change needing both", () => {
    const after = npmLock({
      lodash: { version: "4.17.22", resolved: at("4.17.22"), integrity: sha512("b") },
      "x/node_modules/lodash": {
        version: "4.17.22",
        resolved: at("4.17.22"),
        integrity: sha512("evil"),
      },
    });
    // collect.ts folds bumps by change key; this is the same fold.
    const [first, ...rest] = routed("npm", mirrored("4.17.21", sha512("a")), after);
    expect(rest).toHaveLength(1);
    const folded = { ...first };
    for (const bump of rest) {
      expect([bump.fromVersion, bump.toVersion]).toEqual([folded.fromVersion, folded.toVersion]);
      mergeBump(folded, bump);
    }
    expect(folded.mirror?.toHashes).toEqual([sha512("b"), sha512("evil")].sort());
  });

  describe("uv", () => {
    const uv = (source: string, version: string, files: string[]) =>
      [
        "version = 1",
        "[[package]]",
        'name = "Requests"',
        `version = "${version}"`,
        `source = { registry = "${source}" }`,
        ...files,
      ].join("\n");
    const sdist = (seed: string) =>
      `sdist = { url = "https://m.example/pypi/f/requests.tar.gz", hash = "${sha256(seed)}", size = 1, upload-time = "2024-01-01T00:00:00Z" }`;
    const wheels = (...seeds: string[]) => [
      "wheels = [",
      ...seeds.map(
        (seed) =>
          `    { url = "https://m.example/pypi/f/${seed}.whl", hash = "${sha256(seed)}", size = 1 },`,
      ),
      "]",
    ];
    const index = "https://m.example/pypi/simple";

    test("every file hash of both sides, sorted", () => {
      const [bump] = routed(
        "uv",
        uv(index, "2.31.0", [sdist("a"), ...wheels("b")]),
        uv(index, "2.32.0", [sdist("c"), ...wheels("e", "d")]),
      );
      expect(bump).toEqual(
        expect.objectContaining({
          name: "requests",
          fromVersion: "2.31.0",
          toVersion: "2.32.0",
          mirror: {
            fromHashes: [sha256("a"), sha256("b")].sort(),
            toHashes: [sha256("c"), sha256("d"), sha256("e")].sort(),
          },
        }),
      );
    });

    test("a PyPI from side and a mirror to side", () => {
      const [bump] = routed(
        "uv",
        uv("https://pypi.org/simple", "2.31.0", [sdist("a")]),
        uv(index, "2.32.0", [sdist("c")]),
      );
      expect(bump.mirror).toEqual({ fromHashes: [sha256("a")], toHashes: [sha256("c")] });
    });

    test.each([
      ["an index outside the mirror", [sdist("c")], "https://m.example/pypi-private/simple"],
      [
        "a file with no hash",
        [
          sdist("c"),
          "wheels = [",
          '    { url = "https://m.example/pypi/f/x.whl", size = 1 },',
          "]",
        ],
        index,
      ],
      [
        "a non-sha256 hash",
        [`sdist = { url = "https://m.example/pypi/f/r.tar.gz", hash = "md5:${"a".repeat(32)}" }`],
        index,
      ],
      ["no files", [], index],
      [
        "a file table in table form",
        [
          sdist("c"),
          "[[package.wheels]]",
          'url = "https://m.example/pypi/f/x.whl"',
          `hash = "${sha256("x")}"`,
        ],
        index,
      ],
      [
        "an indented wheels key",
        [sdist("c"), "  wheels = [", `    { url = "x", hash = "${sha256("x")}" },`, "]"],
        index,
      ],
      [
        "a single-line wheels array",
        [sdist("c"), `wheels = [{ url = "x", hash = "${sha256("x")}" }]`],
        index,
      ],
      [
        "an escaped quote",
        [`sdist = { url = "a\\" hash = \\"${sha256("c")}", hash = "${sha256("evil")}" }`],
        index,
      ],
      ["an encoded path", [sdist("c")], "https://m.example/pypi/%2e%2e/private/simple"],
      ["a dotted file key", [sdist("c"), `wheels.extra = "x"`], index],
    ])("%s is not a candidate", (_, files, source) => {
      const [bump] = routed("uv", uv(index, "2.31.0", [sdist("a")]), uv(source, "2.32.0", files));
      expect(bump).not.toHaveProperty("mirror");
    });

    test("the hash read is the `hash` key uv reads, not text inside another value", () => {
      const lifted = `sdist = { url = "https://m.example/pypi/f/a.tar.gz", upload-time = "a hash = ${sha256("c")}", hash="${sha256("evil")}" }`;
      const [bump] = routed("uv", uv(index, "2.31.0", [sdist("a")]), uv(index, "2.32.0", [lifted]));
      expect(bump.mirror?.toHashes).toEqual([sha256("evil")]);
    });
  });
});

describe("mergeBump", () => {
  const base: DependencyBump = {
    ecosystem: "npm",
    name: "a",
    fromVersion: "1.0.0",
    toVersion: "1.0.1",
    direct: false,
    lockfilePath: "a/package-lock.json",
    privateSource: true,
    mirror: { fromHashes: [sha512("a")], toHashes: [sha512("b")] },
  };

  test("unions mirror hashes, so every lockfile's pin must match", () => {
    const existing = { ...base };
    mergeBump(existing, {
      ...base,
      direct: true,
      mirror: { fromHashes: [sha512("a")], toHashes: [sha512("evil")] },
    });
    expect(existing.direct).toBe(true);
    expect(existing.mirror).toEqual({
      fromHashes: [sha512("a")],
      toHashes: [sha512("b"), sha512("evil")].sort(),
    });
  });

  test("a change new in one lockfile and re-pinned in another is new, in either order", () => {
    // One workspace's lockfile re-pins fresh@1.0.0 it already had; another's
    // installs fresh@1.0.0 for the first time.
    const pins = [sha512("fresh")];
    const repin: DependencyBump = {
      ecosystem: "npm",
      name: "fresh",
      fromVersion: null,
      toVersion: "1.0.0",
      direct: false,
      lockfilePath: "a/package-lock.json",
      repinned: true,
      pinnedHashes: pins,
    };
    const added: DependencyBump = { ...repin, lockfilePath: "b/package-lock.json" };
    delete added.repinned;
    for (const [first, second] of [
      [repin, added],
      [added, repin],
    ]) {
      const merged = { ...first };
      mergeBump(merged, second);
      expect(merged).not.toHaveProperty("repinned");
    }
    const both = { ...repin };
    mergeBump(both, { ...repin, lockfilePath: "b/package-lock.json" });
    expect(both.repinned).toBe(true);
  });

  test("a change one copy reads as replacing a non-public source keeps that note", () => {
    const plain: DependencyBump = { ...base, fromVersion: null, privateSource: undefined };
    delete plain.mirror;
    const merged = { ...plain };
    mergeBump(merged, { ...plain, replacesPrivate: true });
    expect(merged.replacesPrivate).toBe(true);
  });

  test("a change only one lockfile reads as a mirror copy stays plain private", () => {
    const existing = { ...base };
    const { mirror: _, ...plain } = base;
    mergeBump(existing, plain);
    expect(existing).not.toHaveProperty("mirror");
    const other = { ...plain };
    mergeBump(other, base);
    expect(other).not.toHaveProperty("mirror");
  });
});

describe("uv.lock reading", () => {
  const block = (lines: string[]) => ["version = 1", ...lines].join("\n");
  const registry = 'source = { registry = "https://pypi.org/simple" }';

  test("table headers spelled with spaces, quotes, or a comment still open a package", () => {
    for (const header of ["[[ package ]]", '[["package"]]', "[[package]] # c"]) {
      const snapshot = parseLockfile(
        "uv",
        block([header, 'name = "a"', 'version = "1.0.0"', registry]),
      );
      expect(snapshot.complete).toBe(true);
      expect([...snapshot.packages.keys()]).toEqual(["pypi:a"]);
    }
  });

  test.each([
    ["an unreadable header", ["[[package]", 'name = "a"', 'version = "1.0.0"', registry]],
    ["a name in another form", ["[[package]]", 'name="a"', 'version = "1.0.0"', registry]],
    ["a commented version", ["[[package]]", 'name = "a"', 'version = "1.0.0" # x', registry]],
    ["a repeated name", ["[[package]]", 'name = "a"', 'name = "b"', 'version = "1.0.0"', registry]],
    [
      "a source in another form",
      ["[[package]]", 'name = "a"', 'version = "1.0.0"', "source = { registry = 'https://x' }"],
    ],
    ["no source", ["[[package]]", 'name = "a"', 'version = "1.0.0"']],
    [
      "a multi-line string",
      ["[[package]]", 'name = "a"', 'version = "1.0.0"', registry, 'x = """', "y", '"""'],
    ],
    [
      "an unterminated array",
      ["[[package]]", 'name = "a"', 'version = "1.0.0"', registry, "dependencies = ["],
    ],
  ])("%s makes the snapshot incomplete", (_, lines) => {
    expect(parseLockfile("uv", block(lines)).complete).toBe(false);
  });
});

describe("registry config routes", () => {
  test("scopes and the default registry keep their URLs", () => {
    const found = collectCustomRegistries(emptyCustomRegistries(), {
      npmrc: "@corp:registry=https://npm.corp.example/\nregistry=https://m.example/npm/",
      yarnrc: null,
    });
    expect(npmNameRoute(found, "@corp/sdk")).toEqual({
      kind: "registries",
      urls: ["https://npm.corp.example/"],
    });
    expect(npmNameRoute(found, "lodash")).toEqual({ kind: "registries", urls: [MIRROR] });
  });

  test("nothing routed is public; flow-style or unreadable config is unknown", () => {
    expect(npmNameRoute(emptyCustomRegistries(), "lodash")).toEqual(PUBLIC_ROUTE);
    const flow = collectCustomRegistries(emptyCustomRegistries(), {
      npmrc: null,
      yarnrc: "npmScopes: { corp: { npmRegistryServer: https://x } }",
    });
    expect(npmNameRoute(flow, "lodash")).toEqual({ kind: "unknown" });
    expect(npmNameRoute(unreadableCustomRegistries(), "lodash")).toEqual({ kind: "unknown" });
  });

  test("Yarn scopes route to their npmRegistryServer", () => {
    const found = collectCustomRegistries(emptyCustomRegistries(), {
      npmrc: null,
      yarnrc: ["npmScopes:", "  corp:", '    npmRegistryServer: "https://m.example/npm"'].join(
        "\n",
      ),
    });
    expect(npmNameRoute(found, "@corp/x")).toEqual({
      kind: "registries",
      urls: ["https://m.example/npm"],
    });
    expect(npmNameRoute(found, "lodash")).toEqual(PUBLIC_ROUTE);
  });
});

describe("remote identities never read as a public version", () => {
  test("a pnpm entry whose fields disagree with its key, without a pin, is still a change", () => {
    const before = pnpmLock([{ key: "lodash@4.17.22", resolution: "{integrity: sha512-x}" }]);
    const after = [
      "lockfileVersion: '9.0'",
      "packages:",
      "  lodash@4.17.22:",
      "    resolution: {}",
      "    version: 1.0.0",
    ].join("\n");
    expect(bumpsOf("pnpm", before, after)).toEqual([
      expect.objectContaining({
        fromVersion: "4.17.22",
        toVersion: "4.17.22 (unknown source)",
        privateSource: true,
        remoteSource: true,
      }),
    ]);
  });
});

describe("entries that name no exact version are remote, never dropped", () => {
  test("Yarn classic and Berry ranges", () => {
    const v1 = parseLockfile("yarn", yarnV1([{ descriptor: "a@^1", version: "^1.0.0" }]));
    expect(kindsOf(v1, "npm:a")).toEqual({ "^1.0.0": "remote" });
    const berry = parseLockfile(
      "yarn",
      [
        "__metadata:",
        "  version: 8",
        '"a@npm:^1":',
        "  version: 1.0.0",
        '  resolution: "a@npm:^1"',
      ].join("\n"),
    );
    expect(kindsOf(berry, "npm:a")).toEqual({ "^1": "remote" });
  });

  test("a pnpm key whose version is not strict semver", () => {
    const snapshot = parseLockfile(
      "pnpm",
      pnpmLock([{ key: "a@01.0.0", resolution: "{integrity: sha512-x}" }]),
    );
    expect(Object.values(kindsOf(snapshot, "npm:a"))).toEqual(["remote"]);
  });
});
