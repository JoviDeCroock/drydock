// Detonation harness: the only process in this container that runs as root.
// It installs one package tarball, then runs that package's code as the
// unprivileged `pkg` user under strace and reports what it did.
//
// Trust boundary: everything under /work/app and /home/pkg, the hook logs, and
// every byte of package metadata is attacker-controlled. Trace files live in a
// root-only directory so package code cannot edit the syscall record, and the
// HTTP server stops listening before any package code runs so the package
// cannot talk to the harness.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import readline from "node:readline";
import {
  createStepEventBuffer,
  fitEvents,
  MAX_REPORT_BYTES,
  MAX_REPORT_EVENTS,
} from "./event-budget.mjs";
import { plantCanaryFiles } from "./canary-files.mjs";
import { isBrowserTargeted } from "./manifest.mjs";
import {
  BUILD_ENV,
  BUILD_OUT,
  BUILD_SYSTEM_READER,
  decodePyPiBundle,
  DIST_DIR,
  findDistInfo,
  INSTALLER_PYTHON,
  narrowBuildSystem,
  OBSERVER_PTH,
  OBSERVER_PTH_NAME,
  parseEntryPoints,
  PIP_CACHE,
  planPyPiSteps,
  PYPI_INDEX,
  requiresDist,
  RUN_DIR,
  SDIST_DIR,
  SYSTEM_PYTHON,
  topLevelModules,
  VENV_DIR,
  VENV_PYTHON,
  wheelIdentity,
} from "./pypi.mjs";
import {
  boundEvent,
  createTraceReader,
  HOOK_LOG_DIR,
  isNoiseEvent,
  normalizePath,
} from "./trace-parse.mjs";

/** @typedef {import("../../server/lib/detonation/types.ts").HarnessEvent} HarnessEvent */
/** @typedef {import("../../server/lib/detonation/types.ts").HarnessReport} HarnessReport */
/** @typedef {import("../../server/lib/detonation/types.ts").HarnessStepResult} HarnessStepResult */
/** @typedef {import("../../server/lib/detonation/types.ts").HarnessCoverage} HarnessCoverage */
/** @typedef {import("../../server/lib/detonation/types.ts").DetonationStep} DetonationStep */

const VERSION = 1;
const PORT = 8080;
const PKG_UID = 10001;
const PKG_GID = 10001;
const PKG_HOME = "/home/pkg";
const WORK_DIR = "/work";
const APP_DIR = "/work/app";
const NODE_MODULES = "/work/app/node_modules";
const TARBALL = "/work/pkg.tgz";
const NPM_CACHE = "/work/npm-cache";
const TRACE_DIR = "/run/drydock-trace";
const OBSERVER = "/opt/drydock/observe.cjs";
const NODE = process.execPath;
const CF_CA_SOURCE = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";
const CF_CA_INSTALLED = "/usr/local/share/ca-certificates/cloudflare-containers-ca.crt";

const MAX_TARBALL_BYTES = 32 * 1024 * 1024;
const MAX_DETONATE_BODY_BYTES = 1024 * 1024;
const MAX_TRACE_BYTES = 32 * 1024 * 1024;
// A package can fill its trace with junk to make parsing outlast the parent's
// response window (`HARNESS_RESPONSE_GRACE_MS`, 30s past the detonate budget),
// which would lose every step's events. Parsing stops at these bounds instead
// and the report is marked truncated.
const STEP_PARSE_MS = 10_000;
const REPORT_GRACE_MS = 15_000;
const MAX_HOOK_LOG_BYTES = 8 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_PACKAGES = 2000;
const MAX_BINS = 8;
const MAX_TIMEOUT_MS = 10 * 60 * 1000;
// Dependencies run first, so without a cap six slow dependency postinstalls
// would spend the whole budget and the reviewed package would never run.
const DEPENDENCY_BUDGET_SHARE = 0.4;
// The parent keeps 200 steps; the reviewed package's own steps fit in the rest.
const MAX_DEPENDENCY_STEPS = 180;
const INSTALL_TIMEOUT_MS = 120_000;
// Lets a double-forked background process show itself before it is killed.
const BACKGROUND_GRACE_MS = 2000;
const LIFECYCLE_EVENTS = ["preinstall", "install", "postinstall"];
const BASE_PATH = "/work/app/node_modules/.bin:/usr/local/bin:/usr/bin:/bin";
const PACKAGE_NAME_RE = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i;
const BIN_NAME_RE = /^[A-Za-z0-9_@+-][A-Za-z0-9._@+-]*$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// `strace -u` needs CAP_SYS_PTRACE because it seizes a child that already has
// another uid. Tracing a root `setpriv` that then drops to `pkg` does not, and
// the tracer stays attached across the uid change and every later fork.
//
// Root-run binaries are absolute paths: a step's env carries the package's
// PATH (`node_modules/.bin`, the venv's `bin`), which the package can write,
// so a bare name would let it plant a `setpriv` or `strace` that runs as root.
const STRACE = "/usr/bin/strace";
const DROP_PRIVILEGES = [
  "/usr/bin/setpriv",
  `--reuid=${PKG_UID}`,
  `--regid=${PKG_GID}`,
  "--init-groups",
  "--no-new-privs",
  "--",
];
const STRACE_ARGS = [
  "-f",
  "-qq",
  // fd arguments carry their path (`AT_FDCWD</home/pkg>`), so relative and
  // dirfd-relative paths resolve to what the kernel actually opened.
  "-y",
  "-s",
  "256",
  "-e",
  "signal=none",
  "-e",
  "trace=execve,execveat,open,openat,creat,unlink,unlinkat,rename,renameat,renameat2,chmod,fchmodat,connect,chdir,fchdir,clone,clone3,fork,vfork",
];

