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
  const entries = Object.entries(packages as Record<string, unknown>);
  for (const [path, entry] of entries) {
    const pkg = installedPackage(path, entry);
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
// inside its parent's tarball.
function installedPackage(path: string, entry: unknown): { name: string } | null {
  const at = path.lastIndexOf(NODE_MODULES);
  if (at === -1) return null;
  if (ownField(entry, "link") === true || ownField(entry, "inBundle") === true) return null;
  if (isLocalSource(ownField(entry, "resolved"))) return null;
  // An alias (`"x": "npm:real@^1"`) installs under its alias path and names the
  // real package in `name`.
  const name = ownField(entry, "name");
  return { name: typeof name === "string" ? name : path.slice(at + NODE_MODULES.length) };
}

// With no `resolved`, npm fetches `name@version` from the configured registry
// (the caller applies the repository's registry config to the name). A
// `version` that is not an exact version is then a spec npm resolves itself
// (a range, a URL), which pins nothing here, so it is a remote source rather
// than a dropped entry. With a `resolved`, the URL decides (see
// `classifyNpmTarball`); one that is not a string is a remote source.
function recordInstalled(builder: SnapshotBuilder, name: string, entry: unknown): void {
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
  if (typeof resolved !== "string") {
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
  } else builder.addRemote(name, resolved, version, pin);
}
