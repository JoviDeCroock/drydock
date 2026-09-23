import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hostMetadataTarEntries, tarballEntryNames } from "./tarball-entries.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
const scenariosRoot = path.join(repoRoot, "test/e2e-fixtures/scenarios");
const outputRoot =
  process.env.E2E_REGISTRY_STATE_DIR || path.join(repoRoot, ".context/e2e-registry");
const tarballRoot = path.join(outputRoot, "tarballs");

await rm(outputRoot, { recursive: true, force: true });
await mkdir(tarballRoot, { recursive: true });

const scenarioNames = (await readdir(scenariosRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const scenarios = [];
for (const name of scenarioNames) {
  const scenarioDir = path.join(scenariosRoot, name);
  const scenario = await readJson(path.join(scenarioDir, "scenario.json"));
  const stagedPackageDir = path.join(scenarioDir, scenario.staged.directory);
  const stagedManifest = await readJson(path.join(stagedPackageDir, "package.json"));
  const previousPackageDir = scenario.previous?.directory
    ? path.join(scenarioDir, scenario.previous.directory)
    : null;
  const previousManifest = previousPackageDir
    ? await readJson(path.join(previousPackageDir, "package.json"))
    : null;

  assertEqual(scenario.packageName, stagedManifest.name, `${name} staged package name`);
  if (previousManifest) {
    assertEqual(scenario.packageName, previousManifest.name, `${name} previous package name`);
  }

  const stagedPack = await assertPortableTarball(
    await maybeRewritePackageJson(
      packPackage(stagedPackageDir, tarballRoot),
      scenario.staged.packageJsonText,
      `${name} staged`,
    ),
    `${name} staged`,
  );
  const previousPack = previousPackageDir
    ? await assertPortableTarball(packPackage(previousPackageDir, tarballRoot), `${name} previous`)
    : null;

  scenarios.push({
    name,
    stageId: scenario.stageId,
    packageName: scenario.packageName,
    stagePackageName: scenario.stagePackageName ?? scenario.packageName,
    stageVersion: scenario.stageVersion ?? stagedManifest.version,
    tag: scenario.tag ?? "latest",
    access: scenario.access ?? null,
    actor: scenario.actor ?? null,
    actorType: scenario.actorType ?? null,
    createdAt: scenario.createdAt ?? null,
    expected: scenario.expected ?? {},
    failure: scenario.failure ?? null,
    // npm's lifecycle status for the staged version, served by the fake
    // registry's version-status endpoint. Null means the endpoint 404s, which
    // is the realistic default: npm answers the same way for a version it does
    // not know and one the token may not ask about.
    versionStatus: scenario.versionStatus ?? null,
    staged: {
      version: stagedManifest.version,
      manifest: stagedManifest,
      tarballFile: stagedPack.filename,
      // A scenario may pin the digest the stage record advertises so the
      // fixture can serve real tarball bytes that do not hash to it — the
      // truncated/substituted-download case the staged-tarball verification
      // exists to catch.
      shasum: scenario.staged.shasum ?? stagedPack.shasum ?? null,
      integrity: stagedPack.integrity ?? null,
    },
    previous:
      previousManifest && previousPack
        ? {
            version: previousManifest.version,
            tag: scenario.previous.tag ?? "latest",
            publishedAt: scenario.previous.publishedAt ?? null,
            manifest: previousManifest,
            tarballFile: previousPack.filename,
            shasum: previousPack.shasum ?? null,
            integrity: previousPack.integrity ?? null,
          }
        : null,
  });
}

// Public packages served without a token: releases the publication monitor
// observes on public npm. A version with no `publishedAt` gets its registry
// timestamp on the first packument lookup, so a test can publish it after it
// enrolls the watch; a fixed one is history from before any watch existed.
const publicPackageFixtures = [
  [{ directory: "publication-monitor", publishedAt: null }],
  [
    { directory: "post-release-review/1.0.0", publishedAt: "2020-01-01T00:00:00.000Z" },
    { directory: "post-release-review/1.1.0", publishedAt: null },
  ],
];

const publicPackages = [];
for (const releases of publicPackageFixtures) {
  const versions = [];
  for (const release of releases) {
    const packageDir = path.join(repoRoot, "test/e2e-fixtures", release.directory);
    const manifest = await readJson(path.join(packageDir, "package.json"));
    const packed = await assertPortableTarball(
      packPackage(packageDir, tarballRoot),
      `public ${release.directory}`,
    );
    versions.push({
      version: manifest.version,
      manifest,
      tarballFile: packed.filename,
      shasum: packed.shasum,
      integrity: packed.integrity,
      publishedAt: release.publishedAt,
    });
  }
  const name = versions[0].manifest.name;
  for (const entry of versions) assertEqual(name, entry.manifest.name, `${name} public version`);
  publicPackages.push({ name, versions });
}

await writeFile(
  path.join(outputRoot, "registry.json"),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      scenarios,
      publicPackages,
    },
    null,
    2,
  ),
);