// pip runs from the root-owned installer venv with `--target` into the run's
// site directory, so the installer's own interpreter never processes a `.pth`
// the package installed there. Budgets keep the whole PyPI prepare inside the
// parent's 150 s window.
const VENV_CREATE_TIMEOUT_MS = 10_000;
const PIP_INSTALL_TIMEOUT_MS = 60_000;
const PIP_NO_DEPS_TIMEOUT_MS = 15_000;
const SDIST_EXTRACT_TIMEOUT_MS = 10_000;
const BUILD_SYSTEM_TIMEOUT_MS = 5_000;
const BUILD_ENV_TIMEOUT_MS = 25_000;
const SYSTEM_CA_BUNDLE = "/etc/ssl/certs/ca-certificates.crt";
const PYPI_BASE_PATH = `${VENV_DIR}/bin:/usr/local/bin:/usr/bin:/bin`;

/**
 * @typedef {{
 *   distribution: string,
 *   installed: boolean,
 *   siteDir: string | null,
 *   modules: string[],
 *   entryPoints: { name: string, module: string, attr: string }[],
 *   build: { root: string, backend: string, backendPath: string[] } | null,
 *   buildUnplanned: boolean,
 * }} PyPiState
 */

const state = {
  /** @type {"npm" | "pypi"} */
  ecosystem: "npm",
  /** @type {PyPiState | null} */
  pypi: null,
  prepareStarted: false,
  prepared: false,
  detonateStarted: false,
  /** @type {string | null} */
  packageName: null,
  /** Directory name under node_modules the reviewed package was installed as. @type {string | null} */
  installName: null,
  /** @type {HarnessCoverage["dependencyInstall"]} */
  dependencyInstall: "failed",
  /** @type {string | null} */
  extraCaCerts: null,
  // Read right after `npm install --ignore-scripts`, before any package code
  // ran, so it is the manifest as published.
  browserTargeted: false,
};

const syscallTracing = probeTracing();
const npmVersion = readNpmVersion();

const server = http.createServer((req, res) => {
  handle(req, res).catch(() => {
    if (!res.headersSent) sendJson(res, 500, { error: "internal" });
    else res.destroy();
  });
});
server.listen(PORT, "0.0.0.0");
process.on("SIGTERM", () => process.exit(0));

/** @param {http.IncomingMessage} req @param {http.ServerResponse} res */
async function handle(req, res) {
  const url = req.url ?? "";
  if (req.method === "GET" && url === "/health") {
    sendJson(res, 200, { ok: true, version: VERSION, syscallTracing });
    return;
  }
  if (req.method === "POST" && url === "/prepare") {
    // Claimed synchronously so a concurrent second request sees it.
    if (state.prepareStarted) return sendJson(res, 409, { error: "already_prepared" });
    state.prepareStarted = true;
    const body = await readBody(req, MAX_TARBALL_BYTES);
    if (body === null) return sendJson(res, 413, { error: "too_large" });
    sendJson(res, 200, prepare(body));
    return;
  }
  if (req.method === "POST" && url === "/prepare-pypi") {
    if (state.prepareStarted) return sendJson(res, 409, { error: "already_prepared" });
    state.prepareStarted = true;
    state.ecosystem = "pypi";
    const body = await readBody(req, MAX_TARBALL_BYTES);
    if (body === null) return sendJson(res, 413, { error: "too_large" });
    const files = decodePyPiBundle(body);
    if (files === null) return sendJson(res, 400, { error: "invalid_bundle" });
    sendJson(res, 200, preparePyPi(files));
    return;
  }
  if (req.method === "POST" && url === "/detonate") {
    if (state.detonateStarted) return sendJson(res, 409, { error: "already_detonated" });
    if (!state.prepared) return sendJson(res, 409, { error: "not_prepared" });
    state.detonateStarted = true;
    // Package code can reach localhost:8080; stop listening before it runs.
    // This response still travels on the already-accepted connection.
    server.close();
    server.closeIdleConnections();
    const body = await readBody(req, MAX_DETONATE_BODY_BYTES);
    const request = body === null ? null : parseDetonateRequest(body);
    if (request === null) return sendJson(res, 400, { error: "invalid_request" });
    sendJson(res, 200, await detonate(request));
    return;
  }
  sendJson(res, 404, { error: "not_found" });
}

