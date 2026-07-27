import type { Finding, PackageJsonDiff, PackageJsonSummary } from "..";
import { firstJsonPropertyLine, tag } from "./helpers";
import type { RuleContext } from "./context";

// Entrypoint-surface rules derived from the package.json diff. The high-signal
// case is a newly added `bin` command: npm symlinks every bin entry into the
// consumer's node_modules/.bin, so a release that adds one puts a new command on
// the install path even when no install script or code pattern fires. Plain
// `main`/`exports` retargets are intentionally not flagged here: they change on
// almost every build (e.g. `index.js` -> `dist/index.js`) and would be noise.
export function entrypointDiffFindings(
  packageJsonDiff: PackageJsonDiff,
  stagedPackageJsonText?: string | null,
): Finding[] {
  const findings: Finding[] = [];
  for (const entry of packageJsonDiff.bin) {
    if (entry.status !== "added") continue;
    findings.push(
      tag("diffBinAdded", {
        severity: "medium",
        file: "package.json",
        line: firstJsonPropertyLine(stagedPackageJsonText, "bin", entry.staged),
        evidence: `bin ${entry.key}: ${entry.staged}`,
        reason:
          "npm links package bin entries into the consumer's node_modules/.bin, so a newly published executable puts a new command on the install path and should be reviewed before approving the release",
      }),
    );
  }
  return findings;
}

// Extensions a bare `main` may omit, in the order Node's CommonJS resolver
// tries them.
const IMPLICIT_EXTENSIONS = [".js", ".json", ".node", ".cjs", ".mjs"];
const DIRECTORY_INDEXES = IMPLICIT_EXTENSIONS.map((extension) => `index${extension}`);

interface DeclaredEntrypoint {
  /** Manifest field the path was declared in, for evidence. */
  field: string;
  /** package.json key to anchor the finding's line to. */
  key: string;
  path: string;
}

/**
 * A release whose manifest points at a file the artifact does not contain.
 *
 * This is the deterministic counterpart to the file diff: the diff can only say
 * "this path is not in the staged tarball", which reads as ordinary content
 * churn until someone notices the manifest still claims to ship it. `main`,
 * `exports`, and `bin` are the paths a consumer's runtime and npm's own install
 * actually resolve, so a release that declares one it does not ship is broken on
 * install at best, and at worst is a pack that lost its build output (or had it
 * removed) while the manifest kept advertising it — the shape of scan
 * 163a1e40-c049-4587-8525-85b4393d2eed, where a wasm binary and the `main`
 * entrypoint left the tarball and no deterministic rule fired.
 *
 * Resolution mirrors Node conservatively — exact path, implicit extension,
 * directory index, or any file under a directory-shaped target all count as
 * present — because a false "missing entrypoint" would accuse a healthy release
 * of being broken. Subpath patterns (`./*`) and non-path targets (bare
 * specifiers, `node:` builtins, URLs) are skipped for the same reason.
 */
export function entrypointPresenceFindings(ctx: RuleContext): Finding[] {
  const packageJson = ctx.packageJson;
  if (!packageJson) return [];
  // Without the manifest file in the artifact we are not looking at a normal
  // package layout (a metadata-only manifest, a partial parse), and every
  // declared path would read as missing. Stay quiet rather than guess.
  const files = new Set(ctx.files.map((file) => file.path));
  if (!files.has("package.json")) return [];

  const directories = new Set<string>();
  for (const file of ctx.files) {
    const segments = file.path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      directories.add(segments.slice(0, index).join("/"));
    }
  }

  const findings: Finding[] = [];
  const reported = new Set<string>();
  for (const declared of declaredEntrypoints(packageJson)) {
    if (reported.has(declared.path)) continue;
    if (resolvesToPackagedFile(declared.path, files, directories)) continue;
    reported.add(declared.path);
    // A path the previous release shipped and this one dropped is a release
    // regression with a known-good predecessor; one that was never there is a
    // manifest that has always over-claimed, which is worth surfacing but is
    // not evidence about this release's delta.
    const removed = ctx.diffByPath.get(declared.path)?.status === "removed";
    findings.push(
      tag("packageJsonEntrypointMissing", {
        severity: removed ? "high" : "medium",
        file: "package.json",
        line: firstJsonPropertyLine(ctx.packageJsonFile?.textSample, declared.key, declared.path),
        evidence: removed
          ? `${declared.field} ${declared.path} is not in this release (the previous version shipped it)`
          : `${declared.field} ${declared.path} is not in the package`,
        reason:
          "the manifest declares an entrypoint the published artifact does not contain, so the release cannot load as published: verify whether the file was dropped from the pack (a build that did not run, or a tampered artifact) or the manifest is stale",
      }),
    );
  }
  return findings;
}

function declaredEntrypoints(packageJson: PackageJsonSummary): DeclaredEntrypoint[] {
  const declared: DeclaredEntrypoint[] = [];
  const add = (field: string, key: string, value: unknown) => {
    const path = normalizeEntrypointPath(value);
    if (path) declared.push({ field, key, path });
  };

  add("main", "main", packageJson.main);

  const bin = packageJson.bin;
  if (typeof bin === "string") add("bin", "bin", bin);
  else if (bin && typeof bin === "object") {
    for (const [command, value] of Object.entries(bin)) add(`bin ${command}`, "bin", value);
  }

  for (const target of exportsTargets(packageJson.exports)) add("exports", "exports", target);

  return declared;
}

// Walk the `exports` tree collecting its string targets. Conditions and
// subpaths nest arbitrarily and arrays are fallback lists, so every string leaf
// is a candidate target; `null` leaves are deliberate blocks, not paths.
function exportsTargets(exports: unknown, depth = 0): string[] {
  if (depth > 8) return [];
  if (typeof exports === "string") return [exports];
  if (Array.isArray(exports)) return exports.flatMap((entry) => exportsTargets(entry, depth + 1));
  if (exports && typeof exports === "object") {
    return Object.values(exports as Record<string, unknown>).flatMap((entry) =>
      exportsTargets(entry, depth + 1),
    );
  }
  return [];
}

/**
 * Reduce a declared target to a package-relative path, or null when it is not a
 * path this rule can check: subpath patterns, protocol specifiers (`node:fs`,
 * `https://…`), package imports (`#dep`), bare package specifiers used as
 * fallbacks, and anything escaping the package root.
 */
function normalizeEntrypointPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let path = value.trim();
  if (!path || path.includes("*") || path.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(path)) {
    return null;
  }
  path = path.replace(/^\/+/, "");
  while (path.startsWith("./")) path = path.slice(2);
  if (!path || path.startsWith("../") || path.includes("/../")) return null;
  const segments = path.split("/").filter((segment) => segment && segment !== ".");
  if (!segments.length) return null;
  path = segments.join("/");
  // A bare specifier (`lodash`, `@scope/pkg`) is a dependency reference, not a
  // file in this package. Only a segmented path or something extension-shaped
  // is treated as a packaged file.
  if (!path.includes("/") && !/\.[a-z0-9]+$/i.test(path)) return null;
  return path;
}

function resolvesToPackagedFile(
  path: string,
  files: Set<string>,
  directories: Set<string>,
): boolean {
  if (files.has(path)) return true;
  if (IMPLICIT_EXTENSIONS.some((extension) => files.has(`${path}${extension}`))) return true;
  if (DIRECTORY_INDEXES.some((index) => files.has(`${path}/${index}`))) return true;
  // A directory that exists but carries no recognizable index still resolves
  // through its own package.json `main`, and following that is more resolution
  // than this rule should attempt — treat the directory as satisfied.
  return directories.has(path);
}
