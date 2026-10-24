import {
  createSnapshotBuilder,
  MANIFEST_DEPENDENCY_FIELDS,
  sourceOf,
  ownField,
  type LockfileSnapshot,
} from "./snapshot";
import { textLines, yamlKey } from "./lines";

interface YarnEntry {
  descriptors: string[];
  version: string | null;
  resolved: string | null;
  resolution: string | null;
  // Berry workspace entries list each workspace's own dependencies.
  dependencies: Array<[string, string]>;
}

// yarn.lock, v1 and Berry. Every entry is an installed package. Direct
// dependencies come from the package.json beside the lockfile and, in Berry,
// from each `workspace:` entry's dependency list.
export function parseYarnLock(text: string, manifestText: string | null): LockfileSnapshot {
  const builder = createSnapshotBuilder("npm");
  const entries = readEntries(text, builder.reserve);
  const byDescriptor = new Map<string, string>();
  for (const entry of entries) {
    const pkg = yarnPackage(entry);
    if (!pkg) continue;
    if (pkg.remote) builder.addRemote(pkg.name, pkg.remote.ref, pkg.version);
    else builder.add(pkg.name, pkg.version);
    for (const descriptor of entry.descriptors) byDescriptor.set(descriptor, pkg.name);
  }
  const declare = (dep: string, spec: string) => {
    const berrySpec = spec.startsWith("npm:") ? spec : `npm:${spec}`;
    builder.markDirect(
      byDescriptor.get(`${dep}@${spec}`) ?? byDescriptor.get(`${dep}@${berrySpec}`),
    );
  };
  for (const [dep, spec] of manifestDependencies(manifestText, builder.reserve)) declare(dep, spec);
  for (const entry of entries) {
    if (!protocolOf(entry.resolution ?? "")?.startsWith("workspace:")) continue;
    for (const [dep, spec] of entry.dependencies) declare(dep, spec);
  }
  return builder.finish();
}

function readEntries(text: string, reserve: (count?: number) => boolean): YarnEntry[] {
  const entries: YarnEntry[] = [];
  let current: YarnEntry | null = null;
  let inDependencies = false;
  for (const raw of textLines(text)) {
    if (!raw.trim() || raw.startsWith("#")) continue;
    if (!/^\s/.test(raw)) {
      const header = raw.trimEnd();
      current = null;
      if (!header.endsWith(":")) continue;
      const descriptors = header
        .slice(0, -1)
        .split(",")
        .map((d) => d.trim().replace(/^"|"$/g, ""))
        .filter(Boolean);
      if (!reserve(descriptors.length + 1)) break;
      current = { descriptors, version: null, resolved: null, resolution: null, dependencies: [] };
      entries.push(current);
      inDependencies = false;
      continue;
    }
    if (!current) continue;
    let indent = 0;
    while (indent < raw.length && raw.charCodeAt(indent) === 32) indent++;
    const line = raw.slice(indent).trim();
    if (indent === 2) {
      const field = entryField(line);
      inDependencies = field?.key === "dependencies";
      if (field?.key === "version") current.version = field.value;
      else if (field?.key === "resolved") current.resolved = field.value;
      else if (field?.key === "resolution") current.resolution = field.value;
    } else if (indent === 4 && inDependencies) {
      const dep = yamlKey(line);
      if (!dep?.value) continue;
      if (!reserve()) break;
      current.dependencies.push([dep.key, dep.value]);
    }
  }
  return entries;
}

// v1 writes `version "1.0.0"`, Berry writes `version: 1.0.0`.
function entryField(line: string): { key: string; value: string } | null {
  const berry = yamlKey(line);
  if (berry) return berry;
  const space = line.indexOf(" ");
  if (space <= 0) return null;
  return {
    key: line.slice(0, space),
    value: line
      .slice(space + 1)
      .trim()
      .replace(/^"|"$/g, ""),
  };
}

interface YarnPackage {
  name: string;
  version: string | null;
  // Set for a remote source (git, a URL, a private registry): the resolved
  // reference that identifies the fetched code.
  remote: { ref: string | null } | null;
}

