// Pure PyPI helpers for the detonation harness: decoding the prepare bundle,
// reading installed distribution metadata, and planning the steps that run
// package code. No I/O happens here; harness.mjs owns the filesystem and the
// processes, and the test suite drives these functions directly.
//
// Every name, module path, entry point, and build-system string read here comes
// from the package under review. Each one is checked against a strict grammar
// before it reaches an argv, and none is ever interpolated into code: the
// runner scripts receive them as separate arguments.
import { posix } from "node:path";

/** @typedef {import("../../server/lib/detonation/types.ts").DetonationStep} DetonationStep */

export const VENV_DIR = "/work/venv";
export const VENV_PYTHON = `${VENV_DIR}/bin/python`;
/** The image's own interpreter, which builds sdists outside the run's environment. */
export const SYSTEM_PYTHON = "/usr/bin/python3";
/** Root-owned venv holding pip; never sees the package's site directory. */
export const INSTALLER_PYTHON = "/opt/drydock/pyinstaller/bin/python";
const PY_HELPERS = "/opt/drydock/py";
export const RUNNER = `${PY_HELPERS}/run.py`;
export const BUILDER = `${PY_HELPERS}/build.py`;
export const BUILD_SYSTEM_READER = `${PY_HELPERS}/build_system.py`;
export const OBSERVER = `${PY_HELPERS}/observe.py`;
export const DIST_DIR = "/work/dist";
export const SDIST_DIR = "/work/sdist";
export const BUILD_ENV = "/work/build-env";
export const BUILD_OUT = "/work/build-out";
export const RUN_DIR = "/work/run";
export const PIP_CACHE = "/work/pip-cache";
export const PYPI_INDEX = "https://pypi.org/simple/";
/**
 * Loads the audit-hook observer before ordinary package `.pth` files: `site`
 * processes them in sorted order. A package can still name one to sort first,
 * or delete this one, like any runtime hook, so it only supplements strace.
 */
export const OBSERVER_PTH_NAME = "00-drydock-observe.pth";
export const OBSERVER_PTH = `import os; os.environ.get("DRYDOCK_HOOK_LOG") and exec(compile(open(${JSON.stringify(OBSERVER)}).read(), ${JSON.stringify(OBSERVER)}, "exec"), {"__name__": "_drydock_observe"})\n`;

/** PEP 517's fallback when a sdist declares no build system. */
const DEFAULT_BUILD_SYSTEM = Object.freeze({
  requires: ["setuptools>=40.8.0"],
  backend: "setuptools.build_meta:__legacy__",
  backendPath: [],
});

const MAX_HEADER_BYTES = 64 * 1024;
const MAX_FILENAME = 255;
const MAX_IMPORTS = 8;
const MAX_ENTRY_POINTS = 8;
const MAX_REQUIREMENTS = 32;
const MAX_REQUIREMENT_CHARS = 200;
const MAX_BACKEND_PATHS = 4;

// PEP 427 wheel and PEP 625 sdist filenames: no separators, no leading dot.
const WHEEL_NAME_RE =
  /^([A-Za-z0-9][A-Za-z0-9_.]*)-([A-Za-z0-9_.!+]+)(?:-[0-9][A-Za-z0-9_.]*)?-[A-Za-z0-9_.]+-[A-Za-z0-9_.]+-[A-Za-z0-9_.]+\.whl$/;
const SDIST_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.+!-]*\.(?:tar\.gz|tgz)$/;
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DOTTED_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const SCRIPT_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9._@+-]*$/;
// A name, optional extras, optional version specifiers, optional marker. No
// direct references (`@ url`) and nothing that pip would read as an option.
const REQUIREMENT_RE =
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?(?:\s*\[[A-Za-z0-9._,\s-]*\])?(?:\s*\(?\s*(?:===|~=|==|!=|<=|>=|<|>)\s*[A-Za-z0-9.*+!_-]+(?:\s*,\s*(?:===|~=|==|!=|<=|>=|<|>)\s*[A-Za-z0-9.*+!_-]+)*\s*\)?)?(?:\s*;[^@]*)?$/;

/**
 * @typedef {{ name: string, kind: "wheel" | "sdist", bytes: Buffer }} BundleFile
 * @param {Buffer} body
 * @returns {BundleFile[] | null}
 */
