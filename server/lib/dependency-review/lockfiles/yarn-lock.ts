import {
  classifyNpmTarball,
  createSnapshotBuilder,
  isLocalSource,
  MANIFEST_DEPENDENCY_FIELDS,
  npmIntegrity,
  ownField,
  validLockfileVersion,
  type LockfileSnapshot,
  type SnapshotBuilder,
} from "./snapshot";
import { textLines, yamlKey } from "./lines";

interface YarnEntry {
  descriptors: string[];
  version: string | null;
  resolved: string | null;
  resolution: string | null;
  // v1 `integrity` (ssri, like npm's) and Berry `checksum` (of Yarn's own
  // repacked zip, so it pins the entry but matches no registry digest).
  integrity: string | null;
  checksum: string | null;
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
    recordPackage(builder, pkg);
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
      current = {
        descriptors,
        version: null,
        resolved: null,
        resolution: null,
        integrity: null,
        checksum: null,
        dependencies: [],
      };
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
      else if (field?.key === "integrity") current.integrity = field.value;
      else if (field?.key === "checksum") current.checksum = field.value;
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
  source:
    | { kind: "public" }
    | { kind: "registry"; location: string; ref: string }
    // `ref` identifies the fetched code: a resolved URL or commit, a Berry
    // locator, or the descriptor's own range when nothing was resolved.
    | { kind: "remote"; ref: string | null };
  // What pins the bytes: v1 integrity or Berry checksum.
  pin: string | null;
  // Mirror-comparable digests; Berry's checksum is never one.
  hashes: string[] | null;
}

// A registry entry whose version is not an exact one (a range, a tag) pins
// nothing: Yarn resolves it at install time, so it is a remote source rather
// than an entry the builder would drop.
function recordPackage(builder: SnapshotBuilder, pkg: YarnPackage): void {
  const { name, version, source, pin, hashes } = pkg;
  if (source.kind !== "remote" && version !== null && !validLockfileVersion("npm", version)) {
    builder.addRemote(name, version, null, pin);
  } else if (source.kind === "public") builder.add(name, version, { hashes, pin });
  else if (source.kind === "registry") {
    builder.add(name, version, {
      registry: { location: source.location, ref: source.ref },
      hashes,
      pin,
    });
  } else builder.addRemote(name, source.ref, version, pin);
}

// The package an entry installs, or null when its code is in the repository
// (`workspace:`, `portal:`, `link:`, `file:`, a relative path).
function yarnPackage(entry: YarnEntry): YarnPackage | null {
  if (entry.resolution !== null) {
    const pkg = berryPackage(entry.resolution, entry.version);
    return pkg && { ...pkg, pin: entry.checksum, hashes: null };
  }
  // v1: one real package across descriptors. A git, URL, or `user/repo`
  // descriptor is remote; a `resolved` URL places the rest (see
  // `classifyNpmTarball`).
  let name: string | null = null;
  let remoteRange: string | null = null;
  for (const descriptor of entry.descriptors) {
    const parsed = v1Descriptor(descriptor);
    if (parsed === null || parsed.kind === "local") return null;
    if (name !== null && parsed.name !== name) return null;
    name = parsed.name;
    if (parsed.kind === "remote") remoteRange ??= parsed.range;
  }
  if (name === null) return null;
  if (entry.resolved !== null && isLocalSource(entry.resolved)) return null;
  const { pin, hashes } = npmIntegrity(entry.integrity);
  const pkg = { name, version: entry.version, pin, hashes };
  if (remoteRange !== null) {
    return { ...pkg, source: { kind: "remote", ref: entry.resolved ?? remoteRange } };
  }
  if (entry.resolved === null) return { ...pkg, source: { kind: "public" } };
  const source = classifyNpmTarball(entry.resolved, name, entry.version);
  if (source.kind === "remote") return { ...pkg, source: { kind: "remote", ref: entry.resolved } };
  return {
    ...pkg,
    source:
      source.kind === "public"
        ? source
        : { kind: "registry", location: source.location, ref: entry.resolved },
  };
}

