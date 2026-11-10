import { createHash } from "node:crypto";
import { textLines } from "./lines";
import {
  createSnapshotBuilder,
  incompleteSnapshot,
  isPublicPyPiFileUrl,
  type LockfileSnapshot,
} from "./snapshot";

const PYPI_SIMPLE = /^https:\/\/pypi\.org\/simple\/?$/;
// The keys uv writes in an `sdist` / `wheels` entry.
const FILE_KEYS = new Set(["url", "hash", "size", "upload-time"]);
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
  // The `url` of each file entry.
  urls: string[];
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
  builder.expectStrongPins();
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
    if (kind === "editable" || kind === "virtual" || kind === "directory") {
      builder.addWorkspace(value);
    }
    if (kind === "editable" || kind === "virtual") {
      for (const name of pkg.dependsOn) builder.markDirect(name);
    } else if (kind === "registry") {
      const pypi = PYPI_SIMPLE.test(value);
      // uv fetches each file from the `url` the lock records, so the index
      // alone does not place the bytes. A PyPI package is public only when
      // every file is on PyPI's own file host and the files read cleanly
      // (each one pins a sha256); one whose files cannot be read cannot be
      // bound to PyPI's release, so the snapshot is unread.
      if (pypi && pkg.files > 0 && !pkg.filesClean) builder.markIncomplete();
      if (pypi && pkg.urls.every((url) => isPublicPyPiFileUrl(url))) {
        builder.add(pkg.name, pkg.version, { hashes, pin });
      } else {
        builder.add(pkg.name, pkg.version, {
          registry: { location: value, ref: null, urls: pkg.urls },
          hashes,
          pin,
        });
      }
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
    urls: [],
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

// A file entry pins one sha256 and names the URL it is fetched from.
function readFileEntry(pkg: UvPackage, text: string): void {
  pkg.files += 1;
  const fields = inlineTable(text);
  const hash = fields?.get("hash");
  const url = fields?.get("url");
  if (
    !fields ||
    [...fields.keys()].some((key) => !FILE_KEYS.has(key)) ||
    hash === undefined ||
    !SHA256_HASH.test(hash) ||
    url === undefined
  ) {
    pkg.filesClean = false;
    return;
  }
  pkg.hashes.push(hash.toLowerCase());
  if (pkg.urls.length < MAX_FILE_URLS) pkg.urls.push(url);
  else pkg.filesClean = false;
}

const MAX_FILE_URLS = 1024;

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

// `name[extras]==version ; marker`: name, extras, version, marker.
const PIN = /^([A-Za-z0-9][\w.-]*)(?:\[([^\]]*)\])? ?== ?([\w.+!-]+)(?: ?;(.*))?$/;
// pip substitutes `${NAME}` from the environment before it splits a line, so
// the value may hold options of its own.
const PIP_ENV_VAR = /\$\{[A-Z0-9_]+\}/;
const PIP_HASH = /^(sha256|sha384|sha512):([0-9a-fA-F]+)$/;
const SHA256_HEX = /^[0-9a-fA-F]{64}$/;

type PipOptionRole =
  // Where pins resolve: exactly PyPI or the file is unread.
  | "index"
  // Another source of distributions: the file is unread.
  | "source"
  // Names requirements this file does not pin (includes, editables) or
  // changes how they install: kept as text in `unpinned`.
  | "other"
  // Per-requirement options.
  | "hash"
  | "requirement";

// The options pip accepts in a requirements file, by long name, and whether
// each takes a value. pip (optparse) also accepts any unambiguous prefix of a
// long name and the short forms below, so both resolve here the same way.
const PIP_OPTIONS: Record<string, { role: PipOptionRole; value: boolean }> = {
  "index-url": { role: "index", value: true },
  "extra-index-url": { role: "source", value: true },
  "no-index": { role: "source", value: false },
  "find-links": { role: "source", value: true },
  constraint: { role: "other", value: true },
  requirement: { role: "other", value: true },
  editable: { role: "other", value: true },
  "no-binary": { role: "other", value: true },
  "only-binary": { role: "other", value: true },
  "prefer-binary": { role: "other", value: false },
  "require-hashes": { role: "other", value: false },
  pre: { role: "other", value: false },
  "trusted-host": { role: "other", value: true },
  "use-feature": { role: "other", value: true },
  hash: { role: "hash", value: true },
  "global-option": { role: "requirement", value: true },
  "config-settings": { role: "requirement", value: true },
};
const PIP_SHORT: Record<string, string> = {
  i: "index-url",
  f: "find-links",
  c: "constraint",
  r: "requirement",
  e: "editable",
};

function pipLongOption(name: string): string | null {
  if (Object.hasOwn(PIP_OPTIONS, name)) return name;
  const matches = Object.keys(PIP_OPTIONS).filter((option) => option.startsWith(name));
  return name && matches.length === 1 ? matches[0] : null;
}