/** @param {http.ServerResponse} res @param {number} status @param {unknown} payload */
function sendJson(res, status, payload) {
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

/** @param {http.IncomingMessage} req @param {number} cap @returns {Promise<Buffer | null>} */
async function readBody(req, cap) {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > cap) {
    req.resume();
    return null;
  }
  /** @type {Buffer[]} */
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > cap) {
      req.resume();
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function probeTracing() {
  const result = spawnSync(
    STRACE,
    [...STRACE_ARGS, "-o", "/dev/null", ...DROP_PRIVILEGES, "/bin/true"],
    { stdio: "ignore", timeout: 10_000 },
  );
  return result.status === 0;
}

function readNpmVersion() {
  try {
    const manifest = fs.readFileSync("/usr/local/lib/node_modules/npm/package.json", "utf8");
    const version = JSON.parse(manifest).version;
    return typeof version === "string" ? version : "10.0.0";
  } catch {
    return "10.0.0";
  }
}

// Cloudflare intercepts container HTTPS with a per-instance CA; npm (prepare)
// and package code (detonate) must trust it or every TLS request fails.
function installCloudflareCa() {
  if (!fs.existsSync(CF_CA_SOURCE)) return;
  try {
    fs.copyFileSync(CF_CA_SOURCE, CF_CA_INSTALLED);
    fs.chmodSync(CF_CA_INSTALLED, 0o644);
    spawnSync("update-ca-certificates", [], { stdio: "ignore", timeout: 30_000 });
    state.extraCaCerts = CF_CA_INSTALLED;
  } catch {
    state.extraCaCerts = null;
  }
}

/** @param {Buffer} tarball @returns {import("../../server/lib/detonation/types.ts").HarnessPrepareResponse} */
function prepare(tarball) {
  installCloudflareCa();
  fs.mkdirSync(WORK_DIR, { recursive: true, mode: 0o755 });
  fs.mkdirSync(TRACE_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(TRACE_DIR, 0o700);
  fs.writeFileSync(TARBALL, tarball, { mode: 0o644 });

  const packageName = readTarballPackageName();
  state.packageName = packageName;
  if (packageName === null) {
    state.prepared = true;
    return { ok: false, packageName: null, dependencyInstall: "failed" };
  }

  fs.mkdirSync(APP_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(APP_DIR, "package.json"),
    `${JSON.stringify({ name: "drydock-detonation-app", version: "0.0.0", private: true }, null, 2)}\n`,
  );
  fs.mkdirSync(NPM_CACHE, { recursive: true });
  for (const dir of [APP_DIR, path.join(APP_DIR, "package.json"), NPM_CACHE, PKG_HOME]) {
    fs.chownSync(dir, PKG_UID, PKG_GID);
  }

  const install = spawnSync(
    DROP_PRIVILEGES[0],
    [
      ...DROP_PRIVILEGES.slice(1),
      "/usr/local/bin/npm",
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-package-lock",
      "--registry=https://registry.npmjs.org/",
      TARBALL,
    ],
    {
      cwd: APP_DIR,
      env: {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        HOME: PKG_HOME,
        USER: "pkg",
        npm_config_cache: NPM_CACHE,
        npm_config_update_notifier: "false",
        ...(state.extraCaCerts ? { NODE_EXTRA_CA_CERTS: state.extraCaCerts } : {}),
      },
      stdio: "ignore",
      timeout: INSTALL_TIMEOUT_MS,
      killSignal: "SIGKILL",
    },
  );
  killPackageUser();

  const installName = readInstallName(packageName);
  state.installName = installName;
  const installed = fs.existsSync(path.join(NODE_MODULES, installName, "package.json"));
  state.browserTargeted = isBrowserTargeted(
    readManifest(path.join(NODE_MODULES, installName, "package.json")),
  );
  /** @type {HarnessCoverage["dependencyInstall"]} */
  const dependencyInstall =
    install.status === 0 && installed ? "complete" : installed ? "partial" : "failed";
  state.dependencyInstall = dependencyInstall;
  state.prepared = true;
  return { ok: installed, packageName, dependencyInstall };
}

/**
 * Installs the reviewed wheel into a fresh venv's site directory and unpacks
 * the sdist, with no package code running: pip takes binary wheels only (an
 * sdist dependency would run its build backend), runs from the installer venv
 * so the target's `.pth` files never load into it, and the venv's own
 * interpreter is only started once, before anything is installed.
 *
 * @param {import("./pypi.mjs").BundleFile[]} files
 * @returns {import("../../server/lib/detonation/types.ts").HarnessPrepareResponse}
 */
function preparePyPi(files) {
  installCloudflareCa();
  fs.mkdirSync(WORK_DIR, { recursive: true, mode: 0o755 });
  fs.mkdirSync(TRACE_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(TRACE_DIR, 0o700);
  fs.mkdirSync(DIST_DIR, { recursive: true, mode: 0o755 });
  // Root-owned and empty: steps start here, so the package cannot plant a
  // module that shadows another in the working directory.
  fs.mkdirSync(RUN_DIR, { recursive: true, mode: 0o755 });
  for (const dir of [VENV_DIR, PIP_CACHE, BUILD_ENV, BUILD_OUT, SDIST_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.chownSync(dir, PKG_UID, PKG_GID);
  }
  fs.chownSync(PKG_HOME, PKG_UID, PKG_GID);
  for (const file of files) {
    fs.writeFileSync(path.join(DIST_DIR, file.name), file.bytes, { mode: 0o644 });
  }
  const wheel = files.find((file) => file.kind === "wheel") ?? null;
  const sdist = files.find((file) => file.kind === "sdist") ?? null;
  const identity = wheel ? wheelIdentity(wheel.name) : null;

  /** @type {PyPiState} */
  const info = {
    distribution: identity?.name ?? sdistDistribution(sdist?.name ?? "") ?? "package",
    installed: false,
    siteDir: null,
    modules: [],
    entryPoints: [],
    build: null,
    buildUnplanned: false,
  };
  state.pypi = info;
  state.packageName = info.distribution;
  state.installName = info.distribution;

  /** @type {HarnessCoverage["dependencyInstall"]} */
  let dependencyInstall = "failed";
  const siteDir = createVenv();
  if (wheel && identity && siteDir) {
    info.siteDir = siteDir;
    const wheelPath = path.join(DIST_DIR, wheel.name);
    // The wheel goes in alone, then only its index-resolvable dependencies
    // (see `requiresDist`). A dependency with no binary wheel fails that
    // second resolution; the reviewed wheel still runs its own code.
    runPip(["--no-deps", wheelPath], siteDir, PIP_NO_DEPS_TIMEOUT_MS);
    const distInfo = findDistInfo(safeReaddir(siteDir), identity);
    info.installed = distInfo !== null;
    if (distInfo !== null) {
      const deps = requiresDist(readTextHead(path.join(siteDir, distInfo, "METADATA")));
      const depsInstalled =
        deps.requirements.length === 0 ||
        runPip(
          ["--only-binary", ":all:", ...deps.requirements],
          siteDir,
          PIP_INSTALL_TIMEOUT_MS,
        ) === 0;
      dependencyInstall = depsInstalled && deps.dropped === 0 ? "complete" : "partial";
      info.modules = topLevelModules(
        readSmallText(path.join(siteDir, distInfo, "RECORD")),
        identity.name,
      );
      info.entryPoints = parseEntryPoints(
        readSmallText(path.join(siteDir, distInfo, "entry_points.txt")),
      );
    }
  }

  if (sdist) {
    const root = extractSdist(path.join(DIST_DIR, sdist.name));
    if (root !== null) {
      const buildSystem = narrowBuildSystem(readBuildSystem(path.join(root, "pyproject.toml")));
      if (buildSystem.backend) {
        const requirementsReady =
          buildSystem.requires.length === 0 ||
          runPip(
            ["--only-binary", ":all:", ...buildSystem.requires],
            BUILD_ENV,
            BUILD_ENV_TIMEOUT_MS,
          ) === 0;
        info.build = {
          root,
          backend: buildSystem.backend,
          backendPath: buildSystem.backendPath,
        };
        // Without a wheel the build is the whole run, so its environment is
        // what "dependency install" describes.
        if (!wheel) dependencyInstall = requirementsReady ? "complete" : "partial";
      } else {
        info.buildUnplanned = true;
      }
    } else {
      info.buildUnplanned = true;
    }
  }
  killPackageUser();

  state.dependencyInstall = dependencyInstall;
  state.prepared = true;
  const ok = info.installed || info.build !== null;
  return { ok, packageName: info.distribution, dependencyInstall };
}

/**
 * Root writes the observer's `.pth` into the site directory after prepare and
 * before any step. `O_EXCL` refuses a name the wheel already installed.
 *
 * @param {string} siteDir
 */
function installPythonObserver(siteDir) {
  try {
    fs.writeFileSync(path.join(siteDir, OBSERVER_PTH_NAME), OBSERVER_PTH, {
      mode: 0o644,
      flag: "wx",
    });
  } catch {
    // Observation is best effort; strace remains the record.
  }
}

/** `name-1.0.tar.gz` → `name` (the version is everything after the last dash). @param {string} filename */
function sdistDistribution(filename) {
  const stem = filename.replace(/\.(tar\.gz|tgz)$/, "");
  const dash = stem.lastIndexOf("-");
  return dash > 0 ? stem.slice(0, dash) : null;
}

/** Creates the run's venv and returns its site directory. Nothing is installed in it yet. */
function createVenv() {
  const created = spawnSync(
    DROP_PRIVILEGES[0],
    [...DROP_PRIVILEGES.slice(1), SYSTEM_PYTHON, "-I", "-m", "venv", "--without-pip", VENV_DIR],
    {
      cwd: WORK_DIR,
      env: pythonPrepareEnv(),
      stdio: "ignore",
      timeout: VENV_CREATE_TIMEOUT_MS,
      killSignal: "SIGKILL",
    },
  );
  if (created.status !== 0) return null;
  const purelib = spawnSync(
    DROP_PRIVILEGES[0],
    [
      ...DROP_PRIVILEGES.slice(1),
      VENV_PYTHON,
      "-I",
      "-c",
      "import sys, sysconfig; sys.stdout.write(sysconfig.get_path('purelib'))",
    ],
    {
      cwd: WORK_DIR,
      env: pythonPrepareEnv(),
      stdio: ["ignore", "pipe", "ignore"],
      timeout: VENV_CREATE_TIMEOUT_MS,
      killSignal: "SIGKILL",
    },
  );
  const siteDir = purelib.status === 0 ? purelib.stdout.toString("utf8").trim() : "";
  return siteDir.startsWith(`${VENV_DIR}/`) && path.normalize(siteDir) === siteDir ? siteDir : null;
}

function pythonPrepareEnv() {
  return {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: PKG_HOME,
    USER: "pkg",
    LANG: "C.UTF-8",
    PIP_CONFIG_FILE: "/dev/null",
    PIP_DISABLE_PIP_VERSION_CHECK: "1",
    PIP_NO_INPUT: "1",
    // pip ships its own CA bundle, which does not hold Cloudflare's
    // interception CA; the system bundle does once it is installed.
    ...(state.extraCaCerts ? { PIP_CERT: SYSTEM_CA_BUNDLE, SSL_CERT_FILE: SYSTEM_CA_BUNDLE } : {}),
  };
}

/**
 * pip as the package user from the installer venv, into `target`, resolving
 * only from the public index. Returns the exit status.
 *
 * @param {string[]} args
 * @param {string} target
 * @param {number} timeoutMs
 */
function runPip(args, target, timeoutMs) {
  const result = spawnSync(
    DROP_PRIVILEGES[0],
    [
      ...DROP_PRIVILEGES.slice(1),
      INSTALLER_PYTHON,
      "-I",
      "-m",
      "pip",
      "install",
      "--no-input",
      "--disable-pip-version-check",
      "--no-warn-script-location",
      "--progress-bar",
      "off",
      "--cache-dir",
      PIP_CACHE,
      "--index-url",
      PYPI_INDEX,
      "--target",
      target,
      ...args,
    ],
    {
      cwd: WORK_DIR,
      env: pythonPrepareEnv(),
      stdio: "ignore",
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    },
  );
  killPackageUser();
  return result.status;
}

/**
 * Unpacks the sdist as the package user (GNU tar refuses `..` members and
 * defers symlinks) and returns its single top-level directory, or null.
 *
 * @param {string} archive
 */
function extractSdist(archive) {
  const result = spawnSync(
    DROP_PRIVILEGES[0],
    [
      ...DROP_PRIVILEGES.slice(1),
      "tar",
      "-xzf",
      archive,
      "-C",
      SDIST_DIR,
      "--no-same-owner",
      "--no-same-permissions",
    ],
    { stdio: "ignore", timeout: SDIST_EXTRACT_TIMEOUT_MS, killSignal: "SIGKILL" },
  );
  killPackageUser();
  if (result.status !== 0) return null;
  const roots = safeReaddir(SDIST_DIR).filter((entry) => {
    const stat = fs.lstatSync(path.join(SDIST_DIR, entry), { throwIfNoEntry: false });
    return stat?.isDirectory() ?? false;
  });
  return roots.length === 1 ? path.join(SDIST_DIR, roots[0]) : null;
}

/** @param {string} pyproject @returns {unknown} */
function readBuildSystem(pyproject) {
  const stat = fs.lstatSync(pyproject, { throwIfNoEntry: false });
  if (!stat) return null;
  if (!stat.isFile()) return {};
  const result = spawnSync(
    DROP_PRIVILEGES[0],
    [...DROP_PRIVILEGES.slice(1), SYSTEM_PYTHON, "-I", BUILD_SYSTEM_READER, pyproject],
    {
      cwd: WORK_DIR,
      env: pythonPrepareEnv(),
      stdio: ["ignore", "pipe", "ignore"],
      timeout: BUILD_SYSTEM_TIMEOUT_MS,
      maxBuffer: MAX_MANIFEST_BYTES,
      killSignal: "SIGKILL",
    },
  );
  if (result.status !== 0) return {};
  try {
    return JSON.parse(result.stdout.toString("utf8"));
  } catch {
    return {};
  }
}

/** A bounded read of an installed metadata file; missing or oversized reads as empty. @param {string} file */
function readSmallText(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) return "";
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/**
 * The first bytes of a regular file: wheel `METADATA` puts its headers before
 * a description of any length. `O_NOFOLLOW` refuses a symlink at open time.
 *
 * @param {string} file
 */
function readTextHead(file) {
  let fd = -1;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    if (!fs.fstatSync(fd).isFile()) return "";
    const buffer = Buffer.alloc(MAX_MANIFEST_BYTES);
    const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, read).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== -1) fs.closeSync(fd);
  }
}

// npm records the tarball under the dependency name it installed it as; that
// directory, not the manifest `name`, is how the parent attributes writes.
// Only npm has run so far (with --ignore-scripts), so the app manifest is
// still the harness's own.
/** @param {string} packageName */
function readInstallName(packageName) {
  const manifest = readManifest(path.join(APP_DIR, "package.json"));
  const dependencies = manifest?.dependencies;
  if (dependencies && typeof dependencies === "object") {
    for (const [name, spec] of Object.entries(dependencies)) {
      if (typeof spec !== "string" || !spec.endsWith(path.basename(TARBALL))) continue;
      if (name.length <= 214 && PACKAGE_NAME_RE.test(name)) return name;
    }
  }
  return packageName;
}

// The tarball is hostile; tar runs as `pkg` so a decompressor bug cannot act
// as root, and only the manifest is streamed to stdout (nothing is extracted).
function readTarballPackageName() {
  const read = (/** @type {string[]} */ args) =>
    spawnSync(DROP_PRIVILEGES[0], [...DROP_PRIVILEGES.slice(1), "tar", ...args], {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 30_000,
      maxBuffer: MAX_MANIFEST_BYTES,
      killSignal: "SIGKILL",
    });
  let manifest = read(["-xzOf", TARBALL, "--", "package/package.json"]);
  if (manifest.status !== 0) {
    // npm accepts any single top-level directory, not only `package/`.
    const listing = read(["-tzf", TARBALL]);
    const entry = listing.stdout
      ?.toString("utf8")
      .split("\n")
      .find((line) => /^[^/]+\/package\.json$/.test(line));
    if (!entry) return null;
    // The member name is tarball-derived and may start with `-`.
    manifest = read(["-xzOf", TARBALL, "--", entry]);
  }
  if (manifest.status !== 0 || !manifest.stdout) return null;
  try {
    const name = JSON.parse(manifest.stdout.toString("utf8")).name;
    return typeof name === "string" && name.length <= 214 && PACKAGE_NAME_RE.test(name)
      ? name
      : null;
  } catch {
    return null;
  }
}

/**
 * @typedef {{ version: 1, canaryEnv: Record<string, string>, canaryFiles: { path: string, content: string, mode: number }[], stepTimeoutMs: number, totalTimeoutMs: number }} DetonateRequest
 * @param {Buffer} body
 * @returns {DetonateRequest | null}
 */
function parseDetonateRequest(body) {
  let value;
  try {
    value = JSON.parse(body.toString("utf8"));
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || value.version !== VERSION) return null;
  const { canaryEnv, canaryFiles, stepTimeoutMs, totalTimeoutMs } = value;
  if (!canaryEnv || typeof canaryEnv !== "object" || Array.isArray(canaryEnv)) return null;
  for (const [key, val] of Object.entries(canaryEnv)) {
    if (!ENV_KEY_RE.test(key) || typeof val !== "string") return null;
  }
  if (!Array.isArray(canaryFiles)) return null;
  for (const file of canaryFiles) {
    if (!file || typeof file.path !== "string" || typeof file.content !== "string") return null;
    if (!path.isAbsolute(file.path) || path.normalize(file.path) !== file.path) return null;
    if (!Number.isInteger(file.mode) || file.mode < 0 || file.mode > 0o777) return null;
  }
  for (const ms of [stepTimeoutMs, totalTimeoutMs]) {
    if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0 || ms > MAX_TIMEOUT_MS) {
      return null;
    }
  }
  return { version: VERSION, canaryEnv, canaryFiles, stepTimeoutMs, totalTimeoutMs };
}

