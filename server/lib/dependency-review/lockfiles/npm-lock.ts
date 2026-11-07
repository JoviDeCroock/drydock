import {
  createSnapshotBuilder,
  incompleteSnapshot,
  MANIFEST_DEPENDENCY_FIELDS,
  ownField,
  sourceOf,
  type LockfileSnapshot,
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
  const entries = Object.entries(packages as Record<string, unknown>);
  for (const [path, entry] of entries) {
    const pkg = installedPackage(path, entry);
    if (pkg?.remote) builder.addRemote(pkg.name, pkg.resolved, ownField(entry, "version"));
    else if (pkg) builder.add(pkg.name, ownField(entry, "version"));
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
        builder.markDirect(
          installedPackage(path, (packages as Record<string, unknown>)[path])?.name,
        );
      }
    }
  }
  return builder.finish();
}

// The package an installed entry stands for, or null when its code is in the
// repository: a workspace link, a `file:` source, or a bundled copy that ships
// inside its parent's tarball. A `resolved` anywhere but the public registry
// (a private registry, git, a tarball URL) is a remote source.
function installedPackage(
  path: string,
  entry: unknown,
): { name: string; resolved: unknown; remote: boolean } | null {
  const at = path.lastIndexOf(NODE_MODULES);
  if (at === -1) return null;
  if (ownField(entry, "link") === true || ownField(entry, "inBundle") === true) return null;
  const resolved = ownField(entry, "resolved");
  const source = resolved === undefined ? "public" : sourceOf(resolved);
  if (source === "local") return null;
  // An alias (`"x": "npm:real@^1"`) installs under its alias path and names the
  // real package in `name`.
  const name = ownField(entry, "name");
  return {
    name: typeof name === "string" ? name : path.slice(at + NODE_MODULES.length),
    resolved,
    remote: source === "remote",
  };
}
