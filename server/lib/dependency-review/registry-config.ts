import { PUBLIC_ROUTE, type NameRoute } from "./lockfiles";

/**
 * npm names a repository's committed config sends to a registry other than
 * the public one. Those names are not diffable, may be confidential, and a
 * same-named public package would make the review describe someone else's
 * code, so their bumps are dropped before anything leaves for the public
 * diff. Mirrors `customRegistries` in `.github/workflows/drydock-diff-link.yml`.
 */
export interface CustomRegistries {
  all: boolean;
  scopes: Set<string>;
  // Where each routed name goes, as written: the default registry's URLs and
  // each scope's. `unknown` is a route this reader could not see (flow-style
  // scopes, oversized config), which `all` already covers for privacy.
  defaultUrls: Set<string>;
  scopeUrls: Map<string, Set<string>>;
  unknown: boolean;
}

const PUBLIC_NPM = /^https?:\/\/registry\.(?:npmjs\.org|yarnpkg\.com)\/?$/;
const MAX_ROUTED_URLS = 100;

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

export function collectCustomRegistries(
  found: CustomRegistries,
  config: { npmrc: string | null; yarnrc: string | null },
): CustomRegistries {
  const mark = (scope: string | null, value: string) => {
    const url = value.replace(/\s+#.*$/, "").replace(/^['"]|['"]$/g, "");
    if (PUBLIC_NPM.test(url)) return;
    let urls = found.defaultUrls;
    if (scope) {
      const key = `@${scope.replace(/^@/, "")}`;
      found.scopes.add(key);
      urls = found.scopeUrls.get(key) ?? new Set();
      found.scopeUrls.set(key, urls);
    } else {
      found.all = true;
    }
    if (urls.size < MAX_ROUTED_URLS) urls.add(url);
    else found.unknown = true;
  };
  for (const match of (config.npmrc ?? "").matchAll(
    /^[ \t]*(?:(@[^:\s]+):)?registry[ \t]*=[ \t]*(\S+)/gm,
  )) {
    mark(match[1] ?? null, match[2]);
  }
  let inScopes = false;
  let scope: string | null = null;
  let scopeIndent: number | null = null;
  for (const raw of (config.yarnrc ?? "").split(/\r?\n/)) {
    const indent = raw.length - raw.trimStart().length;
    const entry = yamlKey(raw.trim());
    if (!entry) continue;
    if (indent === 0) {
      inScopes = entry.key === "npmScopes";
      scope = null;
      scopeIndent = null;
      // Flow-style scopes are not parsed, so assume the worst.
      if (inScopes && entry.value) {
        found.all = true;
        found.unknown = true;
      }
    } else if (inScopes && (scopeIndent === null || indent === scopeIndent)) {
      scopeIndent = indent;
      scope = entry.key;
    }
    if (entry.key !== "npmRegistryServer") continue;
    if (indent === 0) mark(null, entry.value);
    else if (inScopes && scope) mark(scope, entry.value);
  }
  return found;
}

export function isPublicNpmName(registries: CustomRegistries, name: string): boolean {
  return !registries.all && !registries.scopes.has(name.split("/")[0]);
}

/**
 * Where the config sends `name`, for mirror matching. A scope's own registry
 * wins over the default; with both configs (the lockfile's directory and the
 * root) merged, every URL either names is kept, so a candidate must satisfy
 * all of them.
 */
export function npmNameRoute(registries: CustomRegistries, name: string): NameRoute {
  if (isPublicNpmName(registries, name)) return PUBLIC_ROUTE;
  if (registries.unknown) return { kind: "unknown" };
  const scoped = registries.scopeUrls.get(name.split("/")[0]);
  const urls = scoped ?? registries.defaultUrls;
  return urls.size > 0 ? { kind: "registries", urls: [...urls] } : { kind: "unknown" };
}

function yamlKey(line: string): { key: string; value: string } | null {
  const quoted = /^(['"])((?:(?!\1).|\1\1)*)\1:(?:\s+(.*))?$/.exec(line);
  if (quoted) return { key: quoted[2].replace(/''/g, "'"), value: quoted[3]?.trim() ?? "" };
  const plain = /^([^\s'"][^:]*?):(?:\s+(.*))?$/.exec(line);
  return plain
    ? { key: plain[1], value: plain[2]?.trim().replace(/^['"]|['"]$/g, "") ?? "" }
    : null;
}