/** @param {DetonateRequest} request @returns {Promise<HarnessReport>} */
async function detonate(request) {
  const deadline = Date.now() + request.totalTimeoutMs;
  /** @type {HarnessStepResult[]} */
  const steps = [];
  const collector = createCollector();
  let runtimeHooks = false;

  let stepsSkipped = 0;

  const pypi = state.ecosystem === "pypi" ? state.pypi : null;
  const runnable = pypi
    ? pypi.installed || pypi.build !== null
    : state.installName !== null && state.dependencyInstall !== "failed";
  if (runnable) {
    plantCanaryFiles(request.canaryFiles, { home: PKG_HOME, uid: PKG_UID, gid: PKG_GID });
    fs.mkdirSync(HOOK_LOG_DIR, { recursive: true, mode: 0o755 });
    fs.chmodSync(HOOK_LOG_DIR, 0o755);

    /** @type {StepPlan[]} */
    let plans;
    if (pypi) {
      if (pypi.siteDir !== null && pypi.installed) installPythonObserver(pypi.siteDir);
      /** @type {Record<string, string>} */
      const pypiEnv = {
        ...request.canaryEnv,
        PATH: PYPI_BASE_PATH,
        HOME: PKG_HOME,
        USER: "pkg",
        LANG: "C.UTF-8",
        VIRTUAL_ENV: VENV_DIR,
        // Python's ssl and requests' certifi must trust Cloudflare's
        // interception CA, or an exfiltration attempt dies in the TLS
        // handshake before the egress boundary can read what it carried.
        ...(state.extraCaCerts
          ? { SSL_CERT_FILE: SYSTEM_CA_BUNDLE, REQUESTS_CA_BUNDLE: SYSTEM_CA_BUNDLE }
          : {}),
      };
      plans = planPyPiSteps(pypi, pypiEnv);
      if (pypi.buildUnplanned) stepsSkipped += 1;
    } else {
      /** @type {Record<string, string>} */
      const baseEnv = {
        ...request.canaryEnv,
        PATH: BASE_PATH,
        HOME: PKG_HOME,
        USER: "pkg",
        NODE_OPTIONS: `--require ${OBSERVER}`,
        ...(state.extraCaCerts ? { NODE_EXTRA_CA_CERTS: state.extraCaCerts } : {}),
      };
      plans = planSteps(
        /** @type {string} */ (state.installName),
        state.packageName ?? /** @type {string} */ (state.installName),
        baseEnv,
      );
    }

    const dependencyDeadline =
      Date.now() + Math.floor(request.totalTimeoutMs * DEPENDENCY_BUDGET_SHARE);
    let dependencySteps = 0;
    for (const plan of plans) {
      // The reviewed package's steps always start while any budget remains;
      // dependencies only within their share.
      const limit = plan.reviewed ? deadline : Math.min(deadline, dependencyDeadline);
      const remaining = limit - Date.now();
      if (remaining <= 0 || (!plan.reviewed && dependencySteps >= MAX_DEPENDENCY_STEPS)) {
        stepsSkipped += 1;
        continue;
      }
      if (!plan.reviewed) dependencySteps += 1;
      const outcome = await runStep(plan, Math.min(request.stepTimeoutMs, remaining));
      steps.push(outcome.result);
      runtimeHooks ||= outcome.hooksLoaded;
      await collector.addStep(
        plan,
        outcome,
        Math.min(Date.now() + STEP_PARSE_MS, deadline + REPORT_GRACE_MS),
      );
    }
  }

  /** @type {HarnessReport} */
  const report = {
    version: VERSION,
    coverage: {
      ...(state.ecosystem === "pypi" ? { ecosystem: /** @type {const} */ ("pypi") } : {}),
      syscallTracing,
      runtimeHooks,
      dependencyInstall: state.dependencyInstall,
      stepsSkipped,
      exercise: "load",
      browserTargeted: state.browserTargeted,
    },
    steps,
    events: [],
    truncated: false,
  };
  const envelopeBytes = Buffer.byteLength(JSON.stringify(report));
  const fitted = fitEvents(collector.events, {
    maxEvents: MAX_REPORT_EVENTS,
    maxBytes: MAX_REPORT_BYTES - envelopeBytes,
    preferred: (event) => collector.reviewedTargets.has(event.target),
  });
  report.events = fitted.events;
  report.truncated = collector.truncated || fitted.dropped > 0;
  return report;
}

