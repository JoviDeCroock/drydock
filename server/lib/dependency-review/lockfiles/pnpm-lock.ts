import {
  createSnapshotBuilder,
  sourceOf,
  validNpmName,
  type LockfileSnapshot,
  type SnapshotBuilder,
} from "./snapshot";
import { yamlLines } from "./lines";

const DEPENDENCY_SECTIONS = new Set(["dependencies", "devDependencies", "optionalDependencies"]);
const PACKAGE_SECTIONS = new Set(["packages", "snapshots"]);

// pnpm-lock.yaml v5 through v9. Installed packages are the keys of
// `packages` (and v9's `snapshots`); direct dependencies are the `importers`
// sections, or the top-level sections of a single-project v5 lockfile.
export function parsePnpmLock(text: string): LockfileSnapshot {
  const builder = createSnapshotBuilder("npm");
  // By key without its peer suffix. In v9 a `snapshots` key repeats its
  // `packages` key, whose entry carries the resolution.
  const entries = new Map<string, PnpmEntry>();
  let mode: "importers" | "root" | "packages" | null = null;
  let importer: string | null = null;
  let sectionIndent: number | null = null;
  let dep: string | null = null;
  let pkg: PnpmEntry | null = null;
  let inResolution = false;

  for (const line of yamlLines(text)) {
    const { indent, value } = line;
    const key = line.key ?? "";
    if (indent === 0) {
      dep = null;
      pkg = null;
      importer = null;
      sectionIndent = null;
      mode = key === "importers" ? "importers" : PACKAGE_SECTIONS.has(key) ? "packages" : null;
      if (DEPENDENCY_SECTIONS.has(key)) {
        mode = "root";
        importer = ".";
        sectionIndent = 0;
      }
      continue;
    }
    if (mode === "packages") {
      if (indent === 2) {
        pkg = null;
        inResolution = false;
        const id = before(key, "(");
        const parsed = pnpmPackageKey(id);
        if (!parsed) continue;
        pkg = entries.get(id) ?? null;
        if (pkg) continue;
        if (!builder.reserve()) break;
        pkg = { ...parsed, fields: new Map(), resolution: new Map() };
        entries.set(id, pkg);
      } else if (pkg && indent === 4) {
        inResolution = key === "resolution";
        if (inResolution) for (const [k, v] of flowFields(value)) pkg.resolution.set(k, v);
        else if (key === "name" || key === "version") pkg.fields.set(key, value);
      } else if (pkg && inResolution && indent === 6 && key) {
        pkg.resolution.set(key, value);
      }
      continue;
    }
    if (mode === "importers" && indent === 2) {
      importer = key;
      sectionIndent = null;
      dep = null;
      continue;
    }
    if (mode === "importers" && indent === 4) {
      sectionIndent = DEPENDENCY_SECTIONS.has(key) ? 4 : null;
      dep = null;
      continue;
    }
    if (sectionIndent === null || importer === null) continue;
    let declared: string | null = null;
    if (indent === sectionIndent + 2) {
      dep = key;
      if (value) declared = value;
    } else if (indent === sectionIndent + 4 && key === "version" && dep) {
      declared = value;
    }
    if (declared && dep) {
      builder.markDirect(importerPackageName(dep, declared));
    }
  }

  for (const entry of entries.values()) recordEntry(builder, entry);
  return builder.finish();
}

interface PnpmEntry {
  name: string;
  // What follows the name in the key: a version, or a URL / git reference.
  ref: string;
  // A v5/v6 key with another registry's hostname in place of the leading `/`.
  host: boolean;
  // `name:` / `version:` fields, which git and tarball entries carry.
  fields: Map<string, string>;
  resolution: Map<string, string>;
}

// Directory resolutions are repository code and are skipped. Git resolutions
// and off-registry tarballs are remote sources identified by commit or URL.
function recordEntry(builder: SnapshotBuilder, entry: PnpmEntry): void {
  const name = entry.fields.get("name") ?? entry.name;
  const version = entry.fields.get("version") ?? entry.ref;
  const res = entry.resolution;
  const type = res.get("type");
  if (type === "directory" || res.has("directory") || sourceOf(entry.ref) === "local") return;
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
  const source = tarball === undefined ? null : sourceOf(tarball);
  if (source === "local") return;
  if (source === "remote") builder.addRemote(name, tarball, version);
  else if (entry.host) builder.addRemote(name, null, version);
  else if (SEMVER_SHAPED.test(entry.ref) || source === "public") builder.add(name, entry.ref);
  // Neither a version nor a local path: a URL or git reference in the key.
  else builder.addRemote(name, entry.ref, version);
}

const SEMVER_SHAPED = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]*)?$/;

// The fields of a flow-style `{integrity: ..., tarball: ...}` resolution.
function flowFields(flow: string): Array<[string, string]> {
  if (!flow.startsWith("{")) return [];
  const out: Array<[string, string]> = [];
  for (const field of flow.replace(/^\{|\}$/g, "").split(",")) {
    const colon = field.indexOf(":");
    if (colon > 0) out.push([field.slice(0, colon).trim(), field.slice(colon + 1).trim()]);
  }
  return out;
}

// `/name/1.2.3` and `/name/1.2.3_peer@x` (v5), `/name@1.2.3` (v6), `name@1.2.3`
// (v9), `name@https://...` or `name@git+...` (v9 remote sources). A v5/v6
// package from a non-default registry has that registry's hostname in place
// of the leading slash. Peer suffixes in parentheses are already cut.
function pnpmPackageKey(key: string): { name: string; ref: string; host: boolean } | null {
  const { body, host } = registryHost(key);
  const at = body.indexOf("@", 1);
  if (at > 0) {
    const name = body.slice(0, at);
    // The v5 form puts a peer's `@` after an underscore, which leaves a slash
    // in the "name" and fails the name check.
    if (validNpmName(name)) return { name, ref: body.slice(at + 1), host };
  }
  if (!host && !key.startsWith("/")) return null;
  const slash = body.lastIndexOf("/");
  if (slash <= 0) return null;
  // A v5/v6 git key (`github.com/org/repo/<sha>`) yields an invalid name here;
  // its entry's `name:` field supplies the real one.
  return { name: body.slice(0, slash), ref: before(body.slice(slash + 1), "_"), host };
}

// Default-registry keys start with `/` (v5/v6) or with the name (v9); neither
// has a dotted first path segment before a slash, which is a hostname.
function registryHost(key: string): { body: string; host: boolean } {
  if (key.startsWith("/")) return { body: key.slice(1), host: false };
  const slash = key.indexOf("/");
  const first = key.slice(0, slash);
  if (slash > 0 && /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(first)) {
    return { body: key.slice(slash + 1), host: true };
  }
  return { body: key, host: false };
}

// An importer's resolved value: `1.2.3`, `1.2.3(peer@x)`, `1.2.3_peer@x`
// (v5), an alias `real@1.2.3` / `/real@1.2.3` / `/real/1.2.3_peer@x`, a
// remote reference, or a link/file reference to repository code. Only the
// name is used: it marks which installed package the importer declares.
function importerPackageName(dep: string, value: string): string | null {
  let v = before(value, "(");
  if (sourceOf(v) === "local") return null;
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