// Every option on a line, as pip reads them: `--name=value`, `--name value`,
// `-xvalue`, `-x value`. Null when any is unknown, ambiguous, missing its
// value, or given one it does not take, or when a word is quoted in a way
// pip's shell-style split reads differently (see `shellWord`).
function pipOptions(raw: readonly string[]): Array<[string, string | null]> | null {
  const tokens: string[] = [];
  for (const word of raw) {
    const token = shellWord(word);
    if (token === null) return null;
    tokens.push(token);
  }
  const out: Array<[string, string | null]> = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "--") break;
    let name: string | null;
    let value: string | null = null;
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      name = pipLongOption(eq === -1 ? token.slice(2) : token.slice(2, eq));
      if (eq !== -1) value = token.slice(eq + 1);
    } else if (token.startsWith("-") && token.length > 1) {
      name = PIP_SHORT[token[1]] ?? null;
      if (token.length > 2) value = token.slice(2);
    } else {
      // A stray positional argument, which pip ignores.
      continue;
    }
    if (name === null) return null;
    const option = PIP_OPTIONS[name];
    if (option.value && value === null) {
      value = tokens[++i] ?? null;
      if (value === null) return null;
    } else if (!option.value && value !== null) {
      return null;
    }
    out.push([name, value]);
  }
  return out;
}

