import {
  classifyNpmTarball,
  createSnapshotBuilder,
  isLocalSource,
  npmIntegrity,
  validLockfileVersion,
  validNpmName,
  type LockfileSnapshot,
  type SnapshotBuilder,
  type TarballSource,
} from "./snapshot";
import { readStrictYaml, type YamlValue } from "./lines";

const DEPENDENCY_SECTIONS = new Set(["dependencies", "devDependencies", "optionalDependencies"]);
// The edges a package entry installs (v9 in `snapshots`, v5/v6 in
// `packages`). Peers are resolved by the importing package's own edges, and
// its resolved peer versions are part of the key the edge names.
const ENTRY_EDGES = new Set(["dependencies", "optionalDependencies"]);
// The `packages` entry fields that say what to fetch. They are taken from
// `packages` only; a `snapshots` entry carrying one is not a shape pnpm's
// lockfile writer produces.
const SOURCE_FIELDS = new Set(["resolution", "name", "version", "id"]);
const RESOLUTION_FIELDS = new Set([
  "integrity",
  "tarball",
  "type",
  "directory",
  "repo",
  "commit",
  "path",
]);

// pnpm-lock.yaml v5 through v9, read with the strict YAML reader (see
// `readStrictYaml`). Installed packages are the keys of `packages` (v9's
// `snapshots` repeat them, and each must have one); direct dependencies are
// the `importers` sections, or the top-level sections of a single-project v5
// lockfile. Every document of a multi-document lockfile (pnpm's own
// `packageManagerDependencies` come first) is read.
export function parsePnpmLock(text: string): LockfileSnapshot {
  const builder = createSnapshotBuilder("npm");
  builder.expectStrongPins();
  // Every `packages` entry, by the release its key names: the peer variants
  // of one release (v6+ `(peer@x)`, v5 `_peer@x` suffixes) each have one.
  // Keys themselves are never repeated; the reader refuses a duplicate key.
  const entries = new Map<string, PnpmEntry[]>();
  const packageIds = new Set<string>();
  const snapshotIds = new Set<string>();
  // Full `packages` and `snapshots` keys, peer suffixes included, and every
  // install edge as `[from, dep, value]`.
  const keys = new Set<string>();
  const edges: Array<[string, string, string]> = [];
  // The keys on the path to the current entry, by depth.
  const path: string[] = [];
  let pkg: PnpmEntry | null = null;
  let valid = true;
  const fail = () => {
    valid = false;
    return false;
  };

  const readable = readStrictYaml(text, (entry) => {
    if (entry === null) {
      path.length = 0;
      pkg = null;
      return;
    }
    const { depth, key, value } = entry;
    path.length = depth;
    path.push(key ?? "");
    const section = path[0];
    if (section === "packages" || section === "snapshots") {
      if (depth === 1) {
        pkg = null;
        if (key === null) return fail();
        const id = before(key, "(");
        if (!builder.reserve()) return false;
        keys.add(key);
        if (section === "snapshots") {
          snapshotIds.add(id);
          return;
        }
        const parsed = pnpmPackageKey(id);
        if (!parsed) return fail();
        packageIds.add(id);
        pkg = { ...parsed, fields: new Map(), resolution: null };
        const release = JSON.stringify([parsed.host, parsed.name, parsed.ref]);
        const variants = entries.get(release);
        if (variants) variants.push(pkg);
        else entries.set(release, [pkg]);
        return;
      }
      if (depth === 2 && key !== null && SOURCE_FIELDS.has(key)) {
        if (section === "snapshots" || !pkg) return fail();
        if (key === "resolution") {
          if (value.kind === "map") pkg.resolution = new Map(value.fields);
          else if (value.kind === "block") pkg.resolution = new Map();
          else return fail();
        } else if (value.kind === "scalar") pkg.fields.set(key, value.text);
        else return fail();
        return;
      }
      if (depth === 3 && path[2] === "resolution" && section === "packages" && pkg?.resolution) {
        if (key === null || value.kind !== "scalar") return fail();
        pkg.resolution.set(key, value.text);
      }
      if (depth === 3 && ENTRY_EDGES.has(path[2]) && key !== null) {
        if (value.kind !== "scalar") return fail();
        if (!builder.reserve()) return false;
        edges.push([path[1], key, value.text]);
      }
      return;
    }
    // Every document's importers: pnpm's own `packageManagerDependencies`
    // document lists only `.`, the workspace's lists every project.
    if (section === "importers" && depth === 1 && key !== null) builder.addWorkspace(key);
    const declared = importerDeclaration(path, depth, key, value);
    if (declared) {
      builder.markDirect(importerPackageName(declared[0], declared[1]));
      if (!builder.reserve()) return false;
      edges.push([path[0] === "importers" ? path[1] : "", declared[0], declared[1]]);
    }
  });
  if (!readable || !valid) {
    builder.markIncomplete();
    return builder.finish();
  }
  for (const id of snapshotIds) if (!packageIds.has(id)) builder.markIncomplete();
  for (const [from, dep, value] of edges) {
    if (!resolvesToKey(keys, dep, value)) builder.unresolvedEdge(from, dep, value);
  }
  for (const [first, ...others] of entries.values()) {
    // Peer variants install one release; one fetched from a different source
    // or pin is not a shape pnpm's lockfile writer produces.
    const source = sourceOf(first);
    if (others.some((other) => sourceOf(other) !== source)) builder.markIncomplete();
    else recordEntry(builder, first);
  }
  return builder.finish();
}

