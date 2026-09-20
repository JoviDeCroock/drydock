import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const SUPPORTED_LOCKFILES = new Set(["package-lock.json", "pnpm-lock.yaml"]);
const PUBLIC_NPM_REGISTRY_ORIGIN = "https://registry.npmjs.org";
const UNSUPPORTED_SOURCE_REASON = "dependency is not resolved from the public npm registry";
const AMBIGUOUS_PAIR_REASON =
  "several versions of this package changed at once; no single pair to verify";
const ADDED_LOCKFILE_REASON = "lockfile was added in this change, so there is no previous version";

function packageNameFromInstallPath(installPath) {
  const marker = "node_modules/";
  const markerAt = installPath.lastIndexOf(marker);
  if (markerAt === -1) return null;
  const name = installPath.slice(markerAt + marker.length);
  return name.length > 0 && !name.includes("node_modules/") ? name : null;
}

function addVersion(versions, name, version) {
  if (typeof name !== "string" || name.length === 0) return;
  if (typeof version !== "string" || version.length === 0) return;
  let packageVersions = versions.get(name);
  if (!packageVersions) {
    packageVersions = new Set();
    versions.set(name, packageVersions);
  }
  packageVersions.add(version);
}

function addDependency(index, name, version, publicRegistry) {
  if (typeof name !== "string" || name.length === 0) return;
  if (typeof version !== "string" || version.length === 0) return;
  let packageVersions = index.get(name);
  if (!packageVersions) {
    packageVersions = new Map();
    index.set(name, packageVersions);
  }
  const sources = packageVersions.get(version) ?? { publicRegistry: false, unsupported: false };
  if (publicRegistry) sources.publicRegistry = true;
  else sources.unsupported = true;
  packageVersions.set(version, sources);
}

function versionsFromIndex(index, { publicOnly = false } = {}) {
  const versions = new Map();
  for (const [name, packageVersions] of index) {
    for (const [version, sources] of packageVersions) {
      if (publicOnly && (!sources.publicRegistry || sources.unsupported)) continue;
      addVersion(versions, name, version);
    }
  }
  return versions;
}

function isPublicNpmResolution(value) {
  if (typeof value !== "string" || !value) return false;
  if (value === "registry.npmjs.org" || value.startsWith("registry.npmjs.org/")) return true;
  try {
    const url = new URL(value);
    return url.origin === PUBLIC_NPM_REGISTRY_ORIGIN && !url.username && !url.password;
  } catch {
    return false;
  }
}

/**
 * Whether a public-npm tarball URL is the tarball *for this name and version*.
 *
 * The name and version a lockfile entry declares are just text in the diff
 * under review, while `resolved` is what the installer actually fetches. Left
 * unbound, an entry could say `lodash@4.17.21` while resolving
 * `evil-pkg-9.9.9.tgz`, and the verdict — and the /diff link printed beside it
 * — would describe a package nobody installs.
 *
 * npm serves `<registry>/<name>/-/<basename>-<version>.tgz`, where `basename`
 * is the name without its scope. A URL that does not decompose that way is
 * unusable as evidence rather than assumed to match.
 */
function publicNpmResolutionMatches(value, name, version) {
  if (!isPublicNpmResolution(value)) return false;
  let pathname;
  try {
    pathname = new URL(value, `${PUBLIC_NPM_REGISTRY_ORIGIN}/`).pathname;
  } catch {
    return false;
  }
  const separator = pathname.lastIndexOf("/-/");
  if (separator === -1) return false;
  const resolvedName = decodeURIComponent(pathname.slice(1, separator));
  const file = decodeURIComponent(pathname.slice(separator + 3));
  if (resolvedName !== name) return false;
  const unscoped = name.startsWith("@") ? name.slice(name.indexOf("/") + 1) : name;
  return file === `${unscoped}-${version}.tgz`;
}