/**
 * Targets name packages by their directory under node_modules (`foo` for an
 * aliased `"foo": "npm:bar@1"`), because that is the path the parent sees
 * writes land in.
 *
 * @typedef {{ step: DetonationStep, target: string, argv: string[], cwd: string, env: Record<string, string>, reviewed: boolean }} StepPlan
 * @param {string} installName
 * @param {string} packageName manifest name, which npm uses to name a string `bin`
 * @param {Record<string, string>} baseEnv
 * @returns {StepPlan[]}
 */
function planSteps(installName, packageName, baseEnv) {
  const targetDir = path.join(NODE_MODULES, installName);
  const packages = discoverPackages();
  // npm runs a dependency's scripts before its dependents'; deeper nesting is
  // the closest cheap approximation, and the reviewed package always goes last.
  packages.sort((a, b) => {
    const aTarget = a.dir === targetDir ? 1 : 0;
    const bTarget = b.dir === targetDir ? 1 : 0;
    return aTarget - bTarget || b.depth - a.depth || a.dir.localeCompare(b.dir);
  });

  /** @type {StepPlan[]} */
  const plans = [];
  for (const pkg of packages) {
    for (const event of LIFECYCLE_EVENTS) {
      const script = pkg.scripts[event];
      if (typeof script !== "string" || script.trim() === "") continue;
      plans.push({
        step: "lifecycle",
        target: `${pkg.installName}@${pkg.version}:${event}`,
        argv: ["/bin/sh", "-c", script],
        cwd: pkg.dir,
        reviewed: pkg.dir === targetDir,
        env: {
          ...baseEnv,
          npm_lifecycle_event: event,
          npm_lifecycle_script: script,
          npm_package_name: pkg.name,
          npm_package_version: pkg.version,
          npm_package_json: path.join(pkg.dir, "package.json"),
          npm_config_user_agent: `npm/${npmVersion} node/${process.version} linux ${process.arch} workspaces/false`,
          npm_node_execpath: NODE,
          INIT_CWD: APP_DIR,
        },
      });
    }
  }

  const spec = JSON.stringify(installName);
  plans.push({
    step: "require",
    target: `${installName}:require`,
    argv: [NODE, "-e", `require(${spec})`],
    cwd: APP_DIR,
    env: baseEnv,
    reviewed: true,
  });
  plans.push({
    step: "import",
    target: `${installName}:import`,
    argv: [NODE, "--input-type=module", "-e", `await import(${spec})`],
    cwd: APP_DIR,
    env: baseEnv,
    reviewed: true,
  });

  const target = packages.find((pkg) => pkg.dir === targetDir);
  for (const bin of target ? binNames(packageName, target.bin) : []) {
    const binPath = path.join(NODE_MODULES, ".bin", bin);
    if (!fs.existsSync(binPath)) continue;
    plans.push({
      step: "bin",
      target: `${installName}:bin:${bin}`,
      argv: [binPath, "--help"],
      cwd: APP_DIR,
      env: baseEnv,
      reviewed: true,
    });
  }
  return plans;
}

