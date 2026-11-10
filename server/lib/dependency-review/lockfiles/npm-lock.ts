import {
  classifyNpmTarball,
  createSnapshotBuilder,
  incompleteSnapshot,
  isLocalSource,
  MANIFEST_DEPENDENCY_FIELDS,
  npmIntegrity,
  ownField,
  validLockfileVersion,
  type LockfileSnapshot,
  type SnapshotBuilder,
} from "./snapshot";

const NODE_MODULES = "node_modules/";

// package-lock.json / npm-shrinkwrap.json v2 and v3. Every `packages` entry
// under a node_modules path is an installed package; the other keys are the
// root and workspace importers. Version 1 has no `packages` map and reads as
// incomplete.
export function parseNpmLock(text: string): LockfileSnapshot {
  let packages: unknown;
  try {
    packages = ownField(JSON.parse(text), "packages");
  } catch {
    return incompleteSnapshot();
  }
  if (typeof packages !== "object" || packages === null || Array.isArray(packages)) {
    return incompleteSnapshot();
  }
  const builder = createSnapshotBuilder("npm");
  builder.expectStrongPins();
  const all = packages as Record<string, unknown>;
  const entries = Object.entries(all);
  const bundle = bundledPaths(all);
  for (const [path, entry] of entries) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      if (path.includes(NODE_MODULES)) builder.markIncomplete();
      continue;
    }
    if (path && !path.includes(NODE_MODULES)) builder.addWorkspace(path);
    const pkg = installedPackage(path, entry, bundle);
    if (pkg) recordInstalled(builder, pkg.name, entry);
  }
  for (const [importer, entry] of entries) {
    if (importer.includes(NODE_MODULES)) continue;
    for (const field of MANIFEST_DEPENDENCY_FIELDS) {
      const declared = ownField(entry, field);
      if (typeof declared !== "object" || declared === null) continue;
      for (const dep of Object.keys(declared)) {
        const local = importer ? `${importer}/${NODE_MODULES}${dep}` : `${NODE_MODULES}${dep}`;
        const hoisted = `${NODE_MODULES}${dep}`;
        const path = Object.hasOwn(packages, local) ? local : hoisted;
        if (!Object.hasOwn(packages, path)) continue;
        builder.markDirect(installedPackage(path, all[path], bundle)?.name);
      }
    }
  }
  return builder.finish();
}

// The package an installed entry stands for, or null when its code is in the
// repository (a workspace link, a `file:` source) or ships inside a bundling
// package's tarball (see `bundledPaths`). An `inBundle` flag anywhere else is
// ignored and the entry recorded like any other: a wrongly recorded entry is
// an extra bump, a wrongly skipped one an unreviewed install. A `name` that is
// not a string is recorded as is, which the builder refuses (incomplete).
function installedPackage(
  path: string,
  entry: unknown,
  bundle: ReadonlySet<string>,
): { name: unknown } | null {
  const at = path.lastIndexOf(NODE_MODULES);
  if (at === -1) return null;
  if (ownField(entry, "link") === true) return null;
  if (isLocalSource(ownField(entry, "resolved"))) return null;
  if (
    ownField(entry, "inBundle") === true &&
    ownField(entry, "resolved") === undefined &&
    bundle.has(path)
  ) {
    return null;
  }
  // An alias (`"x": "npm:real@^1"`) installs under its alias path and names the
  // real package in `name`.
  const name = ownField(entry, "name");
  return { name: name === undefined ? path.slice(at + NODE_MODULES.length) : name };
}

const BUNDLE_EDGES = ["dependencies", "optionalDependencies"] as const;

/**
 * The install paths npm takes as shipped inside a bundling package's tarball,
 * the way arborist derives bundles: for each installed package that declares
 * `bundleDependencies` (or `true`, every dependency), the entries in its own
 * `node_modules` it names, then whatever those require that node resolution
 * finds inside that same `node_modules`, transitively. A dependency that
 * resolves anywhere outside it is fetched, not bundled.
 */
function bundledPaths(packages: Record<string, unknown>): Set<string> {
  const bundle = new Set<string>();
  for (const [bundler, entry] of Object.entries(packages)) {
    if (!bundler.includes(NODE_MODULES)) continue;
    const declared =
      ownField(entry, "bundleDependencies") ?? ownField(entry, "bundledDependencies");
    let names: unknown[];
    if (declared === true) {
      names = BUNDLE_EDGES.flatMap((field) => {
        const deps = ownField(entry, field);
        return typeof deps === "object" && deps !== null ? Object.keys(deps) : [];
      });
    } else if (Array.isArray(declared)) names = declared;
    else continue;
    const inside = `${bundler}/${NODE_MODULES}`;
    const queue: string[] = [];
    for (const name of names) {
      if (typeof name === "string" && Object.hasOwn(packages, inside + name)) {
        queue.push(inside + name);
      }
    }
    const seen = new Set<string>();
    while (queue.length > 0) {
      const at = queue.pop()!;
      if (seen.has(at)) continue;
      seen.add(at);
      bundle.add(at);
      for (const field of BUNDLE_EDGES) {
        const deps = ownField(packages[at], field);
        if (typeof deps !== "object" || deps === null) continue;
        for (const dep of Object.keys(deps)) {
          const target = resolveWithin(packages, at, dep, bundler);
          if (target !== null) queue.push(target);
        }
      }
    }
  }
  return bundle;
}

// Node resolution of `dep` from the package at `from`, looking only as far up
// as `root`'s own `node_modules`: the first `<dir>/node_modules/<dep>` that is
// installed, or null when none is (it resolves outside `root`).
function resolveWithin(
  packages: Record<string, unknown>,
  from: string,
  dep: string,
  root: string,
): string | null {
  let dir = from;
  for (;;) {
    const candidate = `${dir}/${NODE_MODULES}${dep}`;
    if (Object.hasOwn(packages, candidate)) return candidate;
    if (dir === root) return null;
    const at = dir.lastIndexOf(`/${NODE_MODULES}`);
    if (at < root.length) return null;
    dir = dir.slice(0, at);
  }
}

// With no `resolved`, npm fetches `name@version` from the configured registry
// (the caller applies the repository's registry config to the name). A
// `version` that is not an exact version is then a spec npm resolves itself
// (a range, a URL), which pins nothing here, so it is a remote source rather
// than a dropped entry. With a `resolved`, the URL decides (see
// `classifyNpmTarball`); one that is not a string is a remote source.
function recordInstalled(builder: SnapshotBuilder, name: unknown, entry: unknown): void {
  const version = ownField(entry, "version");
  const resolved = ownField(entry, "resolved");
  const { pin, hashes } = npmIntegrity(ownField(entry, "integrity"));
  if (resolved === undefined) {
    if (typeof version === "string" && !validLockfileVersion("npm", version)) {
      builder.addRemote(name, version, null, pin);
    } else {
      builder.add(name, version, { hashes, pin });
    }
    return;
  }
  if (typeof resolved !== "string" || typeof name !== "string") {
    builder.addRemote(name, null, version, pin);
    return;
  }
  const source = classifyNpmTarball(resolved, name, version);
  if (source.kind === "public") builder.add(name, version, { hashes, pin });
  else if (source.kind === "registry") {
    builder.add(name, version, {
      registry: { location: source.location, ref: resolved },
      hashes,
      pin,
    });
  } else builder.addRemote(name, resolved, version, pin, source.location);
}