function walkPackageLockDependencies(dependencies, index) {
  if (!dependencies || typeof dependencies !== "object") return;
  for (const [name, dependency] of Object.entries(dependencies)) {
    if (!dependency || typeof dependency !== "object") continue;
    // lockfileVersion 1 records an alias as `version: "npm:real-name@1.0.0"`,
    // so the key is the local name and the real package is inside the version
    // string. Looking the key up publicly would present a same-named
    // squatter's diff, which is the failure `docs/dependency-pr-diff-links.md`
    // already documents for the Renovate integration.
    const alias = typeof dependency.version === "string" && dependency.version.startsWith("npm:");
    if (alias) {
      const spec = dependency.version.slice("npm:".length);
      const separator = spec.lastIndexOf("@");
      const aliasName = separator > 0 ? spec.slice(0, separator) : null;
      const aliasVersion = separator > 0 ? spec.slice(separator + 1) : null;
      if (aliasName && aliasVersion) {
        addDependency(
          index,
          aliasName,
          aliasVersion,
          publicNpmResolutionMatches(dependency.resolved, aliasName, aliasVersion),
        );
      }
    } else {
      addDependency(
        index,
        name,
        dependency.version,
        publicNpmResolutionMatches(dependency.resolved, name, dependency.version),
      );
    }
    walkPackageLockDependencies(dependency.dependencies, index);
  }
}

function parsePackageLockIndex(text, source = "package-lock.json") {
  let lockfile;
  try {
    lockfile = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `${source} is not valid JSON: ${error instanceof Error ? error.message : error}`,
    );
  }
  if (!lockfile || typeof lockfile !== "object") {
    throw new Error(`${source} must contain a JSON object`);
  }

  const index = new Map();
  if (lockfile.packages && typeof lockfile.packages === "object") {
    for (const [installPath, entry] of Object.entries(lockfile.packages)) {
      if (!installPath || !entry || typeof entry !== "object" || entry.link === true) continue;
      // `packages` also contains the repository root and workspace source
      // directories. Only installed `node_modules` entries are dependencies;
      // their `resolved` field then distinguishes public npm bytes from Git,
      // private registries, direct tarballs, and local sources.
      const installedName = packageNameFromInstallPath(installPath);
      if (!installedName) continue;
      const entryName = entry.name ?? installedName;
      addDependency(
        index,
        entryName,
        entry.version,
        publicNpmResolutionMatches(entry.resolved, entryName, entry.version),
      );
    }
  } else {
    walkPackageLockDependencies(lockfile.dependencies, index);
  }
  return index;
}

export function parsePackageLock(text, source = "package-lock.json") {
  return versionsFromIndex(parsePackageLockIndex(text, source), { publicOnly: true });
}

function unquoteYamlScalar(value) {
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll("''", "'");
  }
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value;
}