/**
 * Whether an install edge names an entry of the lockfile, the way the
 * installer reads the value: a version (with any peer suffix) under the
 * dependency's own name, or an alias, host-qualified, or remote reference
 * that is itself the key, in the v9 (`name@1.0.0`), v6 (`/name@1.0.0`), and
 * v5 (`/name/1.0.0`) key forms. One that names nothing is resolved at
 * install time, so the lockfile is not the whole install. A `link:` or `file:` value is
 * repository code.
 */
function resolvesToKey(keys: ReadonlySet<string>, dep: string, value: string): boolean {
  if (isLocalSource(value)) return true;
  return [`${dep}@${value}`, value, `/${dep}@${value}`, `/${dep}/${value}`, `/${value}`].some(
    (key) => keys.has(key),
  );
}

// `[dep, resolved]` for an importer's dependency line: v9/v6 importers
// (`importers.<dir>.<section>.<dep>.version`), v5 importers
// (`importers.<dir>.<section>.<dep>: <version>`), and a single-project
// lockfile's top-level sections in either form.
function importerDeclaration(
  path: readonly string[],
  depth: number,
  key: string | null,
  value: YamlValue,
): [string, string] | null {
  const offset = path[0] === "importers" ? 2 : 0;
  if (depth < offset + 1 || !DEPENDENCY_SECTIONS.has(path[offset])) return null;
  const dep = path[offset + 1];
  if (value.kind !== "scalar" || !dep) return null;
  if (depth === offset + 1 && key === dep) return [dep, value.text];
  if (depth === offset + 2 && key === "version") return [dep, value.text];
  return null;
}

interface PnpmEntry {
  name: string;
  // What follows the name in the key: a version, or a URL / git reference.
  ref: string;
  // A v5/v6 key with another registry's hostname in place of the leading `/`.
  host: string | null;
  // `name:` / `version:` / `id:` fields, which git and tarball entries carry.
  fields: Map<string, string>;
  // Null when the entry has none, so nothing says what to fetch.
  resolution: Map<string, string> | null;
}

// What decides where an entry is fetched from and what it must hash to.
function sourceOf(entry: PnpmEntry): string {
  const sorted = (map: ReadonlyMap<string, string> | null) =>
    map === null ? null : [...map].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify([sorted(entry.fields), sorted(entry.resolution)]);
}

