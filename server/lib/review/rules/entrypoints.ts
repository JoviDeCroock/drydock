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

const NPM_MAIN_EXTENSIONS = [".js", ".json", ".node"];
const VSCODE_ENTRYPOINT_EXTENSIONS = [".js", ".mjs", ".cjs", ".json"];

interface DeclaredEntrypoint {
  kind: "main" | "bin" | "browser" | "exports";
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
 * Resolution is field-specific: npm `main` gets CommonJS extension/directory
 * lookup, while npm `exports` and `bin` are exact paths. VS Code opts into the
 * entrypoint suffixes its adapter already uses. Subpath patterns (`./*`) and
 * non-path targets (`node:` builtins, URLs) stay skipped because this rule
 * cannot prove which packaged file they should resolve to.
 */
export function entrypointPresenceFindings(ctx: RuleContext): Finding[] {
  const packageJson = ctx.packageJson;
  if (!packageJson) return [];
  // Without the manifest file in the artifact we are not looking at a normal
  // package layout (a metadata-only manifest, a partial parse), and every
  // declared path would read as missing. Stay quiet rather than guess.
  const files = new Set(ctx.files.map((file) => file.path));
  if (!files.has("package.json")) return [];

  const findings: Finding[] = [];
  const reported = new Set<string>();
  for (const declared of declaredEntrypoints(packageJson, ctx.entrypointResolution)) {
    if (reported.has(declared.path)) continue;
    if (resolvesToPackagedFile(declared, files, ctx.entrypointResolution)) continue;
    reported.add(declared.path);
    // A path the previous release shipped and this one dropped is a release
    // regression with a known-good predecessor; one that was never there is a
    // manifest that has always over-claimed, which is worth surfacing but is
    // not evidence about this release's delta.
    const removed = entrypointCandidates(declared, ctx.entrypointResolution).some(
      (path) => ctx.diffByPath.get(path)?.status === "removed",
    );
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

function declaredEntrypoints(
  packageJson: PackageJsonSummary,
  resolution: RuleContext["entrypointResolution"],
): DeclaredEntrypoint[] {
  const declared: DeclaredEntrypoint[] = [];
  const add = (kind: DeclaredEntrypoint["kind"], field: string, key: string, value: unknown) => {
    const path = normalizeEntrypointPath(value, kind);
    if (path) declared.push({ kind, field, key, path });
  };

  add("main", "main", "main", packageJson.main);

  const bin = packageJson.bin;
  if (typeof bin === "string") add("bin", "bin", "bin", bin);
  else if (bin && typeof bin === "object") {
    for (const [command, value] of Object.entries(bin)) {
      add("bin", `bin ${command}`, "bin", value);
    }
  }

  if (resolution === "vscode") {
    add("browser", "browser", "browser", packageJson.browser);
  }

  for (const path of exportsTargetPaths(packageJson.exports)) {
    declared.push({ kind: "exports", field: "exports", key: "exports", path });
  }

  return declared;
}

interface ExportSelection {
  paths: string[];
  /** This target prevents a surrounding fallback array from selecting a later entry. */
  terminal: boolean;
}

function exportsTargetPaths(exports: unknown): string[] {
  return exportSelection(exports, 0, true).paths;
}

function exportSelection(value: unknown, depth: number, root: boolean): ExportSelection {
  if (depth > 8) return { paths: [], terminal: true };
  if (typeof value === "string") {
    const path = normalizeEntrypointPath(value, "exports");
    if (path) return { paths: [path], terminal: true };
    // Wildcard targets are valid but cannot be checked without a requested
    // subpath. They still consume their fallback-array position.
    if (isValidUncheckableExportTarget(value)) return { paths: [], terminal: true };
    return { paths: [], terminal: false };
  }
  if (value === null) return { paths: [], terminal: false };
  if (Array.isArray(value)) {
    const paths: string[] = [];
    for (const entry of value) {
      const selected = exportSelection(entry, depth + 1, false);
      paths.push(...selected.paths);
      if (selected.terminal) return { paths, terminal: true };
    }
    return { paths, terminal: false };
  }
  if (!value || typeof value !== "object") return { paths: [], terminal: false };

  const entries = Object.entries(value as Record<string, unknown>);
  if (root && entries.some(([key]) => key.startsWith("."))) {
    return {
      paths: entries.flatMap(([, target]) => exportSelection(target, depth + 1, false).paths),
      terminal: false,
    };
  }

  const paths: string[] = [];
  for (const [condition, target] of entries) {
    const selected = exportSelection(target, depth + 1, false);
    paths.push(...selected.paths);
    // `default` always matches. Later condition keys are unreachable, while a
    // null/invalid default lets a surrounding fallback array continue.
    if (condition === "default") return { paths, terminal: selected.terminal };
  }
  // Without `default`, a surrounding array can be selected when none of these
  // environment conditions match.
  return { paths, terminal: false };
}

/**
 * Reduce a declared target to a package-relative path, or null when it is not a
 * path this rule can check: subpath patterns, protocol specifiers (`node:fs`,
 * `https://…`), package imports (`#dep`), bare package specifiers used as
 * fallbacks, and anything escaping the package root.
 */
function normalizeEntrypointPath(value: unknown, kind: DeclaredEntrypoint["kind"]): string | null {
  if (typeof value !== "string") return null;
  let path = value.trim();
  if (!path || path.includes("*") || path.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(path)) {
    return null;
  }
  if (path.startsWith("/")) return null;
  if (kind === "exports" && !path.startsWith("./")) return null;
  while (path.startsWith("./")) path = path.slice(2);
  if (!path || path.startsWith("../") || path.includes("/../")) return null;
  const segments = path.split("/").filter((segment) => segment && segment !== ".");
  if (!segments.length) return null;
  return segments.join("/");
}

function isValidUncheckableExportTarget(value: string): boolean {
  const path = value.trim();
  return path.startsWith("./") && path.includes("*") && !path.startsWith("../");
}

function resolvesToPackagedFile(
  declared: DeclaredEntrypoint,
  files: Set<string>,
  resolution: RuleContext["entrypointResolution"],
): boolean {
  if (entrypointCandidates(declared, resolution).some((path) => files.has(path))) return true;
  // A nested package manifest can redirect a directory-shaped npm `main`.
  // Following it recursively is outside this rule; its presence is enough to
  // avoid accusing the release of a missing entrypoint. It is not a severity
  // candidate because its presence alone does not prove the predecessor loaded.
  return (
    resolution === "npm" && declared.kind === "main" && files.has(`${declared.path}/package.json`)
  );
}

function entrypointCandidates(
  declared: DeclaredEntrypoint,
  resolution: RuleContext["entrypointResolution"],
): string[] {
  const { path } = declared;
  if (resolution === "npm" && declared.kind !== "main") return [path];

  const extensions = resolution === "vscode" ? VSCODE_ENTRYPOINT_EXTENSIONS : NPM_MAIN_EXTENSIONS;
  const directoryIndexes =
    resolution === "vscode"
      ? [".js", ".mjs", ".cjs"].map((extension) => `${path}/index${extension}`)
      : extensions.map((extension) => `${path}/index${extension}`);
  return [path, ...extensions.map((extension) => `${path}${extension}`), ...directoryIndexes];
}