/** @param {string} packageName @param {unknown} bin @returns {string[]} */
function binNames(packageName, bin) {
  let names = [];
  if (typeof bin === "string") names = [packageName.replace(/^@[^/]+\//, "")];
  else if (bin && typeof bin === "object") names = Object.keys(bin);
  return names.filter((name) => BIN_NAME_RE.test(name)).slice(0, MAX_BINS);
}

/**
 * @typedef {{ dir: string, depth: number, installName: string, name: string, version: string, scripts: Record<string, unknown>, bin: unknown }} InstalledPackage
 * @returns {InstalledPackage[]}
 */
function discoverPackages() {
  /** @type {InstalledPackage[]} */
  const found = [];
  /** @param {string} nodeModules @param {number} depth */
  const walk = (nodeModules, depth) => {
    for (const entry of safeReaddir(nodeModules)) {
      if (found.length >= MAX_PACKAGES) return;
      if (entry.startsWith(".")) continue;
      const entryPath = path.join(nodeModules, entry);
      if (entry.startsWith("@")) {
        for (const scoped of safeReaddir(entryPath)) {
          if (!scoped.startsWith("."))
            visit(path.join(entryPath, scoped), `${entry}/${scoped}`, depth);
        }
      } else {
        visit(entryPath, entry, depth);
      }
    }
  };
  /** @param {string} dir @param {string} installName @param {number} depth */
  const visit = (dir, installName, depth) => {
    if (found.length >= MAX_PACKAGES) return;
    // Links (file:/workspace deps) could point anywhere, including back up the tree.
    const stat = fs.lstatSync(dir, { throwIfNoEntry: false });
    if (!stat?.isDirectory()) return;
    const manifest = readManifest(path.join(dir, "package.json"));
    if (manifest === null) return;
    found.push({
      dir,
      depth,
      installName: installName.slice(0, 214),
      name: clipString(manifest.name, 214) || installName.slice(0, 214),
      version: clipString(manifest.version, 64) || "0.0.0",
      scripts:
        manifest.scripts && typeof manifest.scripts === "object" ? { ...manifest.scripts } : {},
      bin: manifest.bin,
    });
    if (depth < 32) walk(path.join(dir, "node_modules"), depth + 1);
  };
  walk(NODE_MODULES, 0);
  return found;
}

/** @param {string} dir @returns {string[]} */
function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir).toSorted();
  } catch {
    return [];
  }
}

