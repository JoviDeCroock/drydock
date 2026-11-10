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
import { readStrictYaml, textLines } from "./lines";

interface YarnEntry {
  descriptors: string[];
  fields: Map<string, string>;
  // Berry workspace entries list each workspace's own dependencies.
  dependencies: Array<[string, string]>;
}

// v1 entry fields, and Berry's. A field of the other dialect, or any other
// field, is not a shape Yarn writes.
const V1_FIELDS = new Set(["version", "resolved", "integrity", "uid"]);
const V1_LISTS = new Set(["dependencies", "optionalDependencies"]);
const BERRY_FIELDS = new Set([
  "version",
  "resolution",
  "checksum",
  "languageName",
  "linkType",
  "conditions",
]);
const BERRY_MAPS = new Set(["dependencies", "peerDependencies", "bin"]);
const BERRY_META = new Set(["dependenciesMeta", "peerDependenciesMeta"]);
const V1_HEADER = "# yarn lockfile v1";

// yarn.lock, v1 and Berry. The dialect is the file's own: v1 carries Yarn's
// `# yarn lockfile v1` header, Berry is YAML with a `__metadata` entry, and a
// file that is both or neither is unreadable. Every entry is an installed
// package. Direct dependencies come from the package.json beside the lockfile
// and, in Berry, from each `workspace:` entry's dependency list.
export function parseYarnLock(text: string, manifestText: string | null): LockfileSnapshot {
  const builder = createSnapshotBuilder("npm");
  const v1 = hasV1Header(text);
  const entries = v1
    ? readV1Entries(text, builder.reserve)
    : readBerryEntries(text, builder.reserve);
  if (entries === null) {
    builder.markIncomplete();
    return builder.finish();
  }
  const byDescriptor = new Map<string, string>();
  for (const entry of entries) {
    const pkg = v1 ? v1Package(entry) : berryEntryPackage(entry);
    if (pkg === "invalid") {
      builder.markIncomplete();
      continue;
    }
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
  if (!v1) {
    for (const entry of entries) {
      if (!protocolOf(entry.fields.get("resolution") ?? "")?.startsWith("workspace:")) continue;
      for (const [dep, spec] of entry.dependencies) declare(dep, spec);
    }
  }
  return builder.finish();
}

// Yarn v1 writes its header as the second comment line, after a first one.
function hasV1Header(text: string): boolean {
  let lines = 0;
  for (const line of textLines(text)) {
    if (!line.startsWith("#")) return false;
    if (line.trimEnd() === V1_HEADER) return true;
    if (++lines >= 4) return false;
  }
  return false;
}

/**
 * Yarn v1's own format, in the shapes its writer produces: comment lines, then
 * entries of a header line (descriptors, each a bare token or a JSON string,
 * joined by `, `), two-space `key value` fields, and `dependencies:` /
 * `optionalDependencies:` blocks of four-space `name range` lines. Tokens are
 * bare words the way Yarn leaves them unquoted, or double-quoted strings with
 * no escapes. Anything else (other indentation, a quoted field name, an inline
 * comment, a repeated field or descriptor, an unknown field) is null: the
 * file is unreadable.
 */
function readV1Entries(text: string, reserve: (count?: number) => boolean): YarnEntry[] | null {
  const entries: YarnEntry[] = [];
  const descriptors = new Set<string>();
  let current: YarnEntry | null = null;
  let list: Map<string, string> | null = null;
  let lists = new Set<string>();
  for (const raw of textLines(text)) {
    if (!plainLine(raw)) return null;
    if (!raw) continue;
    if (raw.startsWith("#")) {
      if (current) return null;
      continue;
    }
    if (raw.endsWith(" ")) return null;
    if (!raw.startsWith(" ")) {
      if (!raw.endsWith(":")) return null;
      const parsed = v1Tokens(raw.slice(0, -1), ", ");
      if (!parsed || parsed.length === 0) return null;
      if (!reserve(parsed.length + 1)) return entries;
      for (const descriptor of parsed) {
        if (descriptors.has(descriptor)) return null;
        descriptors.add(descriptor);
      }
      current = { descriptors: parsed, fields: new Map(), dependencies: [] };
      entries.push(current);
      list = null;
      lists = new Set();
      continue;
    }
    if (!current) return null;
    if (raw.startsWith("    ")) {
      if (!list || raw[4] === " ") return null;
      const pair = v1Tokens(raw.slice(4), " ");
      if (!pair || pair.length !== 2 || list.has(pair[0])) return null;
      if (!reserve()) return entries;
      list.set(pair[0], pair[1]);
      continue;
    }
    if (!raw.startsWith("  ") || raw[2] === " " || raw[2] === '"') return null;
    const line = raw.slice(2);
    if (line.endsWith(":")) {
      const name = line.slice(0, -1);
      if (!V1_LISTS.has(name) || lists.has(name)) return null;
      lists.add(name);
      list = new Map();
      continue;
    }
    list = null;
    const pair = v1Tokens(line, " ");
    if (!pair || pair.length !== 2 || !V1_FIELDS.has(pair[0]) || current.fields.has(pair[0])) {
      return null;
    }
    current.fields.set(pair[0], pair[1]);
  }
  return entries;
}

// Yarn v1 leaves a string bare when it starts with a letter and holds none of
// `:`, whitespace, `\`, `"`, `,`, `[`, `]` (and is not `true…`/`false…`, which
// its reader takes as booleans); anything else it writes as a JSON string.
const V1_BARE = /^[a-zA-Z][^:\s\\",[\]]*$/;

function v1Tokens(text: string, separator: string): string[] | null {
  const tokens: string[] = [];
  let i = 0;
  while (i < text.length) {
    let token: string;
    if (text[i] === '"') {
      const close = text.indexOf('"', i + 1);
      if (close === -1) return null;
      token = text.slice(i + 1, close);
      if (token.includes("\\")) return null;
      i = close + 1;
    } else {
      let end = text.indexOf(separator, i);
      if (end === -1) end = text.length;
      token = text.slice(i, end);
      if (!V1_BARE.test(token) || token.startsWith("true") || token.startsWith("false")) {
        return null;
      }
      i = end;
    }
    tokens.push(token);
    if (i === text.length) break;
    if (!text.startsWith(separator, i)) return null;
    i += separator.length;
    if (i === text.length) return null;
  }
  return tokens;
}

function plainLine(line: string): boolean {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c < 0x20 || c === 0x7f || c === 0x85 || c === 0x2028 || c === 0x2029 || c === 0xfeff) {
      return false;
    }
  }
  return true;
}

