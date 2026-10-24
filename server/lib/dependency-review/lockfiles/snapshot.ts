import type { DependencyEcosystem } from "../types";

export interface LockfilePackage {
  ecosystem: DependencyEcosystem;
  name: string;
  versions: ReadonlySet<string>;
  // Some importer or manifest the lockfile covers declares this name.
  direct: boolean;
  // Some recorded version came from somewhere other than the public registry:
  // a private registry, a git ref, or a tarball URL. Its changes are still
  // reported, so such a bump cannot pass by vanishing from the diff. For a git
  // or URL source the "version" is the resolved reference (commit or URL),
  // which changes whenever the fetched code does.
  privateSource: boolean;
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

const CANONICAL_NAME: Record<DependencyEcosystem, (name: string) => string | null> = {
  npm: (name) => (validNpmName(name) ? name : null),
  pypi: normalizePyPiName,
};

export interface SnapshotBuilder {
  // Records one resolved version; invalid names or versions are dropped.
  add(name: unknown, version: unknown, privateSource?: boolean): void;
  // Records a version from a non-registry remote source, identified by its
  // resolved reference, or by `version` when there is none.
  addRemote(name: unknown, ref: unknown, version: unknown): void;
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
  versions: Set<string>;
  direct: boolean;
  privateSource: boolean;
}

export function createSnapshotBuilder(ecosystem: DependencyEcosystem): SnapshotBuilder {
  const packages = new Map<string, MutablePackage>();
  const direct = new Set<string>();
  let entries = 0;
  let records = 0;
  let complete = true;
  const canonical = (name: unknown) =>
    typeof name === "string" ? CANONICAL_NAME[ecosystem](name) : null;
  const record = (key: string, version: string, privateSource: boolean) => {
    const existing = packages.get(key);
    if (existing?.versions.has(version)) {
      if (privateSource) existing.privateSource = true;
      return;
    }
    if (
      entries >= MAX_SNAPSHOT_ENTRIES ||
      (existing?.versions.size ?? 0) >= MAX_VERSIONS_PER_PACKAGE
    ) {
      complete = false;
      return;
    }
    entries++;
    if (existing) {
      existing.versions.add(version);
      if (privateSource) existing.privateSource = true;
    } else {
      const versions = new Set([version]);
      packages.set(key, { ecosystem, name: key, versions, direct: false, privateSource });
    }
  };
  return {
    add(name, version, privateSource = false) {
      const key = canonical(name);
      if (key === null || typeof version !== "string" || !VALID_VERSION[ecosystem](version)) return;
      record(key, version, privateSource);
    },
    addRemote(name, ref, version) {
      const key = canonical(name);
      if (key === null) return;
      const identity = typeof ref === "string" ? boundedRef(ref) : "";
      if (identity) record(key, identity, true);
      else if (typeof version === "string" && VALID_VERSION[ecosystem](version)) {
        record(key, version, true);
      }
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
        out.set(`${ecosystem}:${key}`, { ...pkg, direct: direct.has(key) });
      }
      return { packages: out, complete, unpinned };
    },
  };
}

export function incompleteSnapshot(): LockfileSnapshot {
  return { packages: new Map(), complete: false, unpinned: [] };
}

const MAX_REF_LENGTH = 200;

// Refs are untrusted text; renderers escape them, this only bounds them. Both
// ends are kept because that is where a commit fragment or a versioned file
// name changes.
function boundedRef(ref: string): string {
  const trimmed = ref.trim();
  if (trimmed.length <= MAX_REF_LENGTH) return trimmed;
  const half = (MAX_REF_LENGTH - 1) / 2;
  return `${trimmed.slice(0, Math.ceil(half))}\u2026${trimmed.slice(-Math.floor(half))}`;
}

// Own-property read: lockfile JSON can carry `__proto__` or `constructor` keys,
// and a prototype hit must read as absent rather than as an inherited value.
export function ownField(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined;
}

const NPM_REGISTRY_TARBALL = /^https:\/\/registry\.(?:npmjs\.org|yarnpkg\.com)\//;

// Protocols whose code lives in the repository itself (or, for `exec:`, is
// generated by a script in it). They are reviewed as part of the PR's own diff.
const LOCAL_PROTOCOL = /^(?:file|link|workspace|portal|exec):/i;

// Where a recorded source places a package: the public registry, somewhere
// remote (a private registry, a git ref, a tarball URL), or the repository.
export function sourceOf(resolved: unknown): "public" | "remote" | "local" {
  if (typeof resolved !== "string") return "remote";
  if (NPM_REGISTRY_TARBALL.test(resolved)) return "public";
  return LOCAL_PROTOCOL.test(resolved) ? "local" : "remote";
}

export const MANIFEST_DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;
