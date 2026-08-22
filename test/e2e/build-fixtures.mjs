import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
// Standalone packages published to the fake registry without a stage record —
// the third-party dependencies a scenario's staged release newly declares. They
// are served anonymously, exactly as a public registry serves a package nobody
// is authenticated for.
const registryDependencies = [];
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

  for (const dependency of scenario.dependencies ?? []) {
    const dependencyDir = path.join(scenarioDir, dependency.directory);
    const dependencyManifest = await readJson(path.join(dependencyDir, "package.json"));
    const dependencyPack = packPackage(dependencyDir, tarballRoot);
    registryDependencies.push({
      packageName: dependencyManifest.name,
      version: dependencyManifest.version,
      tag: dependency.tag ?? "latest",
      publishedAt: dependency.publishedAt ?? null,
      manifest: dependencyManifest,
      tarballFile: dependencyPack.filename,
      shasum: dependencyPack.shasum ?? null,
      integrity: dependencyPack.integrity ?? null,
    });
  }

  const stagedPack = await maybeRewritePackageJson(
    packPackage(stagedPackageDir, tarballRoot),
    scenario.staged.packageJsonText,
    `${name} staged`,
  );
  const previousPack = previousPackageDir ? packPackage(previousPackageDir, tarballRoot) : null;

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

await writeFile(
  path.join(outputRoot, "registry.json"),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      scenarios,
      dependencies: registryDependencies,
    },
    null,
    2,
  ),
);

console.log(
  `Built ${scenarios.length} E2E registry scenario(s) and ${registryDependencies.length} dependency package(s) in ${relative(outputRoot)}`,
);

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function packPackage(packageDir, destination) {
  const result = spawnSync("npm", ["pack", "--json", "--pack-destination", destination], {
    cwd: packageDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
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

function runTar(args, label) {
  const result = spawnSync("tar", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(`tar failed for ${label}\n${result.stdout}\n${result.stderr}`);
  }
}

function assertEqual(expected, actual, label) {
  if (expected !== actual) {
    throw new Error(`${label} mismatch: expected ${expected}, got ${actual}`);
  }
}

function relative(filePath) {
  return path.relative(repoRoot, filePath) || ".";
}
