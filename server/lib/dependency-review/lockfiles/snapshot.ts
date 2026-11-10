import { createHash } from "node:crypto";
import type { DependencyEcosystem } from "../types";

type LockfileSourceKind = "public" | "registry" | "remote";

/**
 * Where one recorded version of a package came from. `registry` is a registry
 * other than the public one, with the entry shaped as that registry's copy of
 * its own name and version; `remote` is a git ref, a tarball URL, or anything
 * this layer cannot place, and has no registry publish time.
 */
export interface LockfileSource {
  kind: LockfileSourceKind;
  // The release the entry names, for public and registry sources.
  version: string | null;
  // For registry sources: the tarball URL (npm formats) or index URL (uv) the
  // lockfile records, or null when it records none. For a remote tarball: its
  // URL, when it is a plain http(s) URL.
  location: string | null;
  // uv: the file URLs the lock records, which are where the bytes come from.
  urls: readonly string[];
  // Pins a public-registry comparison can check: npm's `sha512-…` integrity
  // components (only when nothing stronger or unknown is beside them), uv's
  // and hashed requirements' `sha256:…` file hashes. The union over every
  // copy recorded under this identity; null when any copy has none usable.
  hashes: readonly string[] | null;
  // What each copy pins, as compared across the PR: the usable hashes when
  // there are any, else the pin as written, else "". Sorted and distinct. A
  // public identity whose pins change is a re-pin of the same version.
  pins: readonly string[];
  // Several entries recorded this identity and disagreed about where it came
  // from; the worst kind wins and it is never compared as a mirror copy.
  mixed: boolean;
}

export interface LockfilePackage {
  ecosystem: DependencyEcosystem;
  name: string;
  // Each recorded identity: the version for a public source; for anything
  // else the resolved reference (URL, commit, locator) or the version plus
  // what pins it, so that neither a re-pin nor a move off the public registry
  // keeps an identity the other side also has.
  versions: ReadonlySet<string>;
  sources: ReadonlyMap<string, LockfileSource>;
  // Some importer or manifest the lockfile covers declares this name.
  direct: boolean;
}

export interface LockfileSnapshot {
  // Keyed by `${ecosystem}:${name}`; neither ecosystem's names can hold a colon.
  packages: ReadonlyMap<string, LockfilePackage>;
  // False when the text was oversized, unreadable, or hit the entry cap. An
  // incomplete snapshot cannot show that a version is absent, so it is never
  // diffed: a missing base entry would turn a reviewable bump into an
  // unreviewed "new package".
  complete: boolean;
  // requirements files only: every requirement line that is not an exact `==`
  // pin (ranges, URLs, VCS and editable lines, includes), normalized and
  // sorted. A change here moves versions the snapshot cannot name.
  unpinned: readonly string[];
}

// Lockfile text is repository data. Above this it is not parsed at all.
export const MAX_LOCKFILE_CHARS = 8 * 1024 * 1024;
const MAX_SNAPSHOT_ENTRIES = 20_000;
// Real lockfiles hold a handful of copies of one package. The cap keeps the
// per-package pairing, which is quadratic in versions, cheap on hostile input.
const MAX_VERSIONS_PER_PACKAGE = 256;
// Parsers hold intermediate records (entries, descriptors, dependency lists)
// before they become snapshot entries; this bounds them on hostile input.
const MAX_PARSED_RECORDS = 200_000;

const NPM_NAME = /^(?:@[A-Za-z0-9~-][A-Za-z0-9._~-]*\/)?[A-Za-z0-9~-][A-Za-z0-9._~-]*$/;
// npm itself refuses these as package names.
const NPM_RESERVED_NAMES = new Set(["node_modules", "favicon.ico"]);
const PYPI_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const MAX_NAME_LENGTH = 214;

const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+!-]{0,127}$/;
const SEMVER_IDENTIFIER = "(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)";
const STRICT_SEMVER = new RegExp(
  "^(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)" +
    `(?:-${SEMVER_IDENTIFIER}(?:\\.${SEMVER_IDENTIFIER})*)?` +
    "(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$",
);

export function validNpmName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= MAX_NAME_LENGTH &&
    !NPM_RESERVED_NAMES.has(name.toLowerCase()) &&
    NPM_NAME.test(name)
  );
}