export function decodePyPiBundle(body) {
  if (body.length < 4) return null;
  const headerLength = body.readUInt32BE(0);
  if (headerLength === 0 || headerLength > MAX_HEADER_BYTES || 4 + headerLength > body.length) {
    return null;
  }
  let header;
  try {
    header = JSON.parse(body.subarray(4, 4 + headerLength).toString("utf8"));
  } catch {
    return null;
  }
  if (!header || header.version !== 1 || !Array.isArray(header.files)) return null;
  if (header.files.length === 0 || header.files.length > 2) return null;
  /** @type {BundleFile[]} */
  const files = [];
  const kinds = new Set();
  let offset = 4 + headerLength;
  for (const file of header.files) {
    if (!file || typeof file.name !== "string" || file.name.length > MAX_FILENAME) return null;
    if (file.kind !== "wheel" && file.kind !== "sdist") return null;
    if (kinds.has(file.kind)) return null;
    kinds.add(file.kind);
    const pattern = file.kind === "wheel" ? WHEEL_NAME_RE : SDIST_NAME_RE;
    if (!pattern.test(file.name)) return null;
    if (!Number.isSafeInteger(file.size) || file.size <= 0 || offset + file.size > body.length) {
      return null;
    }
    files.push({
      name: file.name,
      kind: file.kind,
      bytes: body.subarray(offset, offset + file.size),
    });
    offset += file.size;
  }
  return offset === body.length ? files : null;
}

/** PEP 503 normalization, as pip compares distribution names. @param {string} name */
function normalizeDistributionName(name) {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

/**
 * The distribution name and version a wheel filename declares.
 *
 * @param {string} filename
 * @returns {{ name: string, version: string } | null}
 */
export function wheelIdentity(filename) {
  const match = WHEEL_NAME_RE.exec(filename);
  return match ? { name: match[1], version: match[2] } : null;
}

/**
 * The installed `.dist-info` directory for a wheel, by normalized name and
 * exact version, among a site directory's entries.
 *
 * @param {string[]} entries
 * @param {{ name: string, version: string }} identity
 * @returns {string | null}
 */
export function findDistInfo(entries, identity) {
  const wanted = normalizeDistributionName(identity.name);
  for (const entry of entries) {
    if (!entry.endsWith(".dist-info")) continue;
    const stem = entry.slice(0, -".dist-info".length);
    const dash = stem.lastIndexOf("-");
    if (dash <= 0) continue;
    if (
      normalizeDistributionName(stem.slice(0, dash)) === wanted &&
      stem.slice(dash + 1) === identity.version
    ) {
      return entry;
    }
  }
  return null;
}

/**
 * Importable top-level names a distribution installed, read from its RECORD
 * (which pip wrote from the wheel's own listing). Startup hooks are excluded:
 * the `startup` step already ran them. The distribution's own name goes first
 * so it survives the cap.
 *
 * @param {string} recordText
 * @param {string} distributionName
 * @returns {string[]}
 */
export function topLevelModules(recordText, distributionName) {
  const names = new Set();
  for (const line of recordText.split("\n")) {
    const path = parseRecordPath(line);
    if (path === null || path.startsWith("/") || path.split("/").includes("..")) continue;
    const slash = path.indexOf("/");
    let name;
    if (slash === -1) {
      // `mod.py`, `mod.cpython-311-x86_64-linux-gnu.so`, `mod.abi3.so`.
      const module = /^([A-Za-z_][A-Za-z0-9_]*)(?:\.[A-Za-z0-9_-]+)*\.(?:py|so)$/.exec(path);
      if (!module) continue;
      name = module[1];
    } else {
      name = path.slice(0, slash);
      if (name.endsWith(".dist-info") || name.endsWith(".data") || name === "__pycache__") continue;
    }
    if (!IDENTIFIER_RE.test(name) || name === "sitecustomize" || name === "usercustomize") continue;
    names.add(name);
  }
  const own = normalizeDistributionName(distributionName).replaceAll("-", "_");
  return [...names]
    .sort(
      (a, b) =>
        Number(b.toLowerCase() === own) - Number(a.toLowerCase() === own) || a.localeCompare(b),
    )
    .slice(0, MAX_IMPORTS);
}

/** First CSV field of a RECORD line, honoring quotes. @param {string} line */
function parseRecordPath(line) {
  const trimmed = line.replace(/\r$/, "");
  if (trimmed === "") return null;
  if (!trimmed.startsWith('"')) {
    const comma = trimmed.indexOf(",");
    return comma === -1 ? trimmed : trimmed.slice(0, comma);
  }
  let out = "";
  for (let i = 1; i < trimmed.length; i += 1) {
    const char = trimmed[i];
    if (char === '"') {
      if (trimmed[i + 1] === '"') {
        out += '"';
        i += 1;
      } else {
        return out;
      }
    } else {
      out += char;
    }
  }
  return null;
}

/**
 * `console_scripts` and `gui_scripts` from `entry_points.txt`. Entries without
 * a callable, or whose module or attribute is not a plain dotted name, are
 * dropped.
 *
 * @param {string} text
 * @returns {{ name: string, module: string, attr: string }[]}
 */
export function parseEntryPoints(text) {
  /** @type {{ name: string, module: string, attr: string }[]} */
  const out = [];
  const seen = new Set();
  let section = "";
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      section = header[1].trim();
      continue;
    }
    if (section !== "console_scripts" && section !== "gui_scripts") continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const name = line.slice(0, eq).trim();
    // `module:attr [extra]` — extras only affect installation.
    const reference = line
      .slice(eq + 1)
      .replace(/\[[^\]]*\]\s*$/, "")
      .trim();
    const colon = reference.indexOf(":");
    if (colon === -1) continue;
    const module = reference.slice(0, colon).trim();
    const attr = reference.slice(colon + 1).trim();
    if (!SCRIPT_NAME_RE.test(name) || seen.has(name)) continue;
    if (!DOTTED_RE.test(module) || !DOTTED_RE.test(attr)) continue;
    seen.add(name);
    out.push({ name, module, attr });
    if (out.length >= MAX_ENTRY_POINTS) break;
  }
  return out;
}