function packageFromPnpmLocator(rawLocator) {
  const unquoted = unquoteYamlScalar(rawLocator);
  if (!unquoted) return null;
  const withoutLeadingSlash = unquoted.startsWith("/") ? unquoted.slice(1) : unquoted;
  // pnpm 6+ appends the resolved peers as `(peer@version)` suffixes. They have
  // to come off before the name/version separator is located, or the last `@`
  // found is the one inside the suffix: `react-dom@18.2.0(react@18.2.0)` splits
  // into the name `react-dom@18.2.0(react`, and a real version bump then
  // produces no pair at all rather than a verdict.
  const locator = withoutLeadingSlash.replace(/\(.*$/, "");
  if (!locator) return null;

  // pnpm 5 used /name/version and /@scope/name/version locators. A tail that
  // carries a `:` is a non-registry locator (`file:`, `link:`, `git+ssh:`),
  // never a version.
  const slashParts = locator.split("/");
  const isPnpm5Version = (value) => /^[0-9][^@:]*$/.test(value);
  if (
    locator.startsWith("@") &&
    slashParts.length === 3 &&
    !slashParts[1].includes(":") &&
    isPnpm5Version(slashParts[2])
  ) {
    return {
      name: `${slashParts[0]}/${slashParts[1]}`,
      version: slashParts[2],
      registryCandidate: true,
    };
  }
  if (
    !locator.startsWith("@") &&
    slashParts.length === 2 &&
    // A pnpm 5 name carries neither an `@` nor a `:`; `mylib@file:../vendor`
    // splits into two parts whose tail looks like a version, so without this
    // the local directory dependency would be projected as public npm bytes.
    !slashParts[0].includes("@") &&
    !slashParts[0].includes(":") &&
    isPnpm5Version(slashParts[1])
  ) {
    return { name: slashParts[0], version: slashParts[1], registryCandidate: true };
  }

  const separatorAt = locator.lastIndexOf("@");
  if (separatorAt <= 0 || separatorAt === locator.length - 1) return null;
  const name = locator.slice(0, separatorAt);
  const version = locator.slice(separatorAt + 1);
  if (!name || !version) return null;
  // A name that still holds a `/` past its scope, or either half carrying a
  // `:`, is a locator this reader does not understand well enough to call a
  // public registry package.
  const scopedSegments = name.startsWith("@") ? 2 : 1;
  const understood =
    !version.includes(":") &&
    !name.includes(":") &&
    name.split("/").length === scopedSegments &&
    /^[0-9]/.test(version);
  return { name, version, registryCandidate: understood };
}

/**
 * Pull the resolution evidence out of one line of a pnpm entry.
 *
 * `registry` is the field that actually says where the bytes came from, and
 * dropping it was what made a private package indistinguishable from a public
 * one. The nested form is only honoured inside the entry's own `resolution:`
 * block, so a crafted key elsewhere in the entry cannot supply one.
 */
function resolutionFields(line, insideResolution) {
  const inline = /^ {4}resolution:\s*\{(.*)\}\s*$/.exec(line);
  if (inline) {
    const body = inline[1];
    const tarball = /\btarball:\s*([^,}]+)/.exec(body);
    const registry = /\bregistry:\s*([^,}]+)/.exec(body);
    return {
      tarball: tarball ? unquoteYamlScalar(tarball[1].trim()) : null,
      registry: registry ? unquoteYamlScalar(registry[1].trim()) : null,
      opensBlock: false,
    };
  }
  if (/^ {4}resolution:\s*$/.test(line)) {
    return { tarball: null, registry: null, opensBlock: true };
  }
  if (!insideResolution) return { tarball: null, registry: null, opensBlock: false };
  const tarball = /^ {6}tarball:\s*(.+?)\s*$/.exec(line);
  const registry = /^ {6}registry:\s*(.+?)\s*$/.exec(line);
  return {
    tarball: tarball ? unquoteYamlScalar(tarball[1].trim()) : null,
    registry: registry ? unquoteYamlScalar(registry[1].trim()) : null,
    opensBlock: false,
  };
}

function parsePnpmLockIndex(text, source = "pnpm-lock.yaml", isPublicRegistryPackage = () => true) {
  const index = new Map();
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  let inPackages = false;
  let foundPackages = false;
  let current = null;
  let currentTarball = null;
  let currentRegistry = null;
  let insideResolution = false;

  const flush = () => {
    if (!current) return;
    // Explicit evidence first, in the order of how much it proves: a recorded
    // registry, then a tarball URL bound to this exact name and version. Only
    // when the lockfile records neither does the resolved .npmrc policy decide,
    // which is the common pnpm 9 shape where entries carry just an integrity.
    let publicRegistry = false;
    if (current.registryCandidate) {
      if (currentRegistry !== null) publicRegistry = isPublicNpmResolution(currentRegistry);
      else if (currentTarball !== null) {
        publicRegistry = publicNpmResolutionMatches(currentTarball, current.name, current.version);
      } else publicRegistry = isPublicRegistryPackage(current.name);
    }
    addDependency(index, current.name, current.version, publicRegistry);
    current = null;
    currentTarball = null;
    currentRegistry = null;
    insideResolution = false;
  };

  for (const line of lines) {
    if (!inPackages) {
      if (line === "packages:") {
        inPackages = true;
        foundPackages = true;
      }
      continue;
    }
    if (line.length > 0 && !line.startsWith(" ") && !line.startsWith("#")) {
      flush();
      break;
    }
    const match = /^ {2}(.+):\s*$/.exec(line);
    if (match) {
      flush();
      current = packageFromPnpmLocator(match[1]);
      continue;
    }
    if (!current) continue;
    const fields = resolutionFields(line, insideResolution);
    if (fields.opensBlock) insideResolution = true;
    else if (/^ {4}\S/.test(line)) insideResolution = false;
    currentTarball ??= fields.tarball;
    currentRegistry ??= fields.registry;
  }
  flush();

  if (!foundPackages) throw new Error(`${source} has no packages section`);
  return index;
}

