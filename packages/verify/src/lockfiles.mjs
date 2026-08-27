import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const SUPPORTED_LOCKFILES = new Set(["package-lock.json", "pnpm-lock.yaml"]);
const PUBLIC_NPM_REGISTRY_ORIGIN = "https://registry.npmjs.org";
const UNSUPPORTED_SOURCE_REASON = "dependency is not resolved from the public npm registry";

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

function walkPackageLockDependencies(dependencies, index) {
  if (!dependencies || typeof dependencies !== "object") return;
  for (const [name, dependency] of Object.entries(dependencies)) {
    if (!dependency || typeof dependency !== "object") continue;
    addDependency(index, name, dependency.version, isPublicNpmResolution(dependency.resolved));
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
      addDependency(
        index,
        entry.name ?? installedName,
        entry.version,
        isPublicNpmResolution(entry.resolved),
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
  const locator = unquoted.startsWith("/") ? unquoted.slice(1) : unquoted;

  // pnpm 5 used /name/version and /@scope/name/version locators.
  const slashParts = locator.split("/");
  if (locator.startsWith("@") && slashParts.length === 3 && !slashParts[2].includes("@")) {
    return {
      name: `${slashParts[0]}/${slashParts[1]}`,
      version: slashParts[2],
      registryCandidate: true,
    };
  }
  if (!locator.startsWith("@") && slashParts.length === 2 && !slashParts[1].includes("@")) {
    return { name: slashParts[0], version: slashParts[1], registryCandidate: true };
  }

  const separatorAt = locator.lastIndexOf("@");
  if (separatorAt <= 0 || separatorAt === locator.length - 1) return null;
  const name = locator.slice(0, separatorAt);
  const version = locator.slice(separatorAt + 1).replace(/\(.+$/, "");
  if (!name || !version) return null;
  return { name, version, registryCandidate: !version.includes(":") };
}

function inlineResolutionTarball(line) {
  const inline = /^ {4}resolution:\s*\{.*\btarball:\s*([^,}]+).*\}\s*$/.exec(line);
  if (inline) return unquoteYamlScalar(inline[1].trim());
  const nested = /^ {6}tarball:\s*(.+?)\s*$/.exec(line);
  return nested ? unquoteYamlScalar(nested[1].trim()) : null;
}

function parsePnpmLockIndex(text, source = "pnpm-lock.yaml", isPublicRegistryPackage = () => true) {
  const index = new Map();
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  let inPackages = false;
  let foundPackages = false;
  let current = null;
  let currentTarball = null;

  const flush = () => {
    if (!current) return;
    const publicRegistry =
      current.registryCandidate &&
      (currentTarball
        ? isPublicNpmResolution(currentTarball)
        : isPublicRegistryPackage(current.name));
    addDependency(index, current.name, current.version, publicRegistry);
    current = null;
    currentTarball = null;
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
    if (current) currentTarball ??= inlineResolutionTarball(line);
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
    // worse than omitting a pair that needs a human to disambiguate.
    if (removed.length !== 1 || added.length !== 1) continue;
    pairs.push({ ecosystem: "npm", name, from: removed[0], to: added[0] });
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

function publicRegistryPackagePolicy(cwd, env) {
  const registries = new Map();
  try {
    const npmrc = readFileSync(path.join(cwd, ".npmrc"), "utf8");
    for (const rawLine of npmrc.replaceAll("\r\n", "\n").split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#") || line.startsWith(";")) continue;
      const separatorAt = line.indexOf("=");
      if (separatorAt <= 0) continue;
      const key = line.slice(0, separatorAt).trim();
      if (key !== "registry" && !/^@[^:]+:registry$/.test(key)) continue;
      registries.set(key, interpolateNpmrcValue(line.slice(separatorAt + 1).trim(), env));
    }
  } catch (error) {
    if (!error || typeof error !== "object" || error.code !== "ENOENT") throw error;
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

function changedLockfiles(cwd, baseRevision) {
  const changed = git(cwd, [
    "diff",
    "--name-status",
    "-z",
    "--find-renames=1%",
    "--diff-filter=AMR",
    baseRevision,
    "--",
    ":(glob)**/package-lock.json",
    ":(glob)**/pnpm-lock.yaml",
  ]);
  if (!changed) return [];

  const fields = changed.split("\0");
  const lockfiles = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    if (!status) break;
    if (status.startsWith("R")) {
      const beforePath = fields[index++];
      const afterPath = fields[index++];
      if (beforePath && afterPath) lockfiles.push({ beforePath, afterPath });
      continue;
    }
    const afterPath = fields[index++];
    if (afterPath) lockfiles.push({ beforePath: status === "A" ? null : afterPath, afterPath });
  }
  return lockfiles.filter(({ afterPath }) => SUPPORTED_LOCKFILES.has(path.basename(afterPath)));
}

export function discoverDependencyPairs({ cwd = process.cwd(), base, env = process.env } = {}) {
  const baseRevision = resolveBaseRevision(cwd, base, env);
  const changed = changedLockfiles(cwd, baseRevision);
  if (changed.length === 0) return { baseRevision, lockfiles: [], pairs: [] };

  const isPublicRegistryPackage = publicRegistryPackagePolicy(cwd, env);
  const pairsByIdentity = new Map();
  for (const { beforePath, afterPath } of changed) {
    if (!beforePath) {
      // A newly added lockfile has no old pair to verify.
      continue;
    }
    const before = parseLockfileIndex(
      beforePath,
      git(cwd, ["show", `${baseRevision}:${beforePath}`]),
      isPublicRegistryPackage,
    );
    const after = parseLockfileIndex(
      afterPath,
      currentLockfileText(cwd, afterPath),
      isPublicRegistryPackage,
    );
    for (const pair of diffDependencyIndexes(before, after)) {
      pairsByIdentity.set(`${pair.ecosystem}\0${pair.name}\0${pair.from}\0${pair.to}`, pair);
    }
  }
  return {
    baseRevision,
    lockfiles: changed.map(({ afterPath }) => afterPath),
    pairs: [...pairsByIdentity.values()],
  };
}
