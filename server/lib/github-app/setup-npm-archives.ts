export const NPM_ARCHIVE_DIRECTORY = "drydock-release";

// These programs run in the maintainer's CI, never in Drydock. Keep them
// import-free apart from Node builtins so publishing cannot load repository code.
const commonProgram = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const cp = require("node:child_process");
const root = fs.realpathSync(process.cwd());
const directory = path.join(root, "drydock-release");
const maxPackages = 100;
const maxFileBytes = 50 * 1024 * 1024;
const maxTotalBytes = 200 * 1024 * 1024;
const newline = String.fromCharCode(10);
function fail(message) { throw new Error(message); }
function regular(file, maximum) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum) fail("Unsupported or oversized file: " + file);
  return fs.readFileSync(file);
}
function json(file) { return JSON.parse(regular(file, 65536).toString("utf8")); }
function digest(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }
function packageName(name) { return typeof name === "string" && name.length <= 214 && new RegExp("^(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*$").test(name); }
function identity(pkg) {
  if (!packageName(pkg.name)) fail("Unsupported package name");
  if (typeof pkg.version !== "string" || pkg.version.length > 128 || !/^[0-9]+[.][0-9]+[.][0-9]+(?:-[0-9A-Za-z.-]+)?(?:[+][0-9A-Za-z.-]+)?$/.test(pkg.version)) fail("Unsupported package version");
}
function run(command, args, cwd) {
  const result = cp.spawnSync(command, args, { cwd: cwd || root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1048576, env: process.env });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error || result.status !== 0) fail("Command failed: " + command);
  return result;
}
function exists(name, version) {
  const result = cp.spawnSync("npm", ["view", name + "@" + version, "version", "--json"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1048576, env: process.env });
  if (result.error) fail("Could not check npm version");
  if (result.status === 0) return true;
  if ((String(result.stdout) + String(result.stderr)).includes("E404") || (String(result.stdout) + String(result.stderr)).includes("No match found")) return false;
  fail("Could not check npm version for " + name + "@" + version);
}
function sourceCommit() {
  const expected = process.env.GITHUB_SHA;
  if (typeof expected !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(expected)) fail("A valid GITHUB_SHA is required");
  const result = cp.spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1048576, env: process.env });
  if (result.error || result.status !== 0 || String(result.stdout).trim() !== expected) fail("The checkout does not match GITHUB_SHA");
  return expected;
}
`;

const prepareProgram = String.raw`
const os = require("node:os");
const configFile = path.join(root, ".changeset/config.json");
const config = fs.existsSync(configFile) ? json(configFile) : {};
if (config.ignore !== undefined && (!Array.isArray(config.ignore) || config.ignore.some((name) => !packageName(name)))) fail("Unsupported Changesets ignore configuration; only literal package names are supported");
const ignored = new Set(config.ignore || []);
const defaultAccess = config.access || "public";
if (!["public", "restricted"].includes(defaultAccess)) fail("Unsupported default package access");
const directories = new Set([root]);
function repositoryDirectory(relative) {
  if (!new RegExp("^[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*$").test(relative) || relative.split("/").some((part) => part === "." || part === "..")) fail("Unsupported workspace path: " + relative);
  const resolved = path.join(root, relative);
  if (!fs.existsSync(resolved)) return null;
  if (fs.realpathSync(resolved) !== resolved || !fs.lstatSync(resolved).isDirectory()) fail("Workspace directories must not be symlinks");
  return resolved;
}
const workspace = path.join(root, "pnpm-workspace.yaml");
if (fs.existsSync(workspace)) {
  let inPackages = false;
  let sawPackages = false;
  for (const rawLine of regular(workspace, 65536).toString("utf8").split(newline)) {
    const line = rawLine.trimEnd();
    if (/^packages[ ]*:/.test(line)) {
      if (sawPackages || !/^packages[ ]*:[ ]*(?:#.*)?$/.test(line)) fail("Unsupported workspace packages configuration");
      inPackages = true;
      sawPackages = true;
      continue;
    }
    if (inPackages && /^[^ ]/.test(line) && !/^#/.test(line)) inPackages = false;
    if (!inPackages || /^[ ]*(?:#.*)?$/.test(line)) continue;
    const item = /^[ ]+-[ ]+(.+?)[ ]*$/.exec(line);
    if (!item) fail("Unsupported workspace packages entry");
    let pattern = item[1];
    const first = pattern.charCodeAt(0);
    if ((first === 34 || first === 39) && pattern.charCodeAt(pattern.length - 1) === first) pattern = pattern.slice(1, -1);
    if (pattern.endsWith("/*")) {
      const parent = repositoryDirectory(pattern.slice(0, -2));
      if (!parent) continue;
      for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) fail("Workspace entries must not be symlinks");
        if (entry.isDirectory()) directories.add(repositoryDirectory(pattern.slice(0, -1) + entry.name));
      }
    } else {
      const selected = repositoryDirectory(pattern);
      if (selected) directories.add(selected);
    }
  }
  if (!sawPackages) fail("Workspace file has no supported packages block");
}
const commit = sourceCommit();
const selected = [];
const names = new Set();
for (const packageDirectory of directories) {
  const file = path.join(packageDirectory, "package.json");
  if (!fs.existsSync(file)) continue;
  const pkg = json(file);
  if (!pkg.name || !pkg.version || pkg.private || ignored.has(pkg.name)) continue;
  identity(pkg);
  if (names.has(pkg.name)) fail("Duplicate workspace package name");
  names.add(pkg.name);
  if (exists(pkg.name, pkg.version)) continue;
  const publication = pkg.publishConfig || {};
  if (publication.directory !== undefined || publication.registry !== undefined) fail("Custom publication directories or registries require manual setup");
  const access = publication.access || defaultAccess;
  if (!["public", "restricted"].includes(access)) fail("Unsupported package access");
  const scripts = pkg.scripts || {};
  if (scripts.publish || scripts.postpublish) fail("Publication lifecycle hooks require manual setup");
  for (const hook of ["prepublishOnly", "prepublish"]) if (scripts[hook] !== undefined && typeof scripts[hook] !== "string") fail("Unsupported lifecycle hook");
  const prerelease = pkg.version.match(/^[^-]+-([0-9A-Za-z-]+)/);
  selected.push({ packageDirectory, pkg, access, tag: prerelease ? prerelease[1] : "latest" });
}
if (selected.length > maxPackages) fail("Too many release packages");
if (fs.existsSync(directory)) fail("Release directory already exists; use a clean checkout");
fs.mkdirSync(directory);
const packages = [];
let totalBytes = 0;
for (const item of selected) {
  for (const hook of ["prepublishOnly", "prepublish"]) if (item.pkg.scripts && item.pkg.scripts[hook]) run("pnpm", ["--dir", item.packageDirectory, "run", hook]);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "drydock-pack-"));
  try {
    run("pnpm", ["--dir", item.packageDirectory, "pack", "--pack-destination", temporary, "--json"]);
    const files = fs.readdirSync(temporary);
    if (files.length !== 1 || !files[0].endsWith(".tgz")) fail("Packing must produce exactly one archive");
    const bytes = regular(path.join(temporary, files[0]), maxFileBytes);
    totalBytes += bytes.length;
    if (totalBytes > maxTotalBytes) fail("Release archives exceed the total size limit");
    const current = json(path.join(item.packageDirectory, "package.json"));
    if (current.name !== item.pkg.name || current.version !== item.pkg.version) fail("Packaging changed package identity");
    const archive = "package-" + String(packages.length + 1).padStart(4, "0") + ".tgz";
    fs.writeFileSync(path.join(directory, archive), bytes, { flag: "wx" });
    packages.push({ name: item.pkg.name, version: item.pkg.version, archive, access: item.access, tag: item.tag, sha256: digest(bytes) });
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
const manifest = JSON.stringify({ schema: "drydock.npm-archives.v1", sourceCommit: commit, packages }, null, 2) + newline;
if (Buffer.byteLength(manifest) > 65536) fail("Release manifest is too large");
fs.writeFileSync(path.join(directory, "manifest.json"), manifest, { flag: "wx" });
const sums = [digest(Buffer.from(manifest)) + "  manifest.json", ...packages.map((pkg) => pkg.sha256 + "  " + pkg.archive)].join(newline) + newline;
fs.writeFileSync(path.join(directory, "SHA256SUMS"), sums, { flag: "wx" });
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, "has_packages=" + String(packages.length > 0) + newline);
console.log("Prepared " + packages.length + " release archives.");
`;

const publishProgram = String.raw`
if (fs.realpathSync(directory) !== directory || !fs.lstatSync(directory).isDirectory()) fail("Release directory must not be a symlink");
const manifestBytes = regular(path.join(directory, "manifest.json"), 65536);
const manifest = JSON.parse(manifestBytes.toString("utf8"));
if (!manifest || manifest.schema !== "drydock.npm-archives.v1" || !Array.isArray(manifest.packages) || manifest.packages.length > maxPackages) fail("Unsupported release manifest");
if (Object.keys(manifest).some((key) => !["schema", "sourceCommit", "packages"].includes(key))) fail("Unsupported release manifest fields");
const sums = new Map();
for (const line of regular(path.join(directory, "SHA256SUMS"), 65536).toString("utf8").trim().split(newline)) {
  const match = /^([a-f0-9]{64})  (manifest[.]json|package-[0-9]{4}[.]tgz)$/.exec(line.trimEnd());
  if (!match || sums.has(match[2])) fail("Invalid archive digest manifest");
  sums.set(match[2], match[1]);
}
if (sums.get("manifest.json") !== digest(manifestBytes) || sums.size !== manifest.packages.length + 1) fail("Release manifest digest mismatch");
const names = new Set();
const archives = new Set();
let totalBytes = 0;
for (const pkg of manifest.packages) {
  identity(pkg);
  if (Object.keys(pkg).some((key) => !["name", "version", "archive", "access", "tag", "sha256"].includes(key))) fail("Unsupported release package fields");
  if (names.has(pkg.name) || typeof pkg.archive !== "string" || !/^package-[0-9]{4}[.]tgz$/.test(pkg.archive) || archives.has(pkg.archive)) fail("Invalid or duplicate release archive");
  if (!["public", "restricted"].includes(pkg.access) || typeof pkg.tag !== "string" || !/^[0-9A-Za-z][0-9A-Za-z._-]{0,99}$/.test(pkg.tag)) fail("Invalid package publication options");
  if (typeof pkg.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(pkg.sha256) || sums.get(pkg.archive) !== pkg.sha256) fail("Archive digest record mismatch");
  names.add(pkg.name);
  archives.add(pkg.archive);
  const bytes = regular(path.join(directory, pkg.archive), maxFileBytes);
  totalBytes += bytes.length;
  if (totalBytes > maxTotalBytes || digest(bytes) !== pkg.sha256) fail("Archive bytes do not match the reviewed digest");
}
const expected = new Set(["manifest.json", "SHA256SUMS", ...archives]);
if (fs.readdirSync(directory).some((name) => !expected.has(name))) fail("Unexpected file in release directory");
if (manifest.sourceCommit !== sourceCommit()) fail("Release archives were prepared from a different source commit");
for (const pkg of manifest.packages) {
  if (exists(pkg.name, pkg.version)) { console.log("Skipping already published " + pkg.name + "@" + pkg.version); continue; }
  const archive = path.join(directory, pkg.archive);
  if (digest(regular(archive, maxFileBytes)) !== pkg.sha256) fail("Release archive changed before publishing");
  run("npm", [MODE, "publish", archive, "--ignore-scripts", "--provenance", "--access", pkg.access, "--tag", pkg.tag, "--json"].filter(Boolean));
  const tag = pkg.name + "@" + pkg.version;
  const existing = cp.spawnSync("git", ["rev-parse", "--verify", "--quiet", "refs/tags/" + tag], { cwd: root, stdio: "ignore" });
  if (existing.error) fail("Could not check release tag");
  if (existing.status !== 0) run("git", ["tag", tag, "-m", tag]);
  console.log("New tag: " + tag);
}
`;

function inlineNodeCommand(program: string): string {
  // Both POSIX shells and @actions/exec decode these double-quote escapes.
  // Programs contain no template literals or shell variable substitutions.
  const source = program
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .join(" ");
  if (source.includes("\\") || source.includes("`") || /\$[A-Za-z_({]/.test(source))
    throw new Error("Canonical programs must not require shell-specific escaping");
  return `node -e "${source.replace(/"/g, '\\"')}"`;
}

export const npmArchivePrepareCommand = inlineNodeCommand(commonProgram + prepareProgram);

export function npmArchivePublishCommand(mode: "publish" | "stage"): string {
  return inlineNodeCommand(
    commonProgram + publishProgram.replace("MODE", JSON.stringify(mode === "stage" ? "stage" : "")),
  );
}
