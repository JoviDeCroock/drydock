import { canonicalJson } from "../platform/canonical-json";
import { isRecord } from "../platform/guards";

// Only known package metadata is ignored. Unknown fields may configure a
// resolver, so changing them must still require a resolved lockfile.
const NPM_METADATA_FIELDS = new Set([
  "name",
  "version",
  "description",
  "keywords",
  "homepage",
  "bugs",
  "license",
  "author",
  "contributors",
  "maintainers",
  "funding",
  "repository",
  "private",
  "scripts",
  "files",
  "main",
  "module",
  "browser",
  "type",
  "types",
  "typings",
  "exports",
  "imports",
  "bin",
  "man",
  "directories",
  "sideEffects",
  "publishConfig",
]);

export function npmManifestHasOnlyMetadataChanges(before: string, after: string): boolean {
  try {
    const base: unknown = JSON.parse(before);
    const head: unknown = JSON.parse(after);
    if (!isRecord(base) || !isRecord(head)) return false;
    const dependencyFields = (manifest: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(manifest).filter(([key]) => !NPM_METADATA_FIELDS.has(key)));
    return canonicalJson(dependencyFields(base)) === canonicalJson(dependencyFields(head));
  } catch {
    // Malformed or excessively nested repository data cannot prove that
    // dependency declarations are unchanged.
    return false;
  }
}
