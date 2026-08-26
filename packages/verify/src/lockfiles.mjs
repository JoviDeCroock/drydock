import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const SUPPORTED_LOCKFILES = new Set(["package-lock.json", "pnpm-lock.yaml"]);

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

function walkPackageLockDependencies(dependencies, versions) {
  if (!dependencies || typeof dependencies !== "object") return;
  for (const [name, dependency] of Object.entries(dependencies)) {
    if (!dependency || typeof dependency !== "object") continue;
    addVersion(versions, name, dependency.version);
    walkPackageLockDependencies(dependency.dependencies, versions);
  }
}

export function parsePackageLock(text, source = "package-lock.json") {
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

  const versions = new Map();
  if (lockfile.packages && typeof lockfile.packages === "object") {
    for (const [installPath, entry] of Object.entries(lockfile.packages)) {
      if (!installPath || !entry || typeof entry !== "object" || entry.link === true) continue;
      addVersion(versions, entry.name ?? packageNameFromInstallPath(installPath), entry.version);
    }
  } else {
    walkPackageLockDependencies(lockfile.dependencies, versions);
  }
  return versions;
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
    return { name: `${slashParts[0]}/${slashParts[1]}`, version: slashParts[2] };
  }
  if (!locator.startsWith("@") && slashParts.length === 2 && !slashParts[1].includes("@")) {
    return { name: slashParts[0], version: slashParts[1] };
  }

  const separatorAt = locator.lastIndexOf("@");
  if (separatorAt <= 0 || separatorAt === locator.length - 1) return null;
  const name = locator.slice(0, separatorAt);
  const version = locator.slice(separatorAt + 1).replace(/\(.+$/, "");
  if (!name || !version || version.includes(":")) return null;
  return { name, version };
}

export function parsePnpmLock(text, source = "pnpm-lock.yaml") {
  const versions = new Map();
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  let inPackages = false;
  let foundPackages = false;

  for (const line of lines) {
    if (!inPackages) {
      if (line === "packages:") {
        inPackages = true;
        foundPackages = true;
      }
      continue;
    }
    if (line.length > 0 && !line.startsWith(" ") && !line.startsWith("#")) break;
    const match = /^ {2}(.+):\s*$/.exec(line);
    if (!match) continue;
    const parsed = packageFromPnpmLocator(match[1]);
    if (parsed) addVersion(versions, parsed.name, parsed.version);
  }

  if (!foundPackages) throw new Error(`${source} has no packages section`);
  return versions;
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

export function discoverDependencyPairs({ cwd = process.cwd(), base, env = process.env } = {}) {
  const baseRevision = resolveBaseRevision(cwd, base, env);
  const changed = git(cwd, [
    "diff",
    "--name-only",
    "--diff-filter=AM",
    baseRevision,
    "--",
    ":(glob)**/package-lock.json",
    ":(glob)**/pnpm-lock.yaml",
  ]);
  if (!changed) return { baseRevision, lockfiles: [], pairs: [] };

  const lockfiles = changed
    .split("\n")
    .filter(Boolean)
    .filter((filePath) => SUPPORTED_LOCKFILES.has(path.basename(filePath)));
  const pairsByIdentity = new Map();
  for (const filePath of lockfiles) {
    let beforeText;
    try {
      beforeText = git(cwd, ["show", `${baseRevision}:${filePath}`]);
    } catch {
      // A newly added lockfile has no old pair to verify.
      continue;
    }
    const before = parseLockfile(filePath, beforeText);
    const after = parseLockfile(filePath, currentLockfileText(cwd, filePath));
    for (const pair of diffPackageVersions(before, after)) {
      pairsByIdentity.set(`${pair.ecosystem}\0${pair.name}\0${pair.from}\0${pair.to}`, pair);
    }
  }
  return { baseRevision, lockfiles, pairs: [...pairsByIdentity.values()] };
}
