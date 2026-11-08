// @ts-check
import { CliError } from "./client.mjs";

const MAX_LOCK_BYTES = 8 * 1024 * 1024;
const NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const NODE_PATH =
  /^(?:node_modules\/(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)(?:\/node_modules\/(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)*$/;

/** Only modern npm registry locks are supported; ambiguity is a local hold. @param {string} text */
export function parseAdmissionLock(text) {
  if (new TextEncoder().encode(text).length > MAX_LOCK_BYTES)
    throw new CliError("lockfile exceeds 8 MiB");
  /** @type {any} */
  let lock;
  try {
    lock = JSON.parse(text);
  } catch {
    throw new CliError("invalid lockfile JSON");
  }
  if (
    !record(lock) ||
    ![2, 3].includes(lock.lockfileVersion) ||
    !record(lock.packages) ||
    !record(lock.packages[""])
  ) {
    throw new CliError("admission requires npm package-lock v2/v3 with a root packages entry");
  }
  const entries = Object.entries(lock.packages);
  if (entries.length > 2001)
    throw new CliError("lockfile exceeds 2000 dependency entries; split the project");
  /** @type {Map<string, {path: string, name: string, version: string, resolved: string, integrity: string, declarations: Record<string, unknown>}>} */
  const packages = new Map();
  for (const [path, value] of entries) {
    if (!path) continue;
    if (
      !NODE_PATH.test(path) ||
      !record(value) ||
      value.link ||
      value.inBundle ||
      value.bundled ||
      value.hasShrinkwrap
    ) {
      throw new CliError(
        "unsupported workspace, bundled, linked, nested-shrinkwrap, or malformed dependency; nothing was sent to Drydock",
      );
    }
    const locationName = path.slice(path.lastIndexOf("node_modules/") + 13);
    const name = value.name ?? locationName;
    if (
      typeof name !== "string" ||
      !NAME.test(name) ||
      typeof value.version !== "string" ||
      !VERSION.test(value.version)
    ) {
      throw new CliError("dependency name/version is not an exact npm registry identity");
    }
    if (name !== locationName) throw new CliError("npm aliases are not supported by admission");
    const resolved = publicTarball(value.resolved, name, value.version);
    const integrity = strongestIntegrity(value.integrity).sri;
    const declarations = Object.fromEntries(
      ["dependencies", "optionalDependencies", "peerDependencies"].map((section) => [
        section,
        record(value[section])
          ? Object.entries(value[section]).sort(([left], [right]) =>
              left < right ? -1 : left > right ? 1 : 0,
            )
          : [],
      ]),
    );
    const metadata = value.peerDependenciesMeta;
    if (
      metadata !== undefined &&
      (!record(metadata) ||
        Object.values(metadata).some(
          (item) =>
            !record(item) ||
            Object.keys(item).some((key) => key !== "optional") ||
            (item.optional !== undefined && typeof item.optional !== "boolean"),
        ))
    )
      throw new CliError("unsupported lockfile optional peer metadata");
    declarations.peerDependenciesMeta = record(metadata)
      ? Object.entries(metadata)
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([key, item]) => [key, item.optional === true])
      : [];
    packages.set(path, { path, name, version: value.version, resolved, integrity, declarations });
  }
  // npm ci must not discover an unlisted graph edge after the preflight.
  for (const [path, value] of entries) {
    if (!record(value)) throw new CliError("invalid dependency record");
    if (value.workspaces)
      throw new CliError("workspaces are outside npm admission's supported boundary");
    for (const section of [
      "dependencies",
      ...(path === "" ? ["devDependencies"] : []),
      "optionalDependencies",
      "peerDependencies",
    ]) {
      if (value[section] === undefined) continue;
      if (!record(value[section])) throw new CliError("invalid dependency declarations");
      for (const name of Object.keys(value[section])) {
        const spec = value[section][name];
        if (
          typeof spec !== "string" ||
          !spec.trim() ||
          spec.length > 1024 ||
          !/^[A-Za-z0-9.*+^~<>=| _-]+$/.test(spec)
        ) {
          throw new CliError(
            "dependency declarations must use registry versions, ranges, or tags; non-registry and alias sources are unsupported",
          );
        }
        if (!NAME.test(name) || !findDependency(path, name, packages)) {
          throw new CliError(
            "lockfile has an unresolved dependency edge; regenerate a complete registry-only lockfile",
          );
        }
      }
    }
  }
  return packages;
}

/** @param {string} path @param {string} name @param {Map<string, unknown>} packages */
function findDependency(path, name, packages) {
  let current = path;
  while (true) {
    if (packages.has(`${current ? `${current}/` : ""}node_modules/${name}`)) return true;
    if (!current) return false;
    const parent = current.lastIndexOf("/node_modules/");
    current = parent === -1 ? "" : current.slice(0, parent);
  }
}

/** Canonical npm URLs only; never forward credentials or visit custom origins. @param {unknown} value @param {string} name @param {string} version */
function publicTarball(value, name, version) {
  if (typeof value !== "string") throw new CliError("dependency is not a public npm tarball");
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new CliError("invalid dependency tarball URL");
  }
  const basename = name.split("/").at(-1);
  const expectedPath = `/${name}/-/${basename}-${version}.tgz`;
  if (
    url.origin !== "https://registry.npmjs.org" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    decodeURIComponent(url.pathname) !== expectedPath
  ) {
    throw new CliError(
      "only exact public registry.npmjs.org tarballs are supported; no names were sent to Drydock",
    );
  }
  return url.href;
}

/** SHA-1 is intentionally insufficient for admission. @param {unknown} value */
export function strongestIntegrity(value) {
  if (typeof value !== "string") throw new CliError("dependency has no strong integrity pin");
  const tokens = value.trim().split(/\s+/);
  if (!tokens.length || tokens.length > 8) throw new CliError("invalid dependency integrity");
  const parsed = tokens.map((token) => {
    const match = /^(sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})$/.exec(token);
    if (!match)
      throw new CliError("admission requires SHA-256, SHA-384, or SHA-512 SRI without options");
    const [, algorithm, digest] = match;
    const length = { sha256: 44, sha384: 64, sha512: 88 }[algorithm];
    if (digest.length !== length) throw new CliError("invalid dependency integrity digest");
    return { algorithm, digest, sri: token };
  });
  parsed.sort((a, b) => Number(b.algorithm.slice(3)) - Number(a.algorithm.slice(3)));
  const strongest = parsed[0];
  if (
    parsed.some(
      (item) => item.algorithm === strongest.algorithm && item.digest !== strongest.digest,
    )
  ) {
    throw new CliError("multiple differing strongest integrity digests are unsupported");
  }
  return strongest;
}

/** @param {unknown} value @returns {value is Record<string, any>} */
export function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @param {string} value */
export async function textDigest(value) {
  return hex(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))),
  );
}
/** @param {Uint8Array} value */
export function hex(value) {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