/** @param {unknown} requirement */
export function isSafeRequirement(requirement) {
  return (
    typeof requirement === "string" &&
    requirement.length > 0 &&
    requirement.length <= MAX_REQUIREMENT_CHARS &&
    !requirement.includes("@") &&
    REQUIREMENT_RE.test(requirement.trim())
  );
}

/**
 * The wheel's own `Requires-Dist` entries pip should resolve from the index.
 *
 * The reviewed wheel is installed with `--no-deps` and these are installed in
 * a second, binary-only pip call: pip honours a direct reference
 * (`dep @ file:///…` or an sdist URL) in a local wheel's metadata even with
 * `--only-binary`, which would build an sdist, running its code untraced
 * during prepare. Extras-only requirements are not installed by default, so
 * they are skipped rather than counted as dropped.
 *
 * @param {string} metadataText the head of the installed `METADATA`
 * @returns {{ requirements: string[], dropped: number }}
 */
export function requiresDist(metadataText) {
  /** @type {string[]} */
  const requirements = [];
  let dropped = 0;
  for (const line of metadataText.split(/\r?\n/)) {
    // Headers end at the first blank line; the description follows.
    if (line.trim() === "") break;
    const match = /^Requires-Dist:\s*(.*)$/i.exec(line);
    if (!match) continue;
    const requirement = match[1].trim();
    if (/;[^;]*\bextra\b/.test(requirement)) continue;
    if (!isSafeRequirement(requirement) || requirements.length >= MAX_REQUIREMENTS) {
      dropped += 1;
      continue;
    }
    requirements.push(requirement);
  }
  return { requirements, dropped };
}

/**
 * The `[build-system]` table as `build_system.py` printed it, narrowed. A
 * missing table means the PEP 517 setuptools fallback; a malformed one, or a
 * requirement this harness will not hand to pip, leaves the build to run
 * without that requirement (its failure is then visible in the step's exit).
 *
 * @param {unknown} value
 * @returns {{ requires: string[], backend: string, backendPath: string[], dropped: number }}
 */