// PEP 503 normalization, so `Django`, `django`, and `dj_ango`-style spellings
// of one project share a key.
function normalizePyPiName(name: string): string | null {
  if (name.length === 0 || name.length > MAX_NAME_LENGTH || !PYPI_NAME.test(name)) return null;
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

const VALID_VERSION: Record<DependencyEcosystem, (version: string) => boolean> = {
  // VERSION first: it bounds the length before the longer semver pattern runs.
  npm: (version) => VERSION.test(version) && STRICT_SEMVER.test(version),
  pypi: (version) => VERSION.test(version),
};

export function validLockfileVersion(ecosystem: DependencyEcosystem, version: string): boolean {
  return VALID_VERSION[ecosystem](version);
}

const CANONICAL_NAME: Record<DependencyEcosystem, (name: string) => string | null> = {
  npm: (name) => (validNpmName(name) ? name : null),
  pypi: normalizePyPiName,
};

interface RegistryEntry {
  // Resolved from a registry other than the public one (see `LockfileSource`).
  registry?: {
    location: string | null;
    // What identifies the entry, when the lockfile records a per-version
    // reference (a tarball URL, a Berry locator); otherwise the version does.
    ref: string | null;
    urls?: readonly string[];
  };
  hashes?: readonly string[] | null;
  // What the lockfile pins the bytes with (integrity, checksum, hash summary).
  // Part of a non-public identity, so a re-pin of the same reference differs;
  // compared beside a public one (see `LockfileSource.pins`).
  pin?: string | null;
}

export interface SnapshotBuilder {
  // Records one registry version. An invalid name or version is an entry
  // this layer cannot place, so it makes the snapshot incomplete.
  add(name: unknown, version: unknown, entry?: RegistryEntry): void;
  // Records a version from a non-registry remote source, identified by its
  // resolved reference (and pin), or by `version` when there is none.
  // `location` is the tarball URL, for a plain http(s) one.
  addRemote(
    name: unknown,
    ref: unknown,
    version: unknown,
    pin?: string | null,
    location?: string | null,
  ): void;
  markDirect(name: unknown): void;
  markIncomplete(): void;
  // Claims room for `count` intermediate records; false (and incomplete) once
  // the parse budget is spent, after which the parser stops.
  reserve(count?: number): boolean;
  finish(unpinned?: readonly string[]): LockfileSnapshot;
}

interface MutablePackage {
  ecosystem: DependencyEcosystem;
  name: string;
  sources: Map<string, LockfileSource>;
}

const KIND_RANK: Record<LockfileSourceKind, number> = { public: 0, registry: 1, remote: 2 };

function union(a: readonly string[], b: readonly string[]): string[] {
  return [...new Set([...a, ...b])].sort();
}

// Two copies recorded under one identity. Copies from the same place merge
// their pins and hashes (every hash must then match); copies that disagree
// about the place are `mixed`, keep the worst kind, and offer no hashes.
function mergeSources(a: LockfileSource, b: LockfileSource): LockfileSource {
  const pins = union(a.pins, b.pins);
  const urls = union(a.urls, b.urls);
  if (a.kind === b.kind && a.version === b.version && a.location === b.location) {
    const hashes = a.hashes && b.hashes ? union(a.hashes, b.hashes) : null;
    return { ...a, urls, pins, hashes, mixed: a.mixed || b.mixed };
  }
  const worst = KIND_RANK[b.kind] > KIND_RANK[a.kind] ? b : a;
  return { ...worst, urls, pins, hashes: null, mixed: true };
}

function pinKey(hashes: readonly string[] | null, pin: string | null): string {
  return hashes ? hashes.join(" ") : (pin ?? "");
}

export function createSnapshotBuilder(ecosystem: DependencyEcosystem): SnapshotBuilder {
  const packages = new Map<string, MutablePackage>();
  const direct = new Set<string>();
  let entries = 0;
  let records = 0;
  let complete = true;
  const canonical = (name: unknown) =>
    typeof name === "string" ? CANONICAL_NAME[ecosystem](name) : null;
  const validVersion = (version: unknown): version is string =>
    typeof version === "string" && VALID_VERSION[ecosystem](version);
  const record = (key: string, identity: string, source: LockfileSource) => {
    const existing = packages.get(key);
    const recorded = existing?.sources.get(identity);
    if (recorded) {
      existing!.sources.set(identity, mergeSources(recorded, source));
      return;
    }
    if (
      entries >= MAX_SNAPSHOT_ENTRIES ||
      (existing?.sources.size ?? 0) >= MAX_VERSIONS_PER_PACKAGE
    ) {
      complete = false;
      return;
    }
    entries++;
    if (existing) existing.sources.set(identity, source);
    else packages.set(key, { ecosystem, name: key, sources: new Map([[identity, source]]) });
  };
  return {
    add(name, version, entry = {}) {
      const key = canonical(name);
      if (key === null || !validVersion(version)) {
        complete = false;
        return;
      }
      const hashes = entry.hashes?.length ? [...new Set(entry.hashes)].sort() : null;
      const pin = typeof entry.pin === "string" && entry.pin ? entry.pin : null;
      const base = { version, hashes, pins: [pinKey(hashes, pin)], mixed: false };
      if (!entry.registry) {
        record(key, version, { ...base, kind: "public", location: null, urls: [] });
        return;
      }
      const { location, ref } = entry.registry;
      const urls = [...new Set(entry.registry.urls ?? [])].sort();
      // Always parenthesized or a URL, so never equal to a public identity.
      const identity = ref
        ? boundedRef(pin ? `${ref} (${pin})` : ref)
        : boundedRef(`${version} (${pin ?? location ?? "private registry"})`);
      record(key, identity, { ...base, kind: "registry", location, urls });
    },
    addRemote(name, ref, version, pin, location = null) {
      const key = canonical(name);
      const reference = typeof ref === "string" ? ref.trim() : "";
      // With no reference the version stands in. Either way, an identity that
      // reads as a version is marked, so it never equals the public identity
      // of that version (on this side or the other) and vanishes from the diff.
      const base = reference || (validVersion(version) ? version : "");
      if (key === null || !base) {
        complete = false;
        return;
      }
      const marked = pin || (validVersion(base) ? "unknown source" : "");
      record(key, boundedRef(marked ? `${base} (${marked})` : base), {
        kind: "remote",
        version: null,
        location,
        urls: [],
        hashes: null,
        pins: [pin ?? ""],
        mixed: false,
      });
    },
    markDirect(name) {
      const key = canonical(name);
      if (key !== null && direct.size < MAX_SNAPSHOT_ENTRIES) direct.add(key);
    },
    markIncomplete() {
      complete = false;
    },
    reserve(count = 1) {
      records += count;
      if (records <= MAX_PARSED_RECORDS) return true;
      complete = false;
      return false;
    },
    finish(unpinned = []) {
      const out = new Map<string, LockfilePackage>();
      for (const [key, pkg] of packages) {
        out.set(`${ecosystem}:${key}`, {
          ecosystem: pkg.ecosystem,
          name: pkg.name,
          versions: new Set(pkg.sources.keys()),
          sources: pkg.sources,
          direct: direct.has(key),
        });
      }
      return { packages: out, complete, unpinned };
    },
  };
}

export function incompleteSnapshot(): LockfileSnapshot {
  return { packages: new Map(), complete: false, unpinned: [] };
}

const MAX_REF_LENGTH = 200;
const REF_DIGEST_CHARS = 32;

// Refs are untrusted text; renderers escape them, this bounds them. Both ends
// are kept because that is where a commit fragment, a versioned file name, or
// a pin changes, and a digest of the whole ref stands in for the middle: two
// long refs that differ only there must not share an identity, or a changed
// source would read as unchanged (and inherit the old one's approval).
function boundedRef(ref: string): string {
  const trimmed = ref.trim();
  if (trimmed.length <= MAX_REF_LENGTH) return trimmed;
  // JSON spelling, so lone surrogates hash apart instead of as U+FFFD.
  const digest = createHash("sha256")
    .update(JSON.stringify(trimmed))
    .digest("hex")
    .slice(0, REF_DIGEST_CHARS);
  const room = MAX_REF_LENGTH - REF_DIGEST_CHARS - 2;
  return `${trimmed.slice(0, Math.ceil(room / 2))}\u2026${digest}\u2026${trimmed.slice(-Math.floor(room / 2))}`;
}

// Own-property read: lockfile JSON can carry `__proto__` or `constructor` keys,
// and a prototype hit must read as absent rather than as an inherited value.
export function ownField(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined;
}

// Protocols whose code lives in the repository itself (or, for `exec:`, is
// generated by a script in it). They are reviewed as part of the PR's own diff.
const LOCAL_PROTOCOL = /^(?:file|link|workspace|portal|exec):/i;

export function isLocalSource(ref: unknown): boolean {
  return typeof ref === "string" && LOCAL_PROTOCOL.test(ref);
}

const PUBLIC_NPM_HOSTS = ["registry.npmjs.org", "registry.yarnpkg.com"];
// Yarn classic appends the tarball's sha1 as a fragment; it is not sent.
const YARN_FRAGMENT = /^[0-9a-f]{40}$/;

export type TarballSource =
  | { kind: "public" }
  | { kind: "registry"; location: string }
  // `location`: the URL, when it is a plain http(s) URL a registry prefix can
  // be matched against.
  | { kind: "remote"; location: string | null };

// `<name>/-/<unscoped>-<version>.tgz`, the path a registry serves a version's
// tarball at, with the scope's slash literal or percent-encoded.
export function npmRegistryTarballPaths(name: string, version: string): string[] {
  const slash = name.indexOf("/");
  const file = `/-/${name.slice(slash + 1)}-${version}.tgz`;
  if (slash === -1) return [`${name}${file}`];
  const [scope, bare] = [name.slice(0, slash), name.slice(slash + 1)];
  return [`${name}${file}`, `${scope}%2f${bare}${file}`, `${scope}%2F${bare}${file}`];
}

/**
 * Where an npm-format tarball URL (npm or Yarn `resolved`, pnpm
 * `resolution.tarball`, a Berry archive URL) places the entry it is recorded
 * for. npm installs the bytes at the URL under the entry's name, so the URL
 * vouches for that name and version only when it is the public registry's
 * canonical tarball for exactly them; the comparison is on the exact text, so
 * case, dot segments, encodings, queries, and trailing junk all fail it. A URL
 * on another host shaped as a registry's copy of the same name and version is
 * a registry copy, which only the organization's declared registries and
 * mirrors make anything but remote (see `routedBump`). Everything else,
 * including any other public-host URL, is a remote tarball.
 */
export function classifyNpmTarball(url: string, name: string, version: unknown): TarballSource {
  const hash = url.indexOf("#");
  const base = hash === -1 ? url : url.slice(0, hash);
  let parsed: URL | null = null;
  try {
    parsed = new URL(base);
  } catch {
    parsed = null;
  }
  const plain =
    parsed !== null &&
    parsed.href === base &&
    (parsed.protocol === "https:" || parsed.protocol === "http:") &&
    !parsed.username &&
    !parsed.password &&
    !base.includes("?") &&
    (hash === -1 || YARN_FRAGMENT.test(url.slice(hash + 1)));
  const remote = { kind: "remote", location: plain ? base : null } as const;
  if (typeof version !== "string" || !VALID_VERSION.npm(version) || !validNpmName(name)) {
    return remote;
  }
  if (!plain || !parsed) return remote;
  const [canonicalPath] = npmRegistryTarballPaths(name, version);
  if (PUBLIC_NPM_HOSTS.some((host) => base === `https://${host}/${canonicalPath}`)) {
    return { kind: "public" };
  }
  if (PUBLIC_NPM_HOSTS.includes(parsed.hostname)) return remote;
  const pathname = parsed.pathname;
  const path = npmRegistryTarballPaths(name, version).find((tail) => pathname.endsWith(`/${tail}`));
  if (!path) return remote;
  const prefix = pathname.slice(0, -path.length);
  // An encoded separator or dot in the registry's own path can route the
  // request somewhere the visible path does not name.
  if (/%(?:2f|5c|2e)/i.test(prefix)) return remote;
  return { kind: "registry", location: base };
}

const PYPI_SIMPLE_INDEX = /^https:\/\/pypi\.org\/simple\/?$/;

/** PyPI's own simple index, as uv records it. */
export function isPyPiSimpleIndex(url: string): boolean {
  return PYPI_SIMPLE_INDEX.test(url);
}

/**
 * A distribution file on PyPI's own file host, written the way PyPI links it:
 * plain https, already canonical, no query, fragment, or credentials, and no
 * encoded separator or dot that could route the request elsewhere.
 */
export function isPublicPyPiFileUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (
    parsed.href === url &&
    parsed.protocol === "https:" &&
    parsed.host === "files.pythonhosted.org" &&
    parsed.pathname.startsWith("/packages/") &&
    !parsed.username &&
    !parsed.password &&
    !url.includes("?") &&
    !url.includes("#") &&
    !/%(?:2f|5c|2e)/i.test(parsed.pathname)
  );
}