// The package an entry installs, or null when its code is in the repository
// (`workspace:`, `portal:`, `link:`, `file:`, a relative path).
function yarnPackage(entry: YarnEntry): YarnPackage | null {
  if (entry.resolution !== null) return berryPackage(entry.resolution, entry.version);
  // v1: one real package across descriptors. A git, URL, or `user/repo`
  // descriptor, or a `resolved` tarball off the public registry, is remote.
  let name: string | null = null;
  let remote = false;
  for (const descriptor of entry.descriptors) {
    const parsed = v1Descriptor(descriptor);
    if (parsed === null || parsed.kind === "local") return null;
    if (name !== null && parsed.name !== name) return null;
    name = parsed.name;
    remote ||= parsed.kind === "remote";
  }
  if (name === null) return null;
  const source = entry.resolved === null ? "public" : sourceOf(entry.resolved);
  if (source === "local") return null;
  return {
    name,
    version: entry.version,
    remote: remote || source === "remote" ? { ref: entry.resolved } : null,
  };
}

function v1Descriptor(
  descriptor: string,
): { name: string; kind: "registry" | "remote" | "local" } | null {
  const at = descriptor.indexOf("@", 1);
  if (at <= 0) return null;
  const name = descriptor.slice(0, at);
  const range = descriptor.slice(at + 1);
  if (range.startsWith("npm:")) {
    const target = range.slice(4);
    const targetAt = target.indexOf("@", 1);
    return { name: targetAt > 0 ? target.slice(0, targetAt) : target, kind: "registry" };
  }
  if (sourceOf(range) === "local" || /^[./~]/.test(range)) return { name, kind: "local" };
  // Semver ranges and dist-tags hold neither; `git+`, `github:`, tarball URLs
  // and `user/repo` shorthands hold one or both.
  const remote = range.includes(":") || range.includes("/");
  return { name, kind: remote ? "remote" : "registry" };
}

// Berry resolutions are `<name>@<protocol>:<reference>`. `npm:` is a registry
// package; Berry adds `::__archiveUrl=` when the tarball is not where the
// default registry keeps it, which marks a private source. `patch:` wraps
// another locator and takes its source. Local protocols are skipped; any other
// protocol (git, http(s), and unknown ones) is a remote source identified by
// its locator. A scope routed to another registry in `.yarnrc.yml` leaves no
// trace here.
function berryPackage(
  resolution: string,
  version: string | null,
  insidePatch = false,
): YarnPackage | null {
  const at = resolution.indexOf("@", 1);
  if (at <= 0) return null;
  const name = resolution.slice(0, at);
  const locator = resolution.slice(at + 1);
  if (locator.startsWith("npm:")) {
    const reference = locator.slice(4);
    const params = reference.indexOf("::");
    const npmVersion = params === -1 ? reference : reference.slice(0, params);
    const archived = params !== -1 && reference.includes("__archiveUrl=", params);
    return { name, version: npmVersion, remote: archived ? { ref: reference } : null };
  }
  if (sourceOf(locator) === "local") return null;
  // A patch of a patch is not unwrapped: each layer would decode the rest of a
  // possibly huge line again.
  if (!locator.startsWith("patch:") || insidePatch) {
    return { name, version, remote: { ref: locator } };
  }
  const hash = locator.indexOf("#");
  let inner: string;
  try {
    inner = decodeURIComponent(locator.slice(6, hash === -1 ? undefined : hash));
  } catch {
    return { name, version, remote: { ref: locator } };
  }
  const innerAt = inner.indexOf("@", 1);
  if (innerAt <= 0 || inner.slice(0, innerAt) !== name) {
    return { name, version, remote: { ref: locator } };
  }
  // The wrapped locator decides the source; the patch file is repository code.
  return berryPackage(inner, version, true);
}

function protocolOf(resolution: string): string | null {
  const at = resolution.indexOf("@", 1);
  return at > 0 ? resolution.slice(at + 1) : null;
}

function manifestDependencies(
  manifestText: string | null,
  reserve: (count?: number) => boolean,
): Array<[string, string]> {
  if (!manifestText) return [];
  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    return [];
  }
  const out: Array<[string, string]> = [];
  for (const field of MANIFEST_DEPENDENCY_FIELDS) {
    const declared = ownField(manifest, field);
    if (typeof declared !== "object" || declared === null) continue;
    for (const [dep, spec] of Object.entries(declared)) {
      if (typeof spec !== "string") continue;
      if (!reserve()) return out;
      out.push([dep, spec]);
    }
  }
  return out;
}
