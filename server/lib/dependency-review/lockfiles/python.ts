import { createHash } from "node:crypto";
import { textLines } from "./lines";
import { createSnapshotBuilder, incompleteSnapshot, type LockfileSnapshot } from "./snapshot";

const PYPI_SIMPLE = /^https:\/\/pypi\.org\/simple\/?$/;
const LOCAL_UV_SOURCES = new Set(["path", "directory"]);
const SOURCE_KINDS = ["registry", "git", "url", "path", "directory", "editable", "virtual"];
const TOML_STRING_FIELD = /^(name|version) = "([^"\\]*)"$/;
const DEPENDENCY_NAME = /\{ ?name = "([^"\\]*)"/g;
const SHA256_HASH = /^sha256:[0-9a-fA-F]{64}$/;
const TABLE_HEADER = /^(?:\[[A-Za-z0-9_.-]+\]|\[\[[A-Za-z0-9_.-]+\]\])$/;
// Subtables of a package that hold metadata, never distribution files.
const METADATA_SUBTABLES = new Set([
  "metadata",
  "metadata.requires-dev",
  "optional-dependencies",
  "dev-dependencies",
]);

interface UvPackage {
  name: string | null;
  version: string | null;
  source: { kind: string; value: string } | null;
  // Every `{ name = "..." }` in the block: its dependency lists, optional and
  // dev groups, and `requires-dist` metadata.
  dependsOn: string[];
  // The `sha256:` hash of each `sdist` / `wheels` file, while every file
  // entry read cleanly as one with a sha256 hash.
  hashes: string[];
  files: number;
  filesClean: boolean;
  // Field lines seen twice, or a name/version/source line in a form this
  // reader does not take: uv would read something this reader cannot.
  malformed: boolean;
  seen: Set<string>;
  // Every line of the block, digested for an identity when the file list is
  // unreadable.
  block: ReturnType<typeof createHash>;
}

/**
 * uv.lock: `[[package]]` tables. Registry packages are installed packages,
 * from a private source unless the registry is pypi.org. Git and URL sources
 * are remote, identified by their source string (which carries the commit or
 * URL). Path, directory, and workspace-member sources are repository code. A
 * workspace member (an `editable` or `virtual` source) declares whatever it
 * depends on directly.
 *
 * This is a line reader for the TOML uv writes, not a TOML parser. Where uv
 * would read a key this reader could miss or misplace (a multi-line string, a
 * spaced or quoted table header, a package field in another form, a file
 * table outside `sdist` / `wheels`), the snapshot is incomplete or the
 * package's file hashes are not offered, never read as something else.
 */
export function parseUvLock(text: string): LockfileSnapshot {
  const builder = createSnapshotBuilder("pypi");
  const packages: UvPackage[] = [];
  let current: UvPackage | null = null;
  let inPackageTable = false;
  // Inside a multi-line array value: `wheels` (file entries) or any other.
  let array: "wheels" | "other" | null = null;
  for (const raw of textLines(text)) {
    const line = raw.trim();
    if (line.includes('"""') || line.includes("'''")) {
      builder.markIncomplete();
      break;
    }
    current?.block.update(`${raw}\n`);
    if (array !== null) {
      if (line === "]" || line === "],") {
        array = null;
        continue;
      }
      if (line.startsWith("[") && TABLE_HEADER.test(tableHeader(line))) {
        builder.markIncomplete();
        break;
      }
      if (current && array === "wheels" && line && !line.startsWith("#")) {
        readFileEntry(current, line.endsWith(",") ? line.slice(0, -1) : line);
      }
      if (current) collectDependencyNames(current, line, builder.reserve);
      continue;
    }
    if (line.startsWith("[")) {
      const header = tableHeader(line);
      if (header === "[[package]]") {
        if (!builder.reserve()) break;
        current = newPackage();
        current.block.update(`${raw}\n`);
        packages.push(current);
        inPackageTable = true;
      } else if (header.startsWith("[package.") || header.startsWith("[[package.")) {
        // `[package.optional-dependencies]` and similar stay with the current
        // package; a file table in table form is not read.
        const sub = header.replace(/^\[\[?package\.|\]\]?$/g, "");
        if (current && !METADATA_SUBTABLES.has(sub)) current.filesClean = false;
        inPackageTable = false;
      } else {
        if (!TABLE_HEADER.test(header)) builder.markIncomplete();
        // Any other table (`[manifest]`, `[options]`) ends the package.
        current = null;
        inPackageTable = false;
      }
      continue;
    }
    if (!current) continue;
    collectDependencyNames(current, line, builder.reserve);
    if (inPackageTable) array = readPackageLine(current, raw, line);
  }
  if (array !== null) builder.markIncomplete();
  for (const pkg of packages) {
    // Recorded anyway: an incomplete snapshot is never diffed, but it still
    // shows what was read.
    if (pkg.malformed || !pkg.name || !pkg.source) builder.markIncomplete();
    if (!pkg.source) continue;
    const hashes = pkg.filesClean && pkg.files > 0 ? [...new Set(pkg.hashes)].sort() : null;
    const pin = filePin(pkg, hashes);
    const { kind, value } = pkg.source;
    if (kind === "editable" || kind === "virtual") {
      for (const name of pkg.dependsOn) builder.markDirect(name);
    } else if (kind === "registry") {
      builder.add(pkg.name, pkg.version, {
        ...(PYPI_SIMPLE.test(value) ? {} : { registry: { location: value, ref: null } }),
        hashes,
        pin,
      });
    } else if (!LOCAL_UV_SOURCES.has(kind)) {
      builder.addRemote(pkg.name, value, pkg.version, pin);
    }
  }
  return builder.finish();
}

