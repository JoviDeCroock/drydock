import { createReadStream } from "node:fs";
import { appendFile, readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
const args = parseArgs(process.argv.slice(2));
const host = args.host || process.env.E2E_REGISTRY_HOST || "127.0.0.1";
const port = Number(args.port || process.env.E2E_REGISTRY_PORT || 5184);
const stateDir =
  args.stateDir ||
  process.env.E2E_REGISTRY_STATE_DIR ||
  path.join(repoRoot, ".context/e2e-registry");
const registryFile = path.join(stateDir, "registry.json");
const journalFile = path.join(stateDir, "requests.jsonl");
const tarballDir = path.join(stateDir, "tarballs");
const registry = JSON.parse(await readFile(registryFile, "utf8"));
const baseUrl = `http://${host}:${port}`;
const stageById = new Map(registry.scenarios.map((scenario) => [scenario.stageId, scenario]));
const packages = buildPackageMap(registry.scenarios);

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", baseUrl);
  const startedAt = Date.now();

  try {
    if (request.method !== "GET") {
      await send(request, response, startedAt, 405, { allow: "GET" }, "method not allowed");
      return;
    }

    if (url.pathname === "/__health") {
      await sendJson(request, response, startedAt, 200, {
        ok: true,
        scenarios: registry.scenarios.length,
      });
      return;
    }

    if (url.pathname === "/-/whoami") {
      if (!request.headers.authorization?.startsWith("Bearer ")) {
        await sendJson(request, response, startedAt, 401, { error: "missing bearer token" });
        return;
      }
      await sendJson(request, response, startedAt, 200, { username: "drydock-e2e" });
      return;
    }

    if (url.pathname === "/-/stage") {
      await sendStageList(request, response, startedAt, url);
      return;
    }

    const stagedTarballMatch = /^\/-\/stage\/([^/]+)\/tarball$/.exec(url.pathname);
    if (stagedTarballMatch) {
      const scenario = stageById.get(decodeURIComponent(stagedTarballMatch[1]));
      if (!scenario) {
        await sendJson(request, response, startedAt, 404, { error: "stage not found" });
        return;
      }
      await sendTarball(request, response, startedAt, scenario.staged.tarballFile);
      return;
    }

    const stagedViewMatch = /^\/-\/stage\/([^/]+)$/.exec(url.pathname);
    if (stagedViewMatch) {
      const scenario = stageById.get(decodeURIComponent(stagedViewMatch[1]));
      if (!scenario) {
        await sendJson(request, response, startedAt, 404, { error: "stage not found" });
        return;
      }
      await sendJson(request, response, startedAt, 200, stageDetails(scenario));
      return;
    }

    const decodedPath = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    const tarballMatch = /^(@[^/]+\/[^/]+|[^/]+)\/-\/([^/]+\.tgz)$/.exec(decodedPath);
    if (tarballMatch) {
      const packageName = tarballMatch[1];
      const tarballFile = tarballMatch[2];
      const packument = packages.get(packageName);
      const known = Object.values(packument?.versions ?? {}).some(
        (version) => version.tarballFile === tarballFile,
      );
      if (!known) {
        await sendJson(request, response, startedAt, 404, { error: "tarball not found" });
        return;
      }
      await sendTarball(request, response, startedAt, tarballFile);
      return;
    }

    const packument = packages.get(decodedPath);
    if (packument) {
      await sendJson(request, response, startedAt, 200, renderPackument(packument));
      return;
    }

    await sendJson(request, response, startedAt, 404, { error: "not found" });
  } catch (err) {
    await sendJson(request, response, startedAt, 500, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

server.listen(port, host, () => {
  console.log(JSON.stringify({ event: "fake-registry-ready", url: baseUrl, stateDir }));
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));

function buildPackageMap(scenarios) {
  const byPackage = new Map();
  for (const scenario of scenarios) {
    const packument = byPackage.get(scenario.packageName) ?? {
      name: scenario.packageName,
      distTags: {},
      versions: {},
      times: {},
    };
    packument.distTags[scenario.previous.tag || scenario.tag || "latest"] =
      scenario.previous.version;
    packument.versions[scenario.previous.version] = scenario.previous;
    if (scenario.previous.publishedAt) {
      packument.times[scenario.previous.version] = scenario.previous.publishedAt;
    }
    byPackage.set(scenario.packageName, packument);
  }
  return byPackage;
}

function renderPackument(packument) {
  const versions = {};
  for (const [version, entry] of Object.entries(packument.versions)) {
    versions[version] = {
      ...entry.manifest,
      dist: {
        tarball: `${baseUrl}/${encodePackageName(packument.name)}/-/${entry.tarballFile}`,
        shasum: entry.shasum,
        integrity: entry.integrity,
      },
    };
  }
  return {
    name: packument.name,
    "dist-tags": packument.distTags,
    versions,
    time: packument.times,
  };
}

function stageListItem(scenario) {
  return {
    id: scenario.stageId,
    packageName: scenario.packageName,
    version: scenario.staged.version,
    tag: scenario.tag,
    access: scenario.access,
    actor: scenario.actor,
    actorType: scenario.actorType,
    createdAt: scenario.createdAt,
    shasum: scenario.staged.shasum,
  };
}

function stageDetails(scenario) {
  return {
    ...stageListItem(scenario),
    manifest: scenario.staged.manifest,
    packageJson: scenario.staged.manifest,
  };
}

async function sendStageList(request, response, startedAt, url) {
  const packageFilter = url.searchParams.get("package");
  const perPage = Math.max(1, Math.min(100, Number(url.searchParams.get("perPage") || "25")));
  const items = registry.scenarios
    .filter((scenario) => !packageFilter || scenario.packageName === packageFilter)
    .map(stageListItem)
    .slice(0, perPage);

  await sendJson(request, response, startedAt, 200, {
    items,
    total: items.length,
    perPage,
    page: 1,
  });
}

async function sendTarball(request, response, startedAt, tarballFile) {
  const filePath = path.join(tarballDir, tarballFile);
  const fileStat = await stat(filePath);
  const range = parseRange(request.headers.range, fileStat.size);
  const headers = {
    "accept-ranges": "bytes",
    "content-type": "application/octet-stream",
  };

  if (range) {
    response.writeHead(206, {
      ...headers,
      "content-length": String(range.end - range.start + 1),
      "content-range": `bytes ${range.start}-${range.end}/${fileStat.size}`,
    });
    createReadStream(filePath, { start: range.start, end: range.end }).pipe(response);
    await record(request, startedAt, 206);
    return;
  }

  response.writeHead(200, {
    ...headers,
    "content-length": String(fileStat.size),
  });
  createReadStream(filePath).pipe(response);
  await record(request, startedAt, 200);
}

async function sendJson(request, response, startedAt, status, value) {
  await send(
    request,
    response,
    startedAt,
    status,
    { "content-type": "application/json; charset=utf-8" },
    JSON.stringify(value, null, 2),
  );
}

async function send(request, response, startedAt, status, headers, body) {
  response.writeHead(status, headers);
  response.end(body);
  await record(request, startedAt, status);
}

async function record(request, startedAt, status) {
  const entry = {
    at: new Date().toISOString(),
    method: request.method,
    path: request.url,
    authorization: request.headers.authorization ? "present" : "absent",
    range: request.headers.range ?? null,
    status,
    durationMs: Date.now() - startedAt,
  };
  await appendFile(journalFile, `${JSON.stringify(entry)}\n`);
}

function parseRange(value, size) {
  if (!value) return null;
  const match = /^bytes=(\d+)-(\d*)$/.exec(value);
  if (!match) return null;
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isInteger(start) || !Number.isInteger(requestedEnd) || start >= size) return null;
  return { start, end: Math.min(requestedEnd, size - 1) };
}

function encodePackageName(packageName) {
  return encodeURIComponent(packageName).replace(/^%40/, "@");
}

function parseArgs(rawArgs) {
  const parsed = {};
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    parsed[key] = rawArgs[index + 1];
    index += 1;
  }
  return parsed;
}
