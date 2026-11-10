import { PUBLIC_ROUTE, readStrictYaml, type NameRoute } from "./lockfiles";

/**
 * npm names a repository's committed config sends to a registry other than
 * the public one, and where. Those names are not diffable, may be
 * confidential, and a same-named public package would make the review
 * describe someone else's code. Mirrors `customRegistries` in
 * `.github/workflows/drydock-diff-link.yml`.
 */
export interface CustomRegistries {
  all: boolean;
  scopes: Set<string>;
  // Where each routed name goes, as written: the default registry's URLs and
  // each scope's. `unknown` is a route this reader could not see (config
  // outside the canonical shape, an environment-dependent value), which `all`
  // already covers for privacy.
  defaultUrls: Set<string>;
  scopeUrls: Map<string, Set<string>>;
  unknown: boolean;
  // Scopes (`""` for the default registry) the config sends to the public
  // registry by name. Routed nowhere else, they read as public either way;
  // a private-scope name routed here was sent there by the repository.
  explicitPublic?: Set<string>;
  // Some config that applies sets npm's `legacy-peer-deps`.
  legacyPeerDeps?: true;
}

/** What one config file routes, or null when it is not in the canonical shape. */
export interface RegistryRouting {
  defaultUrls: string[];
  scopeUrls: Map<string, string[]>;
  // A registry setting whose value depends on the environment, or a setting
  // that rewrites where packages are fetched from.
  unknown: boolean;
  // See `CustomRegistries.explicitPublic`.
  explicitPublic?: string[];
  // `.npmrc` sets `legacy-peer-deps=true`: npm installs no peers.
  legacyPeerDeps?: true;
}

const PUBLIC_NPM = /^https?:\/\/registry\.(?:npmjs\.org|yarnpkg\.com)\/?$/;
const MAX_ROUTED_URLS = 100;
// Real configs are a few lines. Above this a file is not read.
const MAX_REGISTRY_CONFIG_CHARS = 64 * 1024;

export function emptyCustomRegistries(): CustomRegistries {
  return {
    all: false,
    scopes: new Set(),
    defaultUrls: new Set(),
    scopeUrls: new Map(),
    unknown: false,
  };
}

/** Config that could not be read: every name is routed somewhere unknown. */
export function unreadableCustomRegistries(): CustomRegistries {
  return { ...emptyCustomRegistries(), all: true, unknown: true };
}

/** Adds one file's routing; null (unreadable) routes every name to unknown. */
export function addRouting(found: CustomRegistries, routing: RegistryRouting | null): void {
  if (routing === null || routing.unknown) {
    found.all = true;
    found.unknown = true;
    if (routing === null) return;
  }
  const mark = (urls: Set<string>, url: string) => {
    if (urls.size < MAX_ROUTED_URLS) urls.add(url);
    else found.unknown = true;
  };
  for (const url of routing.defaultUrls) {
    found.all = true;
    mark(found.defaultUrls, url);
  }
  if (routing.legacyPeerDeps) found.legacyPeerDeps = true;
  for (const scope of routing.explicitPublic ?? []) {
    found.explicitPublic ??= new Set();
    if (found.explicitPublic.size < MAX_ROUTED_URLS) found.explicitPublic.add(scope);
  }
  for (const [scope, urls] of routing.scopeUrls) {
    found.scopes.add(scope);
    const into = found.scopeUrls.get(scope) ?? new Set();
    found.scopeUrls.set(scope, into);
    for (const url of urls) mark(into, url);
  }
}

/** Merges a directory's `.npmrc` and `.yarnrc.yml` (null when absent). */
export function collectCustomRegistries(
  found: CustomRegistries,
  config: { npmrc: string | null; yarnrc: string | null },
): CustomRegistries {
  if (config.npmrc !== null) addRouting(found, parseNpmrc(config.npmrc));
  if (config.yarnrc !== null) addRouting(found, parseYarnrc(config.yarnrc));
  return found;
}

function newRouting(): RegistryRouting {
  return { defaultUrls: [], scopeUrls: new Map(), unknown: false };
}

function route(routing: RegistryRouting, scope: string | null, value: string): void {
  if (value.includes("${")) {
    routing.unknown = true;
    return;
  }
  if (PUBLIC_NPM.test(value)) {
    (routing.explicitPublic ??= []).push(scope ?? "");
    return;
  }
  if (scope === null) {
    routing.defaultUrls.push(value);
    return;
  }
  const urls = routing.scopeUrls.get(scope) ?? [];
  urls.push(value);
  routing.scopeUrls.set(scope, urls);
}