// One whitespace-free word as shlex reads it: quoted runs lose their quotes.
// Null for a backslash (an escape) or an unclosed quote, which in shlex would
// join the next word.
function shellWord(word: string): string | null {
  if (word.includes("\\")) return null;
  let out = "";
  let i = 0;
  while (i < word.length) {
    const c = word[i];
    if (c === "'" || c === '"') {
      const close = word.indexOf(c, i + 1);
      if (close === -1) return null;
      out += word.slice(i + 1, close);
      i = close + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

interface Pin {
  version: string;
  // Every `--hash` given for the name, as `algorithm:hex`.
  hashes: Set<string>;
  // Some line pins the name with no hash.
  unhashed: boolean;
  // Each pinning line's extras, marker, and install options (see
  // `pinQualifier`), "" for a line with none.
  qualifiers: Set<string>;
}

// requirements*.txt exact `==` pins, all of them direct, read the way pip
// reads the file (see `pipLines`). The snapshot is incomplete when a pin may
// resolve somewhere other than pypi.org (any index or find-links option
// except an explicit pypi.org `--index-url`), when any option on any line is
// not one pip accepts exactly as written, or when a name is pinned to two
// versions (per-marker pins), since neither has one public version to review.
// Every other requirement line (ranges, `name @ url`, VCS and `-e` lines,
// includes, install options) lands in `unpinned`: the file names no version
// for those, so the caller treats any change to that list as an unread
// lockfile, rather than this parser guessing names out of URLs. `--hash`
// values pin the release's files.
export function parseRequirements(text: string): LockfileSnapshot {
  const builder = createSnapshotBuilder("pypi");
  const pins = new Map<string, Pin>();
  const unpinned: string[] = [];
  const lines = pipLines(text);
  if (lines === null) return incompleteSnapshot();
  for (const line of lines) {
    const tokens = line.split(" ");
    let split = tokens.findIndex((token) => token.startsWith("-"));
    if (split === -1) split = tokens.length;
    const options = pipOptions(tokens.slice(split));
    if (options === null) return incompleteSnapshot();
    const args = tokens.slice(0, split).join(" ");
    const substituted = PIP_ENV_VAR.test(line);
    // Unless a requirement comes first, a substitution may expand into any
    // option.
    if (substituted && (!args || PIP_ENV_VAR.test(tokens[0]))) return incompleteSnapshot();
    if (!args) {
      for (const [name, value] of options) {
        const role = PIP_OPTIONS[name].role;
        if (role === "source") return incompleteSnapshot();
        if (role === "index" && !PYPI_SIMPLE.test(value ?? "")) return incompleteSnapshot();
      }
      if (options.some(([name]) => PIP_OPTIONS[name].role !== "index")) {
        if (!builder.reserve()) break;
        unpinned.push(line);
      }
      continue;
    }
    // On a requirement line pip ignores file-wide options; they are not a
    // shape this reads.
    const hashes: string[] = [];
    const installOptions: string[] = [];
    for (const [name, value] of options) {
      const role = PIP_OPTIONS[name].role;
      if (role === "requirement") installOptions.push(`--${name}=${value ?? ""}`);
      else if (role === "hash") {
        const m = PIP_HASH.exec(value ?? "");
        if (!m) return incompleteSnapshot();
        hashes.push(`${m[1]}:${m[2].toLowerCase()}`);
      } else {
        return incompleteSnapshot();
      }
    }
    const m = substituted ? null : PIN.exec(args);
    if (!m) {
      if (!builder.reserve()) break;
      unpinned.push(line);
      continue;
    }
    const key = normalizedName(m[1]);
    const pinned = pins.get(key);
    if (pinned !== undefined && pinned.version !== m[3]) return incompleteSnapshot();
    if (pinned === undefined && !builder.reserve()) break;
    const pin = pinned ?? {
      version: m[3],
      hashes: new Set<string>(),
      unhashed: false,
      qualifiers: new Set<string>(),
    };
    const qualifier = pinQualifier(m[2], m[4], installOptions);
    if (!pin.qualifiers.has(qualifier)) {
      if (!builder.reserve()) break;
      pin.qualifiers.add(qualifier);
    }
    for (const hash of hashes) pin.hashes.add(hash);
    if (hashes.length === 0) pin.unhashed = true;
    pins.set(key, pin);
  }
  const qualifiers = new Map<string, string>();
  const hashChecked = pins.size > 0 && [...pins.values()].every((pin) => !pin.unhashed);
  for (const [name, { version, hashes, unhashed, qualifiers: lines }] of pins) {
    qualifiers.set(name, [...lines].sort().join("\n"));
    const all = [...hashes].sort();
    // pip accepts a file matching any hash given; only when all of them are
    // sha256 (PyPI's digest) can a comparison cover every one.
    const sha256 =
      !unhashed &&
      all.length > 0 &&
      all.every((hash) => hash.startsWith("sha256:") && SHA256_HEX.test(hash.slice(7)));
    builder.add(name, version, {
      hashes: sha256 ? all : null,
      pin: all.length > 0 ? `${unhashed ? "unhashed " : ""}${all.join(" ")}` : null,
    });
    builder.markDirect(name);
  }
  return { ...builder.finish(unpinned.sort()), qualifiers, hashChecked };
}

function normalizedName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

// `[a,b] ; marker --option=value` with extras normalized and sorted, the
// marker as written (a marker string may hold spaces), and options sorted;
// "" when there is none of them.
function pinQualifier(
  extras: string | undefined,
  marker: string | undefined,
  options: string[],
): string {
  const names = (extras ?? "")
    .split(",")
    .map((extra) => normalizedName(extra.trim()))
    .filter(Boolean);
  const condition = (marker ?? "").trim();
  if (names.length === 0 && !condition && options.length === 0) return "";
  const parts = [`[${[...new Set(names)].sort().join(",")}]`];
  if (condition) parts.push(`; ${condition}`);
  parts.push(...options.sort());
  return parts.join(" ");
}

// Python's `splitlines` breaks lines on `\r`, `\v`, `\f`, 0x1c-0x1e, 0x85,
// U+2028, and U+2029 as well as `\n`; a file holding one (or any other control
// character but a tab) is not split the same way here, so it is unread.
function plainRequirementsText(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x09 || c === 0x0a) continue;
    if (c < 0x20 || c === 0x7f || c === 0x85 || c === 0x2028 || c === 0x2029 || c === 0xfeff) {
      return false;
    }
  }
  return true;
}

/**
 * The logical lines pip reads from a requirements file: a line ending in `\`
 * joins the next unless it is a comment line (`#` first, after optional
 * whitespace), which pip never continues and which ends a continuation it
 * follows; then a `#` at the start or after whitespace starts a comment, and
 * runs of whitespace collapse. Null when the text has a line break or control
 * character pip and this would split differently.
 */
function pipLines(text: string): string[] | null {
  const body = text.replace(/\r\n/g, "\n");
  if (!plainRequirementsText(body)) return null;
  const out: string[] = [];
  const push = (line: string) => {
    const clean = stripComment(line).split(/\s+/).filter(Boolean).join(" ");
    if (clean) out.push(clean);
  };
  let joined: string[] = [];
  for (const line of textLines(body)) {
    const comment = /^\s*#/.test(line);
    if (!line.endsWith("\\") || comment) {
      if (joined.length > 0) {
        joined.push(comment ? ` ${line}` : line);
        push(joined.join(""));
        joined = [];
      } else {
        push(line);
      }
    } else {
      joined.push(trimBackslashes(line));
    }
  }
  if (joined.length > 0) push(joined.join(""));
  return out;
}

// Python's `str.strip("\\")`: every backslash at either end.
function trimBackslashes(line: string): string {
  let start = 0;
  let end = line.length;
  while (start < end && line[start] === "\\") start++;
  while (end > start && line[end - 1] === "\\") end--;
  return line.slice(start, end);
}

// Everything from the first `#` that starts the line or follows whitespace.
function stripComment(line: string): string {
  for (let i = line.indexOf("#"); i !== -1; i = line.indexOf("#", i + 1)) {
    if (i === 0 || /\s/.test(line[i - 1])) return line.slice(0, i);
  }
  return line;
}
