import { textLines } from "./lines";
import { createSnapshotBuilder, incompleteSnapshot, type LockfileSnapshot } from "./snapshot";

const PYPI_SIMPLE = /^https:\/\/pypi\.org\/simple\/?$/;
const LOCAL_UV_SOURCES = new Set(["path", "directory"]);
const TOML_STRING_FIELD = /^(name|version) = "([^"\\]*)"$/;
const SOURCE = /^source = \{ ?(\w+) = "([^"\\]*)"/;
const DEPENDENCY_NAME = /\{ ?name = "([^"\\]*)"/g;

interface UvPackage {
  name: string | null;
  version: string | null;
  source: { kind: string; value: string } | null;
  // Every `{ name = "..." }` in the block: its dependency lists, optional and
  // dev groups, and `requires-dist` metadata.
  dependsOn: string[];
}

// uv.lock: `[[package]]` tables. Registry packages are installed packages,
// from a private source unless the registry is pypi.org. Git and URL sources
// are remote, identified by their source string (which carries the commit or
// URL). Path, directory, and workspace-member sources are repository code. A
// workspace member (an `editable` or `virtual` source) declares whatever it
// depends on directly.
export function parseUvLock(text: string): LockfileSnapshot {
  const builder = createSnapshotBuilder("pypi");
  const packages: UvPackage[] = [];
  let current: UvPackage | null = null;
  let inPackageTable = false;
  for (const raw of textLines(text)) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      if (line === "[[package]]") {
        if (!builder.reserve()) break;
        current = { name: null, version: null, source: null, dependsOn: [] };
        packages.push(current);
        inPackageTable = true;
      } else {
        // `[package.optional-dependencies]` and similar stay with the current
        // package; any other table (`[manifest]`, `[options]`) ends it.
        const subtable = line.startsWith("[package.") || line.startsWith("[[package.");
        if (!subtable) current = null;
        inPackageTable = false;
      }
      continue;
    }
    if (!current) continue;
    if (inPackageTable && !/^\s/.test(raw)) {
      const field = TOML_STRING_FIELD.exec(line);
      if (field?.[1] === "name") current.name = field[2];
      else if (field?.[1] === "version") current.version = field[2];
      const source = SOURCE.exec(line);
      if (source) current.source = { kind: source[1], value: source[2] };
    }
    for (const m of line.matchAll(DEPENDENCY_NAME)) {
      if (!builder.reserve()) break;
      current.dependsOn.push(m[1]);
    }
  }
  for (const pkg of packages) {
    if (!pkg.source) continue;
    if (pkg.source.kind === "editable" || pkg.source.kind === "virtual") {
      for (const name of pkg.dependsOn) builder.markDirect(name);
    } else if (pkg.source.kind === "registry") {
      builder.add(pkg.name, pkg.version, !PYPI_SIMPLE.test(pkg.source.value));
    } else if (!LOCAL_UV_SOURCES.has(pkg.source.kind)) {
      builder.addRemote(pkg.name, pkg.source.value, pkg.version);
    }
  }
  return builder.finish();
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