// `@scope:registry`, the scope registry key in npm's (and pnpm's) `.npmrc`.
const SCOPE_REGISTRY = /^(@[a-z0-9][a-z0-9._~-]*):registry$/;

/**
 * `.npmrc`, in the shape npm writes and its ini reader takes literally: blank
 * lines, `#` / `;` comment lines, and `key=value` lines with a bare key
 * (optionally `key[]`) and an unquoted value. Null for anything else: a
 * section, a quoted or escaped key (the ini reader unquotes and unescapes
 * them), a line with no `=`, a control character, or a registry value that
 * the ini reader would cut at an inline comment. A registry key spelled any
 * other way (case, a `[]` suffix, an environment reference), or
 * `replace-registry-host` set to anything but its default, makes the routing
 * unknown.
 */
export function parseNpmrc(text: string): RegistryRouting | null {
  if (text.length > MAX_REGISTRY_CONFIG_CHARS) return null;
  const routing = newRouting();
  for (const raw of text.split("\n")) {
    const line = trimAscii(raw.endsWith("\r") ? raw.slice(0, -1) : raw);
    if (!plainConfigLine(line)) return null;
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) return null;
    const key = trimAscii(line.slice(0, eq));
    const value = trimAscii(line.slice(eq + 1));
    if (!BARE_KEY.test(key)) return null;
    const lower = key.toLowerCase();
    // npm expands `${VAR}` in keys too, so such a key could be any setting.
    if (key.includes("${")) {
      routing.unknown = true;
      continue;
    }
    // Per-registry auth (`//host/:_authToken=…`) does not route.
    if (key.startsWith("//")) continue;
    if (lower === "legacy-peer-deps" && value === "true") routing.legacyPeerDeps = true;
    const scoped = SCOPE_REGISTRY.exec(key);
    if (key === "registry" || scoped) {
      if (!value || /["'\\;#\s]/.test(value)) return null;
      route(routing, scoped ? scoped[1] : null, value);
    } else if (lower.includes("registry")) {
      if (lower !== "replace-registry-host" || value !== "npmjs") routing.unknown = true;
    }
  }
  return routing;
}

const BARE_KEY = /^[A-Za-z0-9@/:._${}-]+(?:\[\])?$/;

/**
 * `.yarnrc.yml`, through the strict YAML reader: a top-level
 * `npmRegistryServer`, and `npmScopes.<scope>.npmRegistryServer`. Null when the
 * YAML is outside the subset or those settings are not scalars in that place.
 */
export function parseYarnrc(text: string): RegistryRouting | null {
  if (text.length > MAX_REGISTRY_CONFIG_CHARS) return null;
  const routing = newRouting();
  const path: string[] = [];
  let valid = true;
  const readable = readStrictYaml(text, (entry) => {
    if (entry === null) {
      valid = false;
      return false;
    }
    const { depth, key, value } = entry;
    path.length = depth;
    path.push(key ?? "");
    const scalar = value.kind === "scalar" ? value.text : null;
    if (depth === 0 && key === "npmRegistryServer") {
      if (scalar === null) valid = false;
      else route(routing, null, scalar);
    } else if (depth === 0 && key === "npmScopes") {
      if (value.kind !== "block" && !(value.kind === "map" && value.fields.size === 0)) {
        valid = false;
      }
    } else if (path[0] === "npmScopes" && depth === 1) {
      if (value.kind !== "block" || key === null) valid = false;
    } else if (path[0] === "npmScopes" && depth === 2 && key === "npmRegistryServer") {
      if (scalar === null) valid = false;
      else route(routing, `@${path[1].replace(/^@/, "").toLowerCase()}`, scalar);
    }
    return valid;
  });
  return readable && valid ? routing : null;
}

export function isPublicNpmName(registries: CustomRegistries, name: string): boolean {
  return !registries.all && !registries.scopes.has(scopeOf(name));
}

function scopeOf(name: string): string {
  return name.startsWith("@") ? name.slice(0, name.indexOf("/")).toLowerCase() : "";
}

/**
 * Where the config sends `name`. A scope's own registry wins over the
 * default; with several configs (the lockfile's directory and each one above
 * it) merged, every URL any of them names is kept, so a route must satisfy all
 * of them.
 */
export function npmNameRoute(registries: CustomRegistries, name: string): NameRoute {
  if (isPublicNpmName(registries, name)) {
    const named = registries.explicitPublic;
    return named?.has(scopeOf(name)) || named?.has("")
      ? { kind: "public", explicit: true }
      : PUBLIC_ROUTE;
  }
  if (registries.unknown) return { kind: "unknown" };
  const scoped = registries.scopeUrls.get(scopeOf(name));
  const urls = scoped ?? registries.defaultUrls;
  return urls.size > 0 ? { kind: "registries", urls: [...urls] } : { kind: "unknown" };
}

function plainConfigLine(line: string): boolean {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if ((c < 0x20 && c !== 0x09) || c === 0x7f || c === 0x2028 || c === 0x2029 || c === 0xfeff) {
      return false;
    }
  }
  return true;
}