/** @param {string} file @returns {Record<string, any> | null} */
function readManifest(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) return null;
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** @param {unknown} value @param {number} max */
function clipString(value, max) {
  return typeof value === "string" ? value.slice(0, max) : "";
}

let stepCounter = 0;

/**
 * @param {StepPlan} plan
 * @param {number} timeoutMs
 * @returns {Promise<{ result: HarnessStepResult, traceFile: string | null, hookLog: string, hooksLoaded: boolean }>}
 */
async function runStep(plan, timeoutMs) {
  const id = stepCounter++;
  const hookLog = path.join(HOOK_LOG_DIR, `${id}.jsonl`);
  // Pre-created by root inside a root-owned directory: the package can append
  // to its own log but cannot swap it for a symlink to something else.
  fs.writeFileSync(hookLog, "", { mode: 0o600 });
  fs.chownSync(hookLog, PKG_UID, PKG_GID);
  const traceFile = syscallTracing ? path.join(TRACE_DIR, `${id}.trace`) : null;
  if (traceFile !== null) fs.writeFileSync(traceFile, "", { mode: 0o600 });

  const command = [...DROP_PRIVILEGES, ...plan.argv];
  if (traceFile !== null) command.unshift(STRACE, ...STRACE_ARGS, "-o", traceFile);

  const started = Date.now();
  const child = spawn(command[0], command.slice(1), {
    cwd: plan.cwd,
    env: { ...plan.env, DRYDOCK_HOOK_LOG: hookLog },
    detached: true,
    stdio: "ignore",
  });

  /** @type {Promise<{ code: number | null }>} */
  const exited = new Promise((resolve) => {
    child.once("exit", (code) => resolve({ code }));
    child.once("error", () => resolve({ code: null }));
  });

  const deadline = started + timeoutMs;
  let childDone = false;
  void exited.then(() => {
    childDone = true;
  });

  // Under strace the spawned process is the tracer, which only exits after
  // every traced descendant does; the step command is the first pid in the
  // trace, so poll it to learn when the step itself finished.
  /** @type {number | null} */
  let mainPid = null;
  /** @type {number | null} */
  let mainEndedAt = null;
  while (Date.now() < deadline) {
    if (childDone) {
      mainEndedAt = Date.now();
      break;
    }
    if (traceFile !== null) {
      mainPid ??= readFirstPid(traceFile);
      if (mainPid !== null && !processAlive(mainPid)) {
        mainEndedAt = Date.now();
        break;
      }
    }
    await Promise.race([exited, delay(50)]);
  }
  const timedOut = mainEndedAt === null;

  if (!timedOut) {
    const graceEnd = Date.now() + BACKGROUND_GRACE_MS;
    while (Date.now() < graceEnd && packageUserAlive()) await delay(100);
  }

  killPackageUser();
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // Group already gone.
    }
  }
  const { code } = await Promise.race([exited, delay(5000).then(() => ({ code: null }))]);
  killPackageUser();

  return {
    result: {
      step: plan.step,
      target: plan.target,
      exitCode: timedOut ? null : code,
      timedOut,
      durationMs: (mainEndedAt ?? Date.now()) - started,
    },
    traceFile,
    hookLog,
    hooksLoaded: hookLogLoaded(hookLog),
  };
}

/** @param {string} file @returns {number | null} */
function readFirstPid(file) {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buffer = Buffer.alloc(32);
      const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
      const match = /^(\d+)\s/.exec(buffer.subarray(0, read).toString("latin1"));
      return match ? Number(match[1]) : null;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** @param {number} pid */
function processAlive(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "latin1");
    const stateChar = stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
    return stateChar !== "Z" && stateChar !== "X";
  } catch {
    return false;
  }
}

