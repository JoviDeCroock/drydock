// @ts-check
import { CliError } from "./client.mjs";
import { record } from "./admission-lockfile.mjs";

const SECTIONS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
// These fields describe the project or later intentional execution; none select
// a dependency source for npm ci. Unknown future resolver inputs fail closed.
const METADATA = new Set([
  "name",
  "version",
  "private",
  "description",
  "keywords",
  "homepage",
  "bugs",
  "license",
  "licenses",
  "author",
  "contributors",
  "funding",
  "repository",
  "files",
  "main",
  "module",
  "browser",
  "bin",
  "man",
  "directories",
  "type",
  "types",
  "typings",
  "exports",
  "imports",
  "sideEffects",
  "engines",
  "os",
  "cpu",
  "libc",
  "scripts",
  "publishConfig",
  "packageManager",
  "devEngines",
  "config",
  "readme",
  "readmeFilename",
  "gitHead",
  "dist",
  "maintainers",
  "preferGlobal",
  "deprecated",
  "eslintConfig",
  "browserslist",
  "babel",
  "prettier",
  "lint-staged",
  "husky",
  "jest",
  "ava",
  "mocha",
  "nyc",
  "xo",
  "stylelint",
  "standard",
  "tsd",
  "tshy",
  "typedoc",
  "volta",
]);

/** Bind the actual npm resolver input, not just a lockfile's claimed snapshot.
 * @param {string} text @param {string} lockText
 */
export function validateAdmissionManifest(text, lockText) {
  if (new TextEncoder().encode(text).length > 8 * 1024 * 1024)
    throw new CliError("package.json exceeds 8 MiB");
  /** @type {unknown} */
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch {
    throw new CliError("invalid sibling package.json");
  }
  if (!record(manifest)) throw new CliError("sibling package.json must be an object");
  // parseAdmissionLock already validated this document and its root entry.
  const root = JSON.parse(lockText).packages[""];
  for (const key of Object.keys(manifest)) {
    if (!METADATA.has(key) && !SECTIONS.includes(key) && key !== "peerDependenciesMeta") {
      throw new CliError(
        `package.json field ${key.slice(0, 100)} is unsupported; overrides, workspaces, and unknown resolver fields cannot be admitted`,
      );
    }
  }
  for (const section of SECTIONS) {
    const declared = admissionDeclarations(manifest[section]);
    const locked = admissionDeclarations(root[section]);
    if (JSON.stringify(declared) !== JSON.stringify(locked)) {
      throw new CliError(
        `package.json ${section} do not exactly match the active lockfile root; regenerate the lockfile without executing scripts`,
      );
    }
  }
  // Optional peer metadata affects the ideal tree even with identical versions.
  if (
    JSON.stringify(admissionPeerMeta(manifest.peerDependenciesMeta)) !==
    JSON.stringify(admissionPeerMeta(root.peerDependenciesMeta))
  ) {
    throw new CliError("package.json optional peer metadata differs from the active lockfile root");
  }
}

/** @param {unknown} value */
export function admissionDeclarations(value) {
  if (value === undefined) return [];
  if (!record(value)) throw new CliError("invalid package.json dependency declarations");
  const entries = Object.entries(value).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  for (const [, spec] of entries) {
    if (
      typeof spec !== "string" ||
      !spec.trim() ||
      spec.length > 1024 ||
      !/^[A-Za-z0-9.*+^~<>=| _-]+$/.test(spec)
    ) {
      throw new CliError(
        "package.json dependency declarations must use registry versions, ranges, or tags; alternate sources and aliases are unsupported",
      );
    }
  }
  return entries;
}

/** @param {unknown} value */
export function admissionPeerMeta(value) {
  if (value === undefined) return [];
  if (!record(value)) throw new CliError("invalid package.json peer metadata");
  return Object.entries(value)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, metadata]) => {
      if (
        !record(metadata) ||
        Object.keys(metadata).some((key) => key !== "optional") ||
        (metadata.optional !== undefined && typeof metadata.optional !== "boolean")
      )
        throw new CliError("unsupported package.json peer metadata");
      return [name, metadata.optional === true];
    });
}