const SHA512_TOKEN = /^sha512-[A-Za-z0-9+/]{86}==$/;
// npm (through ssri) checks only the strongest algorithm an integrity string
// names. These rank below sha512, so beside one they are never what is checked.
const WEAKER_TOKEN =
  /^(?:sha1-[A-Za-z0-9+/]{27}=|sha256-[A-Za-z0-9+/]{43}=|sha384-[A-Za-z0-9+/]{64})$/;
const MAX_INTEGRITY_LENGTH = 1024;

/**
 * An npm-format integrity string as an identity pin, and the `sha512-…`
 * components a mirror comparison may rely on. Those are offered only when
 * every other component is a known weaker digest: an unknown algorithm could
 * rank above sha512 in the installer and be the one actually checked.
 */
export function npmIntegrity(value: unknown): { pin: string | null; hashes: string[] | null } {
  if (typeof value !== "string") return { pin: null, hashes: null };
  const pin = value.trim();
  if (!pin) return { pin: null, hashes: null };
  if (pin.length > MAX_INTEGRITY_LENGTH) return { pin, hashes: null };
  const tokens = [...new Set(pin.split(/\s+/))].sort();
  const sha512 = new Set<string>();
  for (const token of tokens) {
    if (SHA512_TOKEN.test(token)) sha512.add(token);
    else if (!WEAKER_TOKEN.test(token)) return { pin: tokens.join(" "), hashes: null };
  }
  return { pin: tokens.join(" "), hashes: sha512.size > 0 ? [...sha512].sort() : null };
}

export const MANIFEST_DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;