console.log(`Built ${scenarios.length} E2E registry scenario(s) in ${relative(outputRoot)}`);

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function packPackage(packageDir, destination) {
  const result = spawnSync(
    "npm",
    ["pack", "--ignore-scripts", "--json", "--pack-destination", destination],
    {
      cwd: packageDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `npm pack failed in ${relative(packageDir)}\n${result.stdout}\n${result.stderr}`,
    );
  }

  const stdout = result.stdout.trim();
  const start = stdout.indexOf("[");
  const end = stdout.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`npm pack did not return JSON in ${relative(packageDir)}:\n${stdout}`);
  }

  const [packed] = JSON.parse(stdout.slice(start, end + 1));
  if (!packed?.filename) {
    throw new Error(`npm pack returned no filename in ${relative(packageDir)}`);
  }
  return packed;
}

async function maybeRewritePackageJson(packed, packageJsonText, label) {
  if (typeof packageJsonText !== "string") return packed;
  const tarballPath = path.join(tarballRoot, packed.filename);
  const workDir = path.join(outputRoot, "tarball-work", label.replace(/[^a-z0-9_-]/gi, "-"));
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });

  runTar(["-xzf", tarballPath, "-C", workDir], label);
  await writeFile(path.join(workDir, "package/package.json"), packageJsonText);
  runTar(["-czf", tarballPath, "-C", workDir, "package"], label);

  const bytes = await readFile(tarballPath);
  const size = (await stat(tarballPath)).size;
  return {
    ...packed,
    size,
    shasum: createHash("sha1").update(bytes).digest("hex"),
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
  };
}

// Every extracted file here picks up `com.apple.provenance`, and macOS tar
// writes a file's extended attributes back out twice: as an AppleDouble
// `._name` member (suppressed by COPYFILE_DISABLE) and as pax `*.xattr.*`
// records (suppressed by --no-xattrs). Without both, the repacked tarball
// differs by build host — on macOS it gained a bare `._package` member, which
// the tar rules score `high` as a parser differential, so the
// invalid-package-json scenario graded `high` locally and `medium` on Linux
// CI. GNU tar ignores the variable and defaults the flag off.
function runTar(args, label) {
  const result = spawnSync("tar", ["--no-xattrs", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  if (result.status !== 0) {
    throw new Error(`tar failed for ${label}\n${result.stdout}\n${result.stderr}`);
  }
}

// A fixture tarball is evidence the scanner grades, so a member the packing
// host slipped in is a finding the scenario never declared. Checked for every
// tarball, not just repacked ones: npm's always-ignored list already drops
// `._*` and `.DS_Store` from a pack, but the repack path has no such rule and
// the fixture's guarantee should not depend on which path produced it. The
// check is over member names — it does not make the bytes identical to an
// `npm pack` (the repack also writes an explicit `package/` directory entry,
// which npm does not, and which the tar rules keep at `info`).
async function assertPortableTarball(packed, label) {
  const tarballPath = path.join(tarballRoot, packed.filename);
  let names;
  try {
    names = tarballEntryNames(await readFile(tarballPath));
  } catch (cause) {
    throw new Error(`${label} tarball could not be read from ${relative(tarballPath)}`, { cause });
  }
  const hostEntries = hostMetadataTarEntries(names);
  if (hostEntries.length) {
    throw new Error(
      `${label} tarball carries packing-host metadata entries: ${hostEntries.join(", ")}\n` +
        "npm does not publish these and the scanner grades them, so the fixture would " +
        "assert findings that describe the build machine rather than the package. " +
        "The builder already packs with COPYFILE_DISABLE=1 and --no-xattrs, so this is " +
        "stray material in the scenario directory or a packing host that needs another " +
        "opt-out here — not something to assert in scenario.json.",
    );
  }
  return packed;
}

function assertEqual(expected, actual, label) {
  if (expected !== actual) {
    throw new Error(`${label} mismatch: expected ${expected}, got ${actual}`);
  }
}

function relative(filePath) {
  return path.relative(repoRoot, filePath) || ".";
}
