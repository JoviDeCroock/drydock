import { spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
for (const name of scenarioNames) {
  const scenarioDir = path.join(scenariosRoot, name);
  const scenario = await readJson(path.join(scenarioDir, "scenario.json"));
  const stagedPackageDir = path.join(scenarioDir, scenario.staged.directory);
  const previousPackageDir = path.join(scenarioDir, scenario.previous.directory);
  const stagedManifest = await readJson(path.join(stagedPackageDir, "package.json"));
  const previousManifest = await readJson(path.join(previousPackageDir, "package.json"));

  assertEqual(scenario.packageName, stagedManifest.name, `${name} staged package name`);
  assertEqual(scenario.packageName, previousManifest.name, `${name} previous package name`);

  const stagedPack = packPackage(stagedPackageDir, tarballRoot);
  const previousPack = packPackage(previousPackageDir, tarballRoot);

  scenarios.push({
    name,
    stageId: scenario.stageId,
    packageName: scenario.packageName,
    tag: scenario.tag ?? "latest",
    access: scenario.access ?? null,
    actor: scenario.actor ?? null,
    actorType: scenario.actorType ?? null,
    createdAt: scenario.createdAt ?? null,
    expected: scenario.expected ?? {},
    staged: {
      version: stagedManifest.version,
      manifest: stagedManifest,
      tarballFile: stagedPack.filename,
      shasum: stagedPack.shasum ?? null,
      integrity: stagedPack.integrity ?? null,
    },
    previous: {
      version: previousManifest.version,
      tag: scenario.previous.tag ?? "latest",
      publishedAt: scenario.previous.publishedAt ?? null,
      manifest: previousManifest,
      tarballFile: previousPack.filename,
      shasum: previousPack.shasum ?? null,
      integrity: previousPack.integrity ?? null,
    },
  });
}

await writeFile(
  path.join(outputRoot, "registry.json"),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      scenarios,
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

function assertEqual(expected, actual, label) {
  if (expected !== actual) {
    throw new Error(`${label} mismatch: expected ${expected}, got ${actual}`);
  }
}

function relative(filePath) {
  return path.relative(repoRoot, filePath) || ".";
}