function newPackage(): UvPackage {
  return {
    name: null,
    version: null,
    source: null,
    dependsOn: [],
    hashes: [],
    files: 0,
    filesClean: true,
    malformed: false,
    seen: new Set(),
    block: createHash("sha256"),
  };
}

function collectDependencyNames(
  pkg: UvPackage,
  line: string,
  reserve: (count?: number) => boolean,
): void {
  for (const m of line.matchAll(DEPENDENCY_NAME)) {
    if (!reserve()) break;
    pkg.dependsOn.push(m[1]);
  }
}

// `[[ "package" ]] # x` reads as `[[package]]`; anything still odd after that
// fails the header pattern.
function tableHeader(line: string): string {
  const comment = line.indexOf("#");
  return (comment === -1 ? line : line.slice(0, comment)).replace(/[\s"']/g, "");
}

// One top-level line of a package table. Returns the multi-line array it
// opens, if any.
function readPackageLine(pkg: UvPackage, raw: string, line: string): "wheels" | "other" | null {
  const eq = line.indexOf("=");
  if (eq <= 0 || line.startsWith("#")) return null;
  const key = line.slice(0, eq).replace(/[\s"']/g, "");
  const value = line.slice(eq + 1).trim();
  const indented = /^\s/.test(raw);
  const once = () => {
    if (pkg.seen.has(key)) pkg.malformed = true;
    pkg.seen.add(key);
  };
  if (key === "name" || key === "version") {
    once();
    const field = indented ? null : TOML_STRING_FIELD.exec(line);
    if (field?.[1] === "name") pkg.name = field[2];
    else if (field?.[1] === "version") pkg.version = field[2];
    else pkg.malformed = true;
    return null;
  }
  if (key === "source") {
    once();
    pkg.source = indented ? null : uvSource(value);
    if (!pkg.source) pkg.malformed = true;
    return null;
  }
  if (key === "sdist") {
    once();
    if (indented) pkg.filesClean = false;
    else readFileEntry(pkg, value);
    return null;
  }
  if (key === "wheels") {
    once();
    if (indented || value !== "[") {
      pkg.filesClean = false;
      return value.startsWith("[") && !value.endsWith("]") ? "other" : null;
    }
    return "wheels";
  }
  if (key.startsWith("sdist.") || key.startsWith("wheels.")) pkg.filesClean = false;
  return value.startsWith("[") && !value.endsWith("]") ? "other" : null;
}

// `{ registry = "…" }`, `{ git = "…" }`, `{ url = "…", subdirectory = "…" }`.
// A registry source with any other key is not a plain registry: remote.
function uvSource(value: string): { kind: string; value: string } | null {
  const fields = inlineTable(value);
  if (!fields) return null;
  const kinds = SOURCE_KINDS.filter((kind) => fields.has(kind));
  if (kinds.length !== 1) return null;
  const kind = kinds[0];
  if (kind === "registry" && fields.size !== 1) return { kind: "url", value };
  return { kind, value: fields.get(kind)! };
}

function readFileEntry(pkg: UvPackage, text: string): void {
  pkg.files += 1;
  const hash = inlineTable(text)?.get("hash");
  if (hash !== undefined && SHA256_HASH.test(hash)) pkg.hashes.push(hash.toLowerCase());
  else pkg.filesClean = false;
}

// A single-line inline table of bare keys and plain values, the only form uv
// writes. Strings with escapes, nested values, and repeated keys read as null,
// so a hash cannot be lifted out of another value's text.
function inlineTable(text: string): Map<string, string> | null {
  if (!text.startsWith("{") || !text.endsWith("}")) return null;
  const fields = new Map<string, string>();
  let i = 1;
  const end = text.length - 1;
  const skip = () => {
    while (i < end && (text[i] === " " || text[i] === "\t")) i++;
  };
  for (;;) {
    skip();
    if (i >= end) return fields;
    const keyStart = i;
    while (i < end && /[A-Za-z0-9_-]/.test(text[i])) i++;
    const key = text.slice(keyStart, i);
    skip();
    if (!key || text[i] !== "=" || fields.has(key)) return null;
    i++;
    skip();
    let value: string;
    if (text[i] === '"') {
      const close = text.indexOf('"', i + 1);
      if (close === -1 || close >= end) return null;
      value = text.slice(i + 1, close);
      if (value.includes("\\")) return null;
      i = close + 1;
    } else {
      const valueStart = i;
      while (i < end && /[0-9]/.test(text[i])) i++;
      if (i === valueStart) return null;
      value = text.slice(valueStart, i);
    }
    fields.set(key, value);
    skip();
    if (i >= end) return fields;
    if (text[i] !== ",") return null;
    i++;
  }
}

// What pins a non-PyPI entry's bytes, for its identity: the one file hash, a
// digest of all of them, or, when the file list did not read cleanly, a
// digest of the whole package block.
function filePin(pkg: UvPackage, hashes: string[] | null): string | null {
  if (hashes?.length === 1) return hashes[0];
  if (hashes) {
    const digest = createHash("sha256").update(hashes.join("\n")).digest("hex");
    return `${hashes.length} files sha256:${digest}`;
  }
  if (pkg.files === 0 && pkg.filesClean) return null;
  return `lock entry sha256:${pkg.block.digest("hex")}`;
}

const PIN = /^\s*([A-Za-z0-9][\w.-]*)(?:\[[^\]]*\])?\s*==\s*([\w.+!-]+)(?=[\s;#]|$)/;
// Options that change where pins resolve. pip accepts a short option glued to
// its value (`-ihttps://...`).
const INDEX_OPTION = /^(?:-[if]|--(?:index-url|extra-index-url|find-links|no-index)(?=[=\s]|$))/;

// requirements*.txt exact `==` pins, all of them direct. The snapshot is
// incomplete when a pin may resolve somewhere other than pypi.org (any index
// option except an explicit pypi.org `--index-url`) or when a name is pinned to
// two versions (per-marker pins), since neither has one public version to
// review. Every other requirement line (ranges, `name @ url`, VCS and `-e`
// lines, includes) lands in `unpinned`: the file names no version for those,
// so the caller treats any change to that list as an unread lockfile, rather
// than this parser guessing names out of URLs.
export function parseRequirements(text: string): LockfileSnapshot {
  const builder = createSnapshotBuilder("pypi");
  const pins = new Map<string, string>();
  const unpinned: string[] = [];
  for (const line of logicalLines(text)) {
    const option = INDEX_OPTION.exec(line)?.[0];
    if (option !== undefined) {
      if (!defaultIndex(option, line.slice(option.length))) return incompleteSnapshot();
      continue;
    }
    const m = PIN.exec(line);
    if (!m) {
      if (!builder.reserve()) break;
      unpinned.push(line);
      continue;
    }
    const key = m[1].toLowerCase().replace(/[-_.]+/g, "-");
    const pinned = pins.get(key);
    if (pinned !== undefined && pinned !== m[2]) return incompleteSnapshot();
    if (pinned === undefined && !builder.reserve()) break;
    pins.set(key, m[2]);
  }
  for (const [name, version] of pins) {
    builder.add(name, version);
    builder.markDirect(name);
  }
  return builder.finish(unpinned.sort());
}

// pip's reading: `\` at a line end continues it, `#` at the start or after
// whitespace starts a comment (a `#` inside a URL fragment does not), and
// runs of whitespace are insignificant. Blank results are dropped.
function* logicalLines(text: string): Generator<string> {
  let pending = "";
  for (const raw of textLines(text)) {
    const trimmed = raw.trimEnd();
    if (trimmed.endsWith("\\")) {
      pending += `${trimmed.slice(0, -1)} `;
      continue;
    }
    const line = normalizeRequirement(pending + raw);
    pending = "";
    if (line) yield line;
  }
  const last = normalizeRequirement(pending);
  if (last) yield last;
}

function normalizeRequirement(line: string): string {
  let cut = line.length;
  for (let i = line.indexOf("#"); i !== -1; i = line.indexOf("#", i + 1)) {
    if (i === 0 || /\s/.test(line[i - 1])) {
      cut = i;
      break;
    }
  }
  return line.slice(0, cut).split(/\s+/).filter(Boolean).join(" ");
}

function defaultIndex(option: string, rest: string): boolean {
  if (option !== "-i" && option !== "--index-url") return false;
  const value = rest
    .replace(/^[=\s]+/, "")
    .split(/\s/, 1)[0]
    .replace(/^(["'])(.*)\1$/, "$2");
  return PYPI_SIMPLE.test(value);
}