export function parsePnpmLock(text, source = "pnpm-lock.yaml") {
  return versionsFromIndex(parsePnpmLockIndex(text, source), { publicOnly: true });
}

export function parseLockfile(filePath, text) {
  switch (path.basename(filePath)) {
    case "package-lock.json":
      return parsePackageLock(text, filePath);
    case "pnpm-lock.yaml":
      return parsePnpmLock(text, filePath);
    default:
      throw new Error(`unsupported lockfile: ${filePath}`);
  }
}

function parseLockfileIndex(filePath, text, isPublicRegistryPackage) {
  switch (path.basename(filePath)) {
    case "package-lock.json":
      return parsePackageLockIndex(text, filePath);
    case "pnpm-lock.yaml":
      return parsePnpmLockIndex(text, filePath, isPublicRegistryPackage);
    default:
      throw new Error(`unsupported lockfile: ${filePath}`);
  }
}

export function diffPackageVersions(before, after) {
  const pairs = [];
  const names = new Set([...before.keys(), ...after.keys()]);
  for (const name of [...names].sort()) {
    const beforeVersions = before.get(name) ?? new Set();
    const afterVersions = after.get(name) ?? new Set();
    const removed = [...beforeVersions].filter((version) => !afterVersions.has(version)).sort();
    const added = [...afterVersions].filter((version) => !beforeVersions.has(version)).sort();

    // A lockfile can hold several versions of one package. Pair only when the
    // old and new sides are unambiguous; a confidently wrong public diff is
    // worse than a pair that needs a human to disambiguate. It is reported as
    // unavailable rather than dropped, because a change that quietly verifies
    // nothing must not read like a change that verified clean.
    if (removed.length === 1 && added.length === 1) {
      pairs.push({ ecosystem: "npm", name, from: removed[0], to: added[0] });
    } else if (removed.length > 0 && added.length > 0) {
      pairs.push({
        ecosystem: "npm",
        name,
        from: removed[0],
        to: added[added.length - 1],
        unavailableReason: AMBIGUOUS_PAIR_REASON,
      });
    }
  }
  return pairs;
}

function diffDependencyIndexes(before, after) {
  return diffPackageVersions(versionsFromIndex(before), versionsFromIndex(after)).map((pair) => {
    const beforeSource = before.get(pair.name)?.get(pair.from);
    const afterSource = after.get(pair.name)?.get(pair.to);
    const publicPair =
      beforeSource?.publicRegistry === true &&
      beforeSource.unsupported === false &&
      afterSource?.publicRegistry === true &&
      afterSource.unsupported === false;
    if (pair.unavailableReason) return pair;
    return publicPair ? pair : { ...pair, unavailableReason: UNSUPPORTED_SOURCE_REASON };
  });
}

function git(cwd, args, options = {}) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    }).trim();
  } catch (error) {
    const stderr =
      error && typeof error === "object" && "stderr" in error ? String(error.stderr).trim() : "";
    throw new Error(`git ${args[0]} failed${stderr ? `: ${stderr}` : ""}`);
  }
}