// setsid() and double forks escape the step's process group, so the sweep is
// by uid. A few rounds catch processes forked while the previous round ran.
function killPackageUser() {
  for (let round = 0; round < 10; round += 1) {
    const live = livePackagePids();
    if (live.length === 0) return;
    spawnSync("pkill", ["-KILL", "-u", String(PKG_UID)], { stdio: "ignore", timeout: 5000 });
  }
}

function packageUserAlive() {
  return livePackagePids().length > 0;
}

// The harness is PID 1 and does not reap orphans, so killed package processes
// linger as zombies; pgrep would count them forever.
function livePackagePids() {
  /** @type {number[]} */
  const pids = [];
  for (const entry of safeReaddir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    let status;
    try {
      status = fs.readFileSync(`/proc/${entry}/status`, "latin1");
    } catch {
      continue;
    }
    const uid = /^Uid:\s+(\d+)/m.exec(status)?.[1];
    const procState = /^State:\s+(\S)/m.exec(status)?.[1];
    if (uid === String(PKG_UID) && procState !== "Z" && procState !== "X") pids.push(Number(entry));
  }
  return pids;
}

/** @param {number} ms */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** @param {string} hookLog */
function hookLogLoaded(hookLog) {
  try {
    const fd = fs.openSync(hookLog, "r");
    try {
      const buffer = Buffer.alloc(4096);
      const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
      return buffer.subarray(0, read).toString("utf8").includes('"kind":"loaded"');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

function createCollector() {
  /** @type {import("./event-budget.mjs").KeptEvent[]} */
  const events = [];
  /** Targets of the reviewed package's own steps, kept first when the report must shrink. */
  const reviewedTargets = new Set();
  let truncated = false;

  return {
    events,
    reviewedTargets,
    get truncated() {
      return truncated;
    },
    /**
     * Each step is bounded on its own, so a flood in one step costs only
     * that step's low-value events and never stops later steps from running.
     *
     * @param {StepPlan} plan
     * @param {{ traceFile: string | null, hookLog: string }} outcome
     * @param {number} stopAt epoch ms after which trace parsing gives up
     */
    async addStep(plan, outcome, stopAt) {
      if (plan.reviewed) reviewedTargets.add(plan.target);
      const buffer = createStepEventBuffer();
      /** @param {HarnessEvent} event */
      const add = (event) => {
        if (!isNoiseEvent(event)) buffer.add(event);
      };
      if (outcome.traceFile !== null) {
        const capped = await readTraceEvents(outcome.traceFile, plan, add, stopAt);
        if (capped) truncated = true;
      }
      readHookEvents(outcome.hookLog, plan, add);
      const kept = buffer.finish();
      if (kept.dropped > 0) truncated = true;
      events.push(...kept.events);
    },
  };
}

/**
 * @param {string} file
 * @param {StepPlan} plan
 * @param {(event: HarnessEvent) => void} add
 * @param {number} stopAt
 * @returns {Promise<boolean>} whether the trace was cut at the byte cap or the deadline
 */
async function readTraceEvents(file, plan, add, stopAt) {
  const size = fs.statSync(file).size;
  if (size === 0) return false;
  const stream = fs.createReadStream(file, {
    encoding: "utf8",
    end: Math.min(size, MAX_TRACE_BYTES) - 1,
  });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const reader = createTraceReader({ step: plan.step, target: plan.target, cwd: plan.cwd });
  let count = 0;
  let late = false;
  for await (const line of lines) {
    for (const event of reader.push(line)) add(event);
    count += 1;
    if (count % 1024 === 0 && Date.now() > stopAt) {
      late = true;
      break;
    }
  }
  for (const event of reader.flush()) add(event);
  return late || size > MAX_TRACE_BYTES;
}

/**
 * Hook lines are written by code running as the package user, so each one is
 * rebuilt field by field; step, target, and via always come from the harness.
 *
 * @param {string} file
 * @param {StepPlan} plan
 * @param {(event: HarnessEvent) => void} add
 */
function readHookEvents(file, plan, add) {
  let text;
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buffer = Buffer.alloc(Math.min(fs.fstatSync(fd).size, MAX_HOOK_LOG_BYTES));
      const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
      text = buffer.subarray(0, read).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return;
  }
  for (const line of text.split("\n")) {
    if (line === "") continue;
    let raw;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    const event = hookEvent(raw, plan);
    if (event === null) continue;
    // With strace attached the syscall record is authoritative; hooks add only
    // hostnames, which strace cannot see.
    if (syscallTracing && event.kind !== "dns") continue;
    add(event);
  }
}

/** @param {any} raw @param {StepPlan} plan @returns {HarnessEvent | null} */
function hookEvent(raw, plan) {
  if (!raw || typeof raw !== "object") return null;
  const pid = Number.isInteger(raw.pid) && raw.pid > 0 ? raw.pid : 0;
  const base = {
    step: plan.step,
    target: plan.target,
    pid,
    via: /** @type {const} */ ("runtime-hook"),
  };
  switch (raw.kind) {
    case "exec":
      if (typeof raw.path !== "string" || !Array.isArray(raw.argv)) return null;
      return boundEvent({
        ...base,
        kind: "exec",
        path: normalizePath(raw.path, null),
        argv: raw.argv.slice(0, 16).map((/** @type {unknown} */ arg) => String(arg)),
      });
    case "file":
      if (typeof raw.path !== "string") return null;
      if (!["read", "write", "create", "delete", "chmod", "rename"].includes(raw.op)) return null;
      return boundEvent({ ...base, kind: "file", op: raw.op, path: normalizePath(raw.path, null) });
    case "connect": {
      if (typeof raw.address !== "string") return null;
      if (!["inet", "inet6", "unix"].includes(raw.family)) return null;
      const port =
        Number.isInteger(raw.port) && raw.port >= 0 && raw.port <= 65535 ? raw.port : null;
      return boundEvent({
        ...base,
        kind: "connect",
        family: raw.family,
        address: raw.address,
        port,
      });
    }
    case "dns":
      if (typeof raw.hostname !== "string") return null;
      return boundEvent({ ...base, kind: "dns", hostname: raw.hostname });
    default:
      return null;
  }
}