// Directory resolutions are repository code and are skipped. Git resolutions
// and off-registry tarballs are remote sources identified by commit or URL.
// The installer fetches a registry entry by the `name:` / `version:` fields
// when they are present and by its key otherwise, so a registry entry whose
// fields name something other than its key is not that key's release: it is
// remote.
function recordEntry(builder: SnapshotBuilder, entry: PnpmEntry): void {
  const name = entry.fields.get("name") ?? entry.name;
  const version = entry.fields.get("version") ?? entry.ref;
  const res = entry.resolution;
  if (!res || [...res.keys()].some((key) => !RESOLUTION_FIELDS.has(key))) {
    builder.markIncomplete();
    return;
  }
  const type = res.get("type");
  if (type !== undefined && type !== "git" && type !== "directory") {
    builder.markIncomplete();
    return;
  }
  if (type === "directory" || res.has("directory") || isLocalSource(entry.ref)) return;
  const { pin, hashes } = npmIntegrity(res.get("integrity"));
  if (type === "git" || res.has("repo") || res.has("commit")) {
    const repo = res.get("repo");
    const commit = res.get("commit");
    builder.addRemote(
      name,
      repo && commit ? `${repo}#${commit}` : (commit ?? repo ?? entry.ref),
      version,
    );
    return;
  }
  const tarball = res.get("tarball");
  if (tarball !== undefined && isLocalSource(tarball)) return;
  const keyed =
    validLockfileVersion("npm", entry.ref) && name === entry.name && version === entry.ref;
  if (tarball !== undefined) {
    const source: TarballSource = keyed
      ? classifyNpmTarball(tarball, name, version)
      : { kind: "remote", location: null };
    if (source.kind === "public") builder.add(name, version, { hashes, pin, publicUrl: true });
    else if (source.kind === "registry") {
      builder.add(name, version, {
        registry: { location: source.location, ref: tarball },
        hashes,
        pin,
      });
    } else builder.addRemote(name, tarball, version, pin, source.location);
  } else if (entry.host !== null) {
    // A v5/v6 key with another registry's hostname names only that host, not
    // a URL a declared registry or mirror prefix could be matched against.
    // It is remote: never placed by the repository's routing, never looked up
    // on the public registry.
    builder.addRemote(name, `${entry.host}/${entry.name}/${entry.ref}`, version, pin);
  } else if (keyed) builder.add(name, version, { hashes, pin });
  // Neither a version nor a local path: a URL or git reference in the key, or
  // fields that disagree with it.
  else builder.addRemote(name, entry.ref, version, pin);
}

// `/name/1.2.3` and `/name/1.2.3_peer@x` (v5), `/name@1.2.3` (v6), `name@1.2.3`
// (v9), `name@https://...` or `name@git+...` (v9 remote sources). A v5/v6
// package from a non-default registry has that registry's hostname in place
// of the leading slash. Peer suffixes in parentheses are already cut.
function pnpmPackageKey(key: string): { name: string; ref: string; host: string | null } | null {
  const { body, host } = registryHost(key);
  const at = body.indexOf("@", 1);
  if (at > 0) {
    const name = body.slice(0, at);
    // The v5 form puts a peer's `@` after an underscore, which leaves a slash
    // in the "name" and fails the name check.
    if (validNpmName(name)) return { name, ref: body.slice(at + 1), host };
  }
  if (host === null && !key.startsWith("/")) return null;
  const slash = body.lastIndexOf("/");
  if (slash <= 0) return null;
  // A v5/v6 git key (`github.com/org/repo/<sha>`) yields an invalid name here;
  // its entry's `name:` field supplies the real one.
  return { name: body.slice(0, slash), ref: before(body.slice(slash + 1), "_"), host };
}

// Default-registry keys start with `/` (v5/v6) or with the name (v9); neither
// has a dotted first path segment before a slash, which is a hostname.
function registryHost(key: string): { body: string; host: string | null } {
  if (key.startsWith("/")) return { body: key.slice(1), host: null };
  const slash = key.indexOf("/");
  const first = key.slice(0, slash);
  if (slash > 0 && /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(first)) {
    return { body: key.slice(slash + 1), host: first };
  }
  return { body: key, host: null };
}

// An importer's resolved value: `1.2.3`, `1.2.3(peer@x)`, `1.2.3_peer@x`
// (v5), an alias `real@1.2.3` / `/real@1.2.3` / `/real/1.2.3_peer@x`, a
// remote reference, or a link/file reference to repository code. Only the
// name is used: it marks which installed package the importer declares.
function importerPackageName(dep: string, value: string): string | null {
  let v = before(value, "(");
  if (isLocalSource(v)) return null;
  if (v.includes("://") || /^(?:git|github|gitlab|bitbucket)[+:]/.test(v)) return dep;
  v = registryHost(v).body;
  if (/^\d+\.\d+\.\d+/.test(v)) return dep;
  const at = v.lastIndexOf("@");
  if (at > 0 && validNpmName(v.slice(0, at))) return v.slice(0, at);
  const slash = v.lastIndexOf("/");
  const name = slash > 0 ? v.slice(0, slash) : null;
  return name !== null && validNpmName(name) ? name : dep;
}

// Plain `indexOf` cuts: a `/\(.*$/` replace backtracks quadratically on a long
// line of `(` that ends in a character `.` does not match.
function before(value: string, marker: string): string {
  const at = value.indexOf(marker);
  return at === -1 ? value : value.slice(0, at);
}