/**
 * Berry's yarn.lock through the strict YAML reader: a `__metadata` entry, then
 * entries whose fields are Berry's own. Null when the YAML is outside the
 * subset, an entry holds anything else, or `__metadata` is missing.
 */
function readBerryEntries(text: string, reserve: (count?: number) => boolean): YarnEntry[] | null {
  const entries: YarnEntry[] = [];
  const descriptors = new Set<string>();
  let current: YarnEntry | null = null;
  let metadata = false;
  let inMetadata = false;
  let field: string | null = null;
  let valid = true;
  const fail = () => {
    valid = false;
    return false;
  };
  const readable = readStrictYaml(text, (entry) => {
    if (entry === null) return fail();
    const { depth, key, value } = entry;
    if (key === null) return fail();
    if (depth === 0) {
      current = null;
      field = null;
      inMetadata = key === "__metadata";
      if (inMetadata) {
        if (metadata || value.kind !== "block") return fail();
        metadata = true;
        return;
      }
      if (value.kind !== "block") return fail();
      const parsed = key.split(", ");
      if (parsed.some((d) => !d)) return fail();
      if (!reserve(parsed.length + 1)) return false;
      for (const descriptor of parsed) {
        if (descriptors.has(descriptor)) return fail();
        descriptors.add(descriptor);
      }
      current = { descriptors: parsed, fields: new Map(), dependencies: [] };
      entries.push(current);
      return;
    }
    if (inMetadata) {
      if (depth !== 1 || value.kind !== "scalar") return fail();
      return;
    }
    if (!current) return fail();
    if (depth === 1) {
      field = key;
      if (BERRY_FIELDS.has(key)) {
        if (value.kind !== "scalar") return fail();
        current.fields.set(key, value.text);
      } else if (!BERRY_MAPS.has(key) && !BERRY_META.has(key)) return fail();
      else if (value.kind !== "block") return fail();
      return;
    }
    if (depth === 2 && field !== null && BERRY_MAPS.has(field)) {
      if (value.kind !== "scalar") return fail();
      if (field === "dependencies") {
        if (!reserve()) return false;
        current.dependencies.push([key, value.text]);
      }
      return;
    }
    if (field !== null && BERRY_META.has(field)) {
      if (depth === 2 ? value.kind !== "block" : depth !== 3 || value.kind !== "scalar") {
        return fail();
      }
      return;
    }
    return fail();
  });
  if (!readable || !valid) return null;
  if (!metadata && entries.length > 0) return null;
  return entries;
}