export function narrowBuildSystem(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...DEFAULT_BUILD_SYSTEM, requires: [...DEFAULT_BUILD_SYSTEM.requires], dropped: 0 };
  }
  const raw = /** @type {Record<string, unknown>} */ (value);
  const declared = typeof raw.backend === "string" && raw.backend !== "";
  const backend = declared ? String(raw.backend) : DEFAULT_BUILD_SYSTEM.backend;
  if (!isBackendReference(backend)) {
    return { requires: [], backend: "", backendPath: [], dropped: 0 };
  }
  const requiresRaw = Array.isArray(raw.requires)
    ? raw.requires
    : declared
      ? []
      : DEFAULT_BUILD_SYSTEM.requires;
  const requires = requiresRaw.filter(isSafeRequirement).slice(0, MAX_REQUIREMENTS);
  const backendPath = (Array.isArray(raw.backendPath) ? raw.backendPath : [])
    .filter(isSafeRelativePath)
    .slice(0, MAX_BACKEND_PATHS);
  return {
    requires: requires.map((requirement) => String(requirement).trim()),
    backend,
    backendPath: backendPath.map(String),
    dropped: requiresRaw.length - requires.length,
  };
}

/** `pkg.mod` or `pkg.mod:obj.attr`. @param {string} reference */
export function isBackendReference(reference) {
  const [module, attr, ...rest] = reference.split(":");
  return (
    rest.length === 0 &&
    reference.length <= 200 &&
    DOTTED_RE.test(module) &&
    (attr === undefined || DOTTED_RE.test(attr))
  );
}

/** A path inside the sdist (`backend-path` entries must not leave it). @param {unknown} value */
function isSafeRelativePath(value) {
  if (typeof value !== "string" || value === "" || value.length > 200) return false;
  if (value.includes("\0") || value.startsWith("/")) return false;
  const normalized = posix.normalize(value);
  return normalized !== ".." && !normalized.startsWith("../");
}

/**
 * @typedef {{ step: DetonationStep, target: string, argv: string[], cwd: string, env: Record<string, string>, reviewed: boolean }} StepPlan
 * @typedef {{
 *   distribution: string,
 *   installed: boolean,
 *   modules: string[],
 *   entryPoints: { name: string, module: string, attr: string }[],
 *   build: { root: string, backend: string, backendPath: string[] } | null,
 * }} PyPiRunInfo
 * @param {PyPiRunInfo} info
 * @param {Record<string, string>} baseEnv
 * @returns {StepPlan[]}
 */
export function planPyPiSteps(info, baseEnv) {
  const target = normalizeDistributionName(info.distribution);
  /** @type {StepPlan[]} */
  const plans = [];
  if (info.installed) {
    // A bare start runs every `.pth` and `sitecustomize` in the environment
    // without importing anything: the LiteLLM 1.107.0 `cook.pth` shape.
    plans.push({
      step: "startup",
      target: `${target}:startup`,
      argv: [VENV_PYTHON, "-c", "pass"],
      cwd: RUN_DIR,
      env: baseEnv,
      reviewed: true,
    });
    for (const module of info.modules) {
      plans.push({
        step: "import",
        target: `${target}:import:${module}`,
        argv: [VENV_PYTHON, "-P", RUNNER, "import", module],
        cwd: RUN_DIR,
        env: baseEnv,
        reviewed: true,
      });
    }
  }
  if (info.build && info.build.backend) {
    // The image's interpreter, not the run's environment: a frontend builds
    // in isolation, and the installed wheel's startup hooks must not be
    // credited to the build.
    plans.push({
      step: "build",
      target: `${target}:build`,
      argv: [
        SYSTEM_PYTHON,
        "-s",
        "-P",
        BUILDER,
        info.build.backend,
        JSON.stringify(info.build.backendPath),
        BUILD_OUT,
      ],
      cwd: info.build.root,
      env: { ...baseEnv, PYTHONPATH: BUILD_ENV },
      reviewed: true,
    });
  }
  if (info.installed) {
    for (const entry of info.entryPoints) {
      plans.push({
        step: "bin",
        target: `${target}:bin:${entry.name}`,
        argv: [VENV_PYTHON, "-P", RUNNER, "entry", entry.module, entry.attr, entry.name],
        cwd: RUN_DIR,
        env: baseEnv,
        reviewed: true,
      });
    }
  }
  return plans;
}