// Spaces and tabs only, in one pass from each end: no regex, so a long run of
// whitespace costs its length once.
function trimAscii(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && (text[start] === " " || text[start] === "\t")) start++;
  while (end > start && (text[end - 1] === " " || text[end - 1] === "\t")) end--;
  return text.slice(start, end);
}

export function parseRoutingConfig(path: string, text: string): RegistryRouting | null {
  return path.endsWith(".npmrc") ? parseNpmrc(text) : parseYarnrc(text);
}

// Berry reads `.yarnrc.yml` from every directory above the project, npm and
// pnpm `.npmrc` from the project and workspace roots.
const MAX_CONFIG_DEPTH = 10;

/** `a/b/` → `a/b/`, `a/`, ``: where config applying to `dir` lives; null when deeper than read. */
export function configAncestors(dir: string): string[] | null {
  const parts = dir.split("/").filter(Boolean);
  if (parts.length > MAX_CONFIG_DEPTH) return null;
  const dirs: string[] = [];
  for (let n = parts.length; n >= 0; n--) {
    dirs.push(n === 0 ? "" : `${parts.slice(0, n).join("/")}/`);
  }
  return dirs;
}

const ROUTING_CONFIG = /(?:^|\/)(?:\.npmrc|\.yarnrc\.yml)$/;
const OPAQUE_CONFIG = /(?:^|\/)(?:\.yarnrc|uv\.toml|pip\.conf|pip\.ini)$/;
const PYPROJECT = /(?:^|\/)pyproject\.toml$/;

/**
 * Files that move where packages are fetched from, or how their bytes are
 * checked, without a lockfile showing it: `.npmrc` / `.yarnrc.yml` (compared
 * without comments and blank lines), a pyproject's `[tool.uv]` tables
 * (compared as text), and Yarn v1's `.yarnrc`, `uv.toml`, and `pip.conf` /
 * `pip.ini` (not read: any change counts).
 */
export function resolutionConfigKind(path: string): "routing" | "pyproject" | "opaque" | null {
  if (ROUTING_CONFIG.test(path)) return "routing";
  if (PYPROJECT.test(path)) return "pyproject";
  return OPAQUE_CONFIG.test(path) ? "opaque" : null;
}

/**
 * Whether a resolution config file changed anything that matters between
 * the merge base and the head (null: absent). Any setting may move bytes
 * (a registry, a proxy, a CA, TLS or checksum checks, another config file to
 * load), so for `.npmrc` / `.yarnrc.yml` every change but to comments and
 * blank lines counts; an absent file and one of only comments are the same.
 */
export function resolutionConfigChanged(
  path: string,
  before: string | null | "too-large",
  after: string | null | "too-large",
): boolean {
  const kind = resolutionConfigKind(path);
  if (kind === null) return false;
  if (kind === "opaque" || before === "too-large" || after === "too-large") return true;
  if (kind === "pyproject") return uvTables(before ?? "") !== uvTables(after ?? "");
  // A side outside the strict shape could hide a setting in what reads here
  // as a comment line (a `#` line in a block scalar).
  for (const text of [before, after]) {
    if (text !== null && parseRoutingConfig(path, text) === null) return true;
  }
  const ini = !path.endsWith(".yml");
  return settingLines(before ?? "", ini) !== settingLines(after ?? "", ini);
}