function v1Descriptor(
  descriptor: string,
): { name: string; range: string; kind: "registry" | "remote" | "local" } | null {
  const at = descriptor.indexOf("@", 1);
  if (at <= 0) return null;
  const name = descriptor.slice(0, at);
  const range = descriptor.slice(at + 1);
  if (range.startsWith("npm:")) {
    const target = range.slice(4);
    const targetAt = target.indexOf("@", 1);
    const real = targetAt > 0 ? target.slice(0, targetAt) : target;
    return { name: real, range, kind: "registry" };
  }
  if (isLocalSource(range) || /^[./~]/.test(range)) return { name, range, kind: "local" };
  // Semver ranges and dist-tags hold neither; `git+`, `github:`, tarball URLs
  // and `user/repo` shorthands hold one or both.
  const remote = range.includes(":") || range.includes("/");
  return { name, range, kind: remote ? "remote" : "registry" };
}

type BerrySource = Omit<YarnPackage, "pin" | "hashes">;

// Berry resolutions are `<name>@<protocol>:<reference>`. `npm:` is a registry
// package; Berry adds `::__archiveUrl=` when the tarball is not where the
// default registry keeps it, and that URL places the entry the way a v1
// `resolved` does. `patch:` wraps another locator and takes its source. Local
// protocols are skipped; any other protocol (git, http(s), and unknown ones)
// is a remote source identified by its locator. A scope routed to another
// registry in `.yarnrc.yml` leaves no trace here.
function berryPackage(
  resolution: string,
  version: string | null,
  insidePatch = false,
): BerrySource | null {
  const at = resolution.indexOf("@", 1);
  if (at <= 0) return null;
  const name = resolution.slice(0, at);
  const locator = resolution.slice(at + 1);
  if (locator.startsWith("npm:")) {
    const reference = locator.slice(4);
    const params = reference.indexOf("::");
    const npmVersion = params === -1 ? reference : reference.slice(0, params);
    if (params === -1 || !reference.includes("__archiveUrl=", params)) {
      return { name, version: npmVersion, source: { kind: "public" } };
    }
    const archiveUrl = berryArchiveUrl(reference.slice(params + 2));
    const source =
      archiveUrl === null
        ? ({ kind: "remote" } as const)
        : classifyNpmTarball(archiveUrl, name, npmVersion);
    if (source.kind === "public") return { name, version: npmVersion, source };
    if (source.kind === "registry") {
      return {
        name,
        version: npmVersion,
        source: { kind: "registry", location: source.location, ref: reference },
      };
    }
    return { name, version: npmVersion, source: { kind: "remote", ref: reference } };
  }
  if (isLocalSource(locator)) return null;
  // A patch of a patch is not unwrapped: each layer would decode the rest of a
  // possibly huge line again.
  if (!locator.startsWith("patch:") || insidePatch) {
    return { name, version, source: { kind: "remote", ref: locator } };
  }
  const hash = locator.indexOf("#");
  let inner: string;
  try {
    inner = decodeURIComponent(locator.slice(6, hash === -1 ? undefined : hash));
  } catch {
    return { name, version, source: { kind: "remote", ref: locator } };
  }
  const innerAt = inner.indexOf("@", 1);
  if (innerAt <= 0 || inner.slice(0, innerAt) !== name) {
    return { name, version, source: { kind: "remote", ref: locator } };
  }
  // The wrapped locator decides the source; the patch file is repository code.
  return berryPackage(inner, version, true);
}

// The one `__archiveUrl` binding in a locator's `key=value&…` parameters;
// null when it is missing, repeated, or not decodable.
function berryArchiveUrl(params: string): string | null {
  let found: string | null = null;
  for (const part of params.split("&")) {
    if (!part.startsWith("__archiveUrl=")) continue;
    if (found !== null) return null;
    try {
      found = decodeURIComponent(part.slice("__archiveUrl=".length));
    } catch {
      return null;
    }
  }
  return found;
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