function revisionExists(cwd, revision) {
  try {
    execFileSync("git", ["rev-parse", "--verify", `${revision}^{commit}`], {
      cwd,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

export function resolveBaseRevision(cwd, requestedBase, env = process.env) {
  const candidates = [];
  if (requestedBase) candidates.push(requestedBase);
  else if (env.GITHUB_BASE_SHA) candidates.push(env.GITHUB_BASE_SHA);
  else if (env.GITHUB_BASE_REF)
    candidates.push(`origin/${env.GITHUB_BASE_REF}`, env.GITHUB_BASE_REF);
  else candidates.push("origin/main", "main", "HEAD^");

  const resolved = candidates.find((candidate) => revisionExists(cwd, candidate));
  if (!resolved) {
    throw new Error(`cannot resolve base revision; tried ${candidates.join(", ")}`);
  }
  if (!revisionExists(cwd, "HEAD")) return git(cwd, ["rev-parse", resolved]);
  return git(cwd, ["merge-base", resolved, "HEAD"]);
}

function currentLockfileText(cwd, filePath) {
  const absolute = path.resolve(cwd, filePath);
  const relative = path.relative(cwd, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`lockfile path escapes the repository: ${filePath}`);
  }
  return readFileSync(absolute, "utf8");
}

function interpolateNpmrcValue(value, env) {
  let complete = true;
  const resolved = value.replace(/\$\{([^}]+)\}/g, (_match, name) => {
    const replacement = env[name];
    if (typeof replacement !== "string") {
      complete = false;
      return "";
    }
    return replacement;
  });
  return complete ? resolved : null;
}

function publicRegistryPackagePolicy(npmrc, env) {
  const registries = new Map();
  if (typeof npmrc === "string") {
    for (const rawLine of npmrc.replaceAll("\r\n", "\n").split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#") || line.startsWith(";")) continue;
      const separatorAt = line.indexOf("=");
      if (separatorAt <= 0) continue;
      const key = line.slice(0, separatorAt).trim();
      if (key !== "registry" && !/^@[^:]+:registry$/.test(key)) continue;
      registries.set(key, interpolateNpmrcValue(line.slice(separatorAt + 1).trim(), env));
    }
  }

  const environmentRegistry = env.npm_config_registry ?? env.NPM_CONFIG_REGISTRY;
  if (typeof environmentRegistry === "string" && environmentRegistry) {
    registries.set("registry", environmentRegistry);
  }
  const defaultRegistry = registries.has("registry")
    ? registries.get("registry")
    : `${PUBLIC_NPM_REGISTRY_ORIGIN}/`;

  return (packageName) => {
    const scope = packageName.startsWith("@")
      ? packageName.slice(0, packageName.indexOf("/"))
      : null;
    const registry = (scope && registries.get(`${scope}:registry`)) ?? defaultRegistry;
    if (typeof registry !== "string") return false;
    try {
      const url = new URL(registry);
      return (
        url.origin === PUBLIC_NPM_REGISTRY_ORIGIN &&
        (url.pathname === "/" || url.pathname === "") &&
        !url.username &&
        !url.password
      );
    } catch {
      return false;
    }
  };
}

function currentRepositoryFile(cwd, filePath) {
  try {
    return readFileSync(path.join(cwd, filePath), "utf8");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return null;
    throw error;
  }
}

function repositoryFileAtRevision(cwd, revision, filePath) {
  const listed = git(cwd, ["ls-tree", "--name-only", revision, "--", filePath]);
  if (!listed.split("\n").includes(filePath)) return null;
  return git(cwd, ["show", `${revision}:${filePath}`]);
}

function changedLockfiles(cwd, baseRevision) {
  const changed = git(cwd, [
    "diff",
    "--name-status",
    "-z",
    "--find-renames=1%",
    "--diff-filter=ADMR",
    baseRevision,
    "--",
    ":(glob)**/package-lock.json",
    ":(glob)**/pnpm-lock.yaml",
  ]);
  if (!changed) return [];

  const fields = changed.split("\0");
  const lockfiles = [];
  const additions = [];
  const deletions = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    if (!status) break;
    if (status.startsWith("R")) {
      const beforePath = fields[index++];
      const afterPath = fields[index++];
      if (beforePath && afterPath) lockfiles.push({ beforePath, afterPath });
      continue;
    }
    const filePath = fields[index++];
    if (!filePath) continue;
    if (status === "A") additions.push(filePath);
    else if (status === "D") deletions.push(filePath);
    else lockfiles.push({ beforePath: filePath, afterPath: filePath });
  }

  const unmatchedDeletions = new Set(deletions);
  for (const afterPath of additions) {
    const candidates = [...unmatchedDeletions].filter(
      (beforePath) => path.dirname(beforePath) === path.dirname(afterPath),
    );
    const beforePath = candidates.length === 1 ? candidates[0] : null;
    if (beforePath) unmatchedDeletions.delete(beforePath);
    lockfiles.push({ beforePath, afterPath });
  }
  return lockfiles.filter(({ afterPath }) => SUPPORTED_LOCKFILES.has(path.basename(afterPath)));
}

export function discoverDependencyPairs({ cwd = process.cwd(), base, env = process.env } = {}) {
  const baseRevision = resolveBaseRevision(cwd, base, env);
  const changed = changedLockfiles(cwd, baseRevision);
  if (changed.length === 0) return { baseRevision, lockfiles: [], pairs: [] };

  // The baseline must use versioned repository evidence, not the target's
  // current environment: otherwise a private-to-public registry migration can
  // relabel historical private bytes as public npm bytes.
  // npm and pnpm both read an `.npmrc` per directory, so a monorepo that puts
  // its private registry beside the package — rather than at the repository
  // root — would otherwise have every one of its packages classified from the
  // root's public default.
  const npmrcFor = (lockfilePath, readFile) => {
    const directories = [];
    let directory = path.posix.dirname(lockfilePath);
    while (directory && directory !== "." && directory !== "/") {
      directories.push(directory);
      directory = path.posix.dirname(directory);
    }
    directories.push(".");
    // Nearest wins, so the root is read first and closer files layer over it.
    return directories
      .reverse()
      .map((entry) => readFile(entry === "." ? ".npmrc" : `${entry}/.npmrc`))
      .filter((text) => typeof text === "string")
      .join("\n");
  };
  const policyFor = (lockfilePath, readFile, policyEnv) =>
    publicRegistryPackagePolicy(npmrcFor(lockfilePath, readFile), policyEnv);
  const readAtBase = (filePath) => repositoryFileAtRevision(cwd, baseRevision, filePath);
  const readCurrent = (filePath) => currentRepositoryFile(cwd, filePath);
  const pairsByIdentity = new Map();
  const addedLockfiles = [];
  for (const { beforePath, afterPath } of changed) {
    if (!beforePath) {
      // A lockfile added in this change has no previous side to diff against.
      // Skipping it silently made "verified nothing" read exactly like
      // "verified clean", so it is reported as unavailable evidence instead.
      addedLockfiles.push({ path: afterPath, unavailableReason: ADDED_LOCKFILE_REASON });
      continue;
    }
    const before = parseLockfileIndex(
      beforePath,
      git(cwd, ["show", `${baseRevision}:${beforePath}`]),
      policyFor(beforePath, readAtBase, {}),
    );
    const after = parseLockfileIndex(
      afterPath,
      currentLockfileText(cwd, afterPath),
      policyFor(afterPath, readCurrent, env),
    );
    for (const pair of diffDependencyIndexes(before, after)) {
      const identity = `${pair.ecosystem}\0${pair.name}\0${pair.from}\0${pair.to}`;
      const existing = pairsByIdentity.get(identity);
      pairsByIdentity.set(
        identity,
        existing?.unavailableReason || pair.unavailableReason
          ? { ...pair, unavailableReason: UNSUPPORTED_SOURCE_REASON }
          : pair,
      );
    }
  }
  return {
    baseRevision,
    lockfiles: changed.map(({ afterPath }) => afterPath),
    pairs: [...pairsByIdentity.values()],
    addedLockfiles,
  };
}