// The lines that are not blank and not whole-line comments: `#`, and `;` in
// an ini file (in YAML `;x: y` is a key). A `#` line inside a YAML block or
// multi-line scalar would be content; the caller refuses a file outside the
// strict shape before comparing.
function settingLines(text: string, ini: boolean): string {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    const start = line.trimStart();
    if (start && !start.startsWith("#") && !(ini && start.startsWith(";"))) out.push(line);
  }
  return out.join("\n");
}
// Yarn Berry directories whose committed contents Yarn installs or runs
// with nothing a lockfile diff binds: the default zip cache (zero-install;
// Yarn checks only its own checksum, which matches no registry digest),
// unplugged package copies, the Plug'n'Play loader, and the Yarn release and
// plugins it runs. A cache moved by `cacheFolder` is found by its archives'
// names and from the config (`yarnrcCacheFolder`).
const BERRY_COMMITTED_DIR = /^(.*?(?:^|\/)\.yarn\/(?:cache|unplugged|releases|plugins)\/)/;
const PNP_FILE = /(?:^|\/)\.pnp\.(?:c?js|loader\.mjs|data\.json)$/;
// A Berry cache archive's name, wherever `cacheFolder` puts it (yarnpkg-core
// `Cache.getChecksumFilename` / `getVersionFilename` over
// `structUtils.slugifyLocator`): the ident slug (`@scope-name` when scoped),
// the protocol (`npm`, `patch`, `https`, `git+ssh`, …) and, when the reference
// is plain semver, `-<version>`; then the first 10 hex of the locator hash,
// then the first 10 hex of the content checksum or, for an archive with no
// checksum, the cache key (`10`, `10c0`, `8`, …). The two leading groups
// overlap on `-`, so a name is length-bounded before it is tested.
const BERRY_CACHE_ARCHIVE =
  /^@?[\w.~-]+-[a-z][\w+.-]*-[0-9a-f]{10}-(?:[0-9a-f]{10}|\d{1,4}(?:c\d)?)\.zip$/;
const MAX_ARCHIVE_NAME = 255;

/**
 * The committed install input a changed path belongs to by its place or, for
 * a Berry cache archive, its name alone, reported once per directory (or
 * file, for the PnP loader); null for any other path. npm, pnpm, and Yarn
 * classic stores and offline mirrors are not here: they verify every tarball against the lockfile's integrity, which the
 * review binds, and pointing them elsewhere is a config change that already
 * counts.
 */
export function committedInstallInput(path: string): string | null {
  const dir = BERRY_COMMITTED_DIR.exec(path);
  if (dir) return dir[1];
  if (PNP_FILE.test(path)) return path;
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (name.length <= MAX_ARCHIVE_NAME && BERRY_CACHE_ARCHIVE.test(name)) {
    return path.slice(0, path.length - name.length) || "./";
  }
  return null;
}

/**
 * The `cacheFolder` a `.yarnrc.yml` in `dir` (a repository directory ending
 * in `/`, or `` for the root) sets, as a repository directory ending in `/`:
 * the setting is relative to the file's own directory. Null when it sets none
 * or names a place outside the repository; undefined when the file does not
 * read strictly or the value depends on the environment.
 */
export function yarnrcCacheFolder(dir: string, text: string): string | null | undefined {
  if (text.length > MAX_REGISTRY_CONFIG_CHARS) return undefined;
  let folder = null as string | null;
  let valid = true;
  const readable = readStrictYaml(text, (entry) => {
    if (entry === null) valid = false;
    else if (entry.depth === 0 && entry.key === "cacheFolder") {
      if (entry.value.kind === "scalar") folder = entry.value.text;
      else valid = false;
    }
    return valid;
  });
  if (!readable || !valid) return undefined;
  const value = folder;
  if (value === null) return null;
  if (value.includes("${") || value.includes("\\")) return undefined;
  if (value.startsWith("/") || value.startsWith("~")) return null;
  const parts = dir.split("/").filter(Boolean);
  for (const part of value.split("/")) {
    if (part === "" || part === ".") continue;
    if (part !== "..") parts.push(part);
    else if (parts.pop() === undefined) return null;
  }
  return parts.length > 0 ? `${parts.join("/")}/` : "";
}

const TOML_HEADER = /^\s*\[/;

// The text of a pyproject's `[tool]` and `[tool.uv…]` tables (and any dotted
// `tool.` key before the first table), whitespace-normalized, for comparison.
// A header written any other way that might name them counts as one of them.
function uvTables(text: string): string {
  const out: string[] = [];
  let inside = true;
  let seenHeader = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (TOML_HEADER.test(line)) {
      seenHeader = true;
      const header = line.replace(/[\s"']/g, "");
      inside =
        /^\[\[?tool(?:\]|\.uv)/.test(header) || !/^\[\[?[A-Za-z0-9_.-]+\]\]?(?:#|$)/.test(header);
    } else if (!seenHeader) {
      inside = /^["']?tool["']?\s*\./.test(line);
    }
    if (inside && line && !line.startsWith("#")) out.push(line.replace(/\s+/g, " "));
  }
  return out.join("\n");
}
