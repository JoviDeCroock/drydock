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
}

const PUBLIC_NPM = /^https?:\/\/registry\.(?:npmjs\.org|yarnpkg\.com)\/?$/;

export function emptyCustomRegistries(): CustomRegistries {
  return { all: false, scopes: new Set() };
}

export function collectCustomRegistries(
  found: CustomRegistries,
  config: { npmrc: string | null; yarnrc: string | null },
): CustomRegistries {
  const mark = (scope: string | null, value: string) => {
    const url = value.replace(/\s+#.*$/, "").replace(/^['"]|['"]$/g, "");
    if (PUBLIC_NPM.test(url)) return;
    if (scope) found.scopes.add(`@${scope.replace(/^@/, "")}`);
    else found.all = true;
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
      if (inScopes && entry.value) found.all = true;
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

function yamlKey(line: string): { key: string; value: string } | null {
  const quoted = /^(['"])((?:(?!\1).|\1\1)*)\1:(?:\s+(.*))?$/.exec(line);
  if (quoted) return { key: quoted[2].replace(/''/g, "'"), value: quoted[3]?.trim() ?? "" };
  const plain = /^([^\s'"][^:]*?):(?:\s+(.*))?$/.exec(line);
  return plain
    ? { key: plain[1], value: plain[2]?.trim().replace(/^['"]|['"]$/g, "") ?? "" }
    : null;
}