interface YarnPackage {
  name: string;
  version: string | null;
  source:
    | { kind: "public" }
    | { kind: "registry"; location: string; ref: string }
    // `ref` identifies the fetched code: a resolved URL or commit, a Berry
    // locator, or the descriptor's own range when nothing was resolved;
    // `location` is a tarball's plain http(s) URL.
    | { kind: "remote"; ref: string | null; location?: string | null };
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
  } else builder.addRemote(name, source.ref, version, pin, source.location ?? null);
}

// The package a v1 entry installs, null when its code is in the repository
// (`file:`, `link:`, a relative path), or "invalid" when it is not one
// package this layer can place. A git, URL, or `user/repo` descriptor is
// remote; a `resolved` URL places the rest (see `classifyNpmTarball`).
function v1Package(entry: YarnEntry): YarnPackage | "invalid" | null {
  let name: string | null = null;
  let remoteRange: string | null = null;
  let local = 0;
  for (const descriptor of entry.descriptors) {
    const parsed = v1Descriptor(descriptor);
    if (parsed === null || (name !== null && parsed.name !== name)) return "invalid";
    name = parsed.name;
    if (parsed.kind === "local") local++;
    if (parsed.kind === "remote") remoteRange ??= parsed.range;
  }
  if (name === null) return "invalid";
  if (local > 0) return local === entry.descriptors.length ? null : "invalid";
  const version = entry.fields.get("version") ?? null;
  const resolved = entry.fields.get("resolved") ?? null;
  if (resolved !== null && isLocalSource(resolved)) return "invalid";
  if (version === null) return "invalid";
  const { pin, hashes } = npmIntegrity(entry.fields.get("integrity"));
  const pkg = { name, version, pin, hashes };
  if (remoteRange !== null) {
    return { ...pkg, source: { kind: "remote", ref: resolved ?? remoteRange } };
  }
  if (resolved === null) return { ...pkg, source: { kind: "public" } };
  const source = classifyNpmTarball(resolved, name, version);
  if (source.kind === "remote") {
    return { ...pkg, source: { kind: "remote", ref: resolved, location: source.location } };
  }
  return {
    ...pkg,
    source:
      source.kind === "public"
        ? source
        : { kind: "registry", location: source.location, ref: resolved },
  };
}

// A Berry entry's package, from its `resolution` locator.
function berryEntryPackage(entry: YarnEntry): YarnPackage | "invalid" | null {
  const resolution = entry.fields.get("resolution");
  if (resolution === undefined) return "invalid";
  const pkg = berryPackage(resolution, entry.fields.get("version") ?? null);
  if (pkg === null || pkg === "invalid") return pkg;
  // The checksum is of Yarn's repacked archive: it pins the entry but matches
  // no registry digest.
  return { ...pkg, pin: entry.fields.get("checksum") ?? null, hashes: null };
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
  // A path: `./x`, `../x`, `/x`, `~/x`. A bare `~1.2.3` is a semver range.
  if (isLocalSource(range) || /^(?:\.\.?(?:\/|$)|\/|~\/)/.test(range)) {
    return { name, range, kind: "local" };
  }
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
): BerrySource | "invalid" | null {
  const at = resolution.indexOf("@", 1);
  if (at <= 0) return "invalid";
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
        ? ({ kind: "remote", location: null } as const)
        : classifyNpmTarball(archiveUrl, name, npmVersion);
    if (source.kind === "public") return { name, version: npmVersion, source };
    if (source.kind === "registry") {
      return {
        name,
        version: npmVersion,
        source: { kind: "registry", location: source.location, ref: reference },
      };
    }
    return {
      name,
      version: npmVersion,
      source: { kind: "remote", ref: reference, location: source.location },
    };
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
