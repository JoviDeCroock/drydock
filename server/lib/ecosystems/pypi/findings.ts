import {
  type DiffEntry,
  type FileRecord,
  type Finding,
  PYTHON_EXECUTION_CAPABILITY_PATTERNS,
  tarSuspiciousEntryFindings,
} from "../../review";
import { canonicalizePath, normalizeTarPath, type TarSuspiciousEntry } from "../../tar-parser.js";
import { firstMatchingLine } from "../../platform/text-utils";
import { normalizePyPiProjectName } from "./manifest";
import { pyPiVersionsEquivalent } from "./version";
import {
  PYPI_RULE_IDS,
  PYPI_RULES_VERSION,
  type PyPiArtifactKind,
  type PyPiArtifactSummary,
  type PyPiPreparedArtifact,
  type PyPiReleaseManifest,
} from "./types";

const SETUP_INSTALL_COMMAND_PATTERNS = [
  /\bcmdclass\b/,
  /\bsetuptools\.command\.install\b/,
  /\bdistutils\.command\.install\b/,
];

// PEP 508 direct references (`name @ <scheme>://…`). PyPI forbids these in
// uploaded metadata, so their presence in Requires-Dist is itself anomalous.
const DIRECT_REFERENCE_REQUIREMENT_RE = /@\s*[a-z][a-z0-9+.-]*:\/\//i;

export function pyPiReleaseFindings(
  manifest: PyPiReleaseManifest,
  artifacts: PyPiPreparedArtifact[],
  fileDiff: DiffEntry[] = [],
): Finding[] {
  const findings: Finding[] = [];
  const manifestName = normalizePyPiProjectName(manifest.package);

  for (const artifact of artifacts) {
    const { summary } = artifact;
    // Surface tar-parser evidence (oversized content-skipped bodies, non-regular
    // entries, duplicates, confusable paths) the sandbox recorded for this
    // artifact. Without this the gate would drop them and pass an sdist whose
    // oversized file was never inspected — a fail-open gap the npm path avoids.
    // Explicit directory records are excluded: setuptools and every other
    // Python build backend always emits them, so unlike an `npm pack` tarball a
    // typeflag-5 entry is the archive norm here, not provenance evidence
    // (requests alone carries 16, each one a noise finding on the public diff).
    const suspiciousEntries = (artifact.suspiciousEntries ?? []).filter(
      (entry) => !isOrdinaryPyPiDirectoryEntry(entry),
    );
    for (const finding of tarSuspiciousEntryFindings(suspiciousEntries, {
      dialect: "pypi",
      fileDiff,
    })) {
      findings.push({ ...finding, file: namespacedPath(artifact.path, finding.file) });
    }
    const metadataEvidencePath = namespacedPath(artifact.path, summary.metadataPath ?? "METADATA");
    if (!summary.metadataPath || !summary.name || !summary.version) {
      findings.push(
        tag("metadataMissing", {
          severity: "medium",
          file: metadataEvidencePath,
          evidence: `${artifact.path} does not expose complete PyPI metadata`,
          reason:
            "release gates need package name and version metadata to prove the artifact matches the reviewed manifest",
        }),
      );
    } else if (normalizePyPiProjectName(summary.name) !== manifestName) {
      findings.push(
        tag("metadataMismatch", {
          severity: "critical",
          file: metadataEvidencePath,
          evidence: `${artifact.path} metadata Name ${summary.name} != manifest package ${manifest.package}`,
          reason: "the release artifact package name does not match the reviewed PyPI manifest",
        }),
      );
    }
    // PEP 440-equivalent spellings ("1.0-1" vs "1.0.post1", legacy "-final"
    // markers) are the same version, not tampering evidence — only flag
    // versions that differ after canonicalization, like the name compare.
    if (summary.version && !pyPiVersionsEquivalent(summary.version, manifest.version)) {
      findings.push(
        tag("metadataMismatch", {
          severity: "critical",
          file: metadataEvidencePath,
          evidence: `${artifact.path} metadata Version ${summary.version} != manifest version ${manifest.version}`,
          reason: "the release artifact version does not match the reviewed PyPI manifest",
        }),
      );
    }
    if (artifact.kind === "wheel" && !summary.wheel?.recordPath) {
      findings.push(
        tag("wheelRecordMissing", {
          severity: "medium",
          file: namespacedPath(artifact.path, "RECORD"),
          evidence: `${artifact.path} has no .dist-info/RECORD file`,
          reason: "wheel RECORD metadata is needed to audit the installed file manifest",
        }),
      );
    }

    const directReferenceDeps = summary.requiresDist.filter((requirement) =>
      DIRECT_REFERENCE_REQUIREMENT_RE.test(requirement),
    );
    if (directReferenceDeps.length) {
      findings.push(
        tag("unusualDependency", {
          severity: "high",
          file: metadataEvidencePath,
          evidence: `direct-reference dependency: ${directReferenceDeps.join(", ")}`,
          reason:
            "PEP 508 direct-URL/VCS dependencies bypass the PyPI registry and pull unreviewed code from an arbitrary location",
        }),
      );
    }

    if (artifact.kind === "wheel" && summary.wheel?.recordPath) {
      for (const undeclared of undeclaredWheelFiles(artifact, summary.wheel.recordPath)) {
        findings.push(
          tag("recordMismatch", {
            severity: "high",
            file: namespacedPath(artifact.path, undeclared.path),
            evidence: `${undeclared.path} is present in the wheel but not listed in RECORD`,
            reason:
              "files absent from the wheel RECORD can be installed without integrity tracking and indicate archive tampering",
          }),
        );
      }
    }
  }

  for (const artifact of artifacts) {
    for (const file of artifact.files) {
      const filePath = namespacedPath(artifact.path, file.path);
      const installed = pythonImportPathLocation(artifact, file.path);
      if (installed?.kind === "site" && /^[^/]+\.pth$/i.test(installed.path)) {
        const hasImportLine = Boolean(
          file.textSample?.split(PYTHON_LINE_BOUNDARY_RE).some((line) => PTH_IMPORT_RE.test(line)),
        );
        findings.push(
          tag("pthExecution", {
            severity: hasImportLine ? "high" : "medium",
            file: filePath,
            line: hasImportLine
              ? firstMatchingLine(file.textSample, [PTH_IMPORT_LINE_RE])
              : undefined,
            evidence: hasImportLine
              ? ".pth file contains an import line"
              : ".pth file included in wheel",
            reason:
              "Python .pth files can alter interpreter startup behavior when the package is installed",
          }),
        );
      }
      const startupModule =
        installed && installed.kind !== "stdlib-archive"
          ? STARTUP_HOOK_MODULE_RE.exec(installed.path)?.[1]
          : undefined;
      if (startupModule) {
        findings.push(
          tag("startupHook", {
            severity: "high",
            file: filePath,
            evidence: `${startupModule.toLowerCase()} module runs automatically on interpreter startup`,
            reason:
              "Python imports sitecustomize and usercustomize from the import path on every startup once installed, a common persistence hook",
          }),
        );
      } else if (installed?.kind === "stdlib-archive") {
        findings.push(
          tag("startupHook", {
            severity: "high",
            file: filePath,
            evidence: `${installed.path.split("/").at(-1)} sits ahead of the standard library on the import path`,
            reason:
              "Python searches its pythonXY.zip archive before the standard library directory, so a wheel that installs one can replace any stdlib module imported at startup",
          }),
        );
      }
      if (artifact.kind === "sdist" && /^setup\.py$/i.test(file.path)) {
        const setupText = file.textSample ?? "";
        const matchedInstallCommand = SETUP_INSTALL_COMMAND_PATTERNS.some((pattern) =>
          pattern.test(setupText),
        );
        const matchedExecution = PYTHON_EXECUTION_CAPABILITY_PATTERNS.some((pattern) =>
          pattern.test(setupText),
        );
        if (matchedInstallCommand || matchedExecution) {
          findings.push(
            tag("setupInstallCommand", {
              severity: "high",
              file: filePath,
              line: firstMatchingLine(setupText, [
                ...SETUP_INSTALL_COMMAND_PATTERNS,
                ...PYTHON_EXECUTION_CAPABILITY_PATTERNS,
              ]),
              evidence: matchedInstallCommand
                ? "setup.py custom install command"
                : "setup.py executes code at install time",
              reason:
                "pip runs setup.py when installing an sdist, so process, network, or dynamic-eval code there runs on the consumer machine",
            }),
          );
        }
      }
      if (/\.(pyd)$/i.test(file.path)) {
        findings.push(
          tag("nativeArtifact", {
            severity: "high",
            file: filePath,
            evidence: "Python native extension artifact",
            reason:
              "native Python extensions are hard to audit and execute outside source-level policy checks",
          }),
        );
      }
    }
  }

  return findings;
}

function isOrdinaryPyPiDirectoryEntry(entry: TarSuspiciousEntry): boolean {
  if (entry.kind !== "non-regular" || entry.detail !== "typeflag 5 (directory)") return false;
  if (entry.path.startsWith("/") || canonicalizePath(entry.path) !== entry.path) return false;
  return normalizeTarPath(entry.path, "keep") !== null;
}

export function summarizePyPiArtifact(
  artifactPath: string,
  kind: PyPiArtifactKind,
  files: FileRecord[],
): PyPiArtifactSummary {
  const metadataFile = findPyPiMetadataFile(files, kind);
  const headers = metadataFile?.textSample
    ? parseMetadataHeaders(metadataFile.textSample)
    : new Map();
  const wheelFile =
    kind === "wheel" ? files.find((file) => /\.dist-info\/WHEEL$/i.test(file.path)) : undefined;
  const wheelHeaders = wheelFile?.textSample
    ? parseMetadataHeaders(wheelFile.textSample)
    : new Map();
  const recordPath =
    kind === "wheel"
      ? (files.find((file) => /\.dist-info\/RECORD$/i.test(file.path))?.path ?? null)
      : null;

  return {
    path: artifactPath,
    kind,
    metadataPath: metadataFile?.path ?? null,
    name: firstHeader(headers, "name"),
    version: firstHeader(headers, "version"),
    requiresDist: headers.get("requires-dist") ?? [],
    wheel:
      kind === "wheel"
        ? {
            recordPath,
            tags: wheelHeaders.get("tag") ?? [],
            rootIsPurelib: parseWheelBoolean(firstHeader(wheelHeaders, "root-is-purelib")),
          }
        : null,
  };
}

export function namespacedPath(artifactPath: string, filePath: string): string {
  return `${artifactPath.replace(/\/+$/, "")}/${filePath.replace(/^\/+/, "")}`;
}

// Files present in the wheel but absent from its RECORD. Skips when the RECORD
// sample was truncated, since an incomplete path list would flag legitimate files.
function undeclaredWheelFiles(artifact: PyPiPreparedArtifact, recordPath: string): FileRecord[] {
  const recordFile = artifact.files.find((file) => file.path === recordPath);
  if (
    !recordFile ||
    recordFile.textSample === undefined ||
    recordFile.flags.includes("truncated")
  ) {
    return [];
  }
  const declared = new Set<string>();
  for (const line of recordFile.textSample.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let path: string;
    if (line.startsWith('"')) {
      const close = line.indexOf('"', 1);
      path = close > 0 ? line.slice(1, close) : line;
    } else {
      const comma = line.indexOf(",");
      path = comma >= 0 ? line.slice(0, comma) : line;
    }
    if (path) declared.add(path);
  }
  return artifact.files.filter((file) => !declared.has(file.path));
}

// `site` imports these by module name, so any importable form counts: source
// (`.pyw` on Windows), sourceless bytecode, a native extension, or a package
// whose `__init__` is any of those.
const STARTUP_HOOK_MODULE_RE =
  /^(sitecustomize|usercustomize)(?:\/__init__)?(?:\.pyw?|\.pyc|(?:\.[^/]*)?\.(?:so|pyd))$/i;

// `site` reads `.pth` files with str.splitlines(), which breaks on more than \n.
// eslint-disable-next-line no-control-regex -- these are Python's line boundaries
const PYTHON_LINE_BOUNDARY_RE = /\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/;
const PTH_IMPORT_RE = /^\s*import\s/;
// Same test against the \n-split display lines, for the finding's line number.
// eslint-disable-next-line no-control-regex -- same boundaries as above
const PTH_IMPORT_LINE_RE = /(?:^|[\r\v\f\x1c-\x1e\x85\u2028\u2029])\s*import\s/;

// The `.data/data/` scheme installs relative to the environment prefix
// (LiteLLM 1.107.0 used `.data/` to plant its hooks). Under it, these
// directories are on the import path; `site` additionally processes `.pth`
// files in the site directories. Covers posix_prefix/venv (`lib|lib64/
// pythonX.Y`, PyPy's `pypyX.Y`, Debian `dist-packages`), posix_user and the
// macOS framework user layout, nt/nt venv (`Lib`, `DLLs`, and the prefix
// itself, which Windows treats as a site directory), and nt_user `PythonXY`.
const PREFIX_SITE_DIR_RE =
  /^(?:(?:lib|lib64)\/(?:python|pypy)[^/]*\/(?:site|dist)-packages\/|Lib\/site-packages\/|Python[^/]*\/site-packages\/|(?=[^/]+$))/i;
const PREFIX_IMPORT_DIR_RE =
  /^(?:(?:lib|lib64)\/(?:python|pypy)[^/]*\/(?:lib-dynload\/)?|Lib\/|DLLs\/)/i;
// The interpreter searches `pythonXY.zip` (prefix root on Windows, `lib/` on
// POSIX) before the stdlib directory, and none ships by default.
const PREFIX_STDLIB_ARCHIVE_RE = /^(?:lib\/)?python\d+\.zip$/i;

interface ImportPathLocation {
  /** Path relative to the import-path directory the file installs into. */
  path: string;
  /** `site` processes `.pth` files only in site directories. */
  kind: "site" | "import" | "stdlib-archive";
}

/** Where a wheel file lands relative to Python's import path, or null if it installs off the import path. */
function pythonImportPathLocation(
  artifact: PyPiPreparedArtifact,
  filePath: string,
): ImportPathLocation | null {
  if (artifact.kind !== "wheel") return null;
  const normalized = filePath.replace(/^\/+/, "");
  const scheme = /^[^/]+\.data\/([^/]+)\/(.*)$/i.exec(normalized);
  if (!scheme) {
    // A `.data` entry with no scheme directory installs nowhere.
    return /^[^/]+\.data\//i.test(normalized) ? null : { path: normalized, kind: "site" };
  }
  const [, schemeName = "", rest = ""] = scheme;
  if (/^(?:purelib|platlib)$/i.test(schemeName)) return { path: rest, kind: "site" };
  // headers and scripts never reach the import path.
  if (schemeName.toLowerCase() !== "data") return null;
  if (PREFIX_STDLIB_ARCHIVE_RE.test(rest)) return { path: rest, kind: "stdlib-archive" };
  const site = PREFIX_SITE_DIR_RE.exec(rest)?.[0];
  if (site !== undefined) return { path: rest.slice(site.length), kind: "site" };
  const importDir = PREFIX_IMPORT_DIR_RE.exec(rest)?.[0];
  if (importDir !== undefined) return { path: rest.slice(importDir.length), kind: "import" };
  return null;
}

function tag(
  rule: keyof typeof PYPI_RULE_IDS,
  finding: Omit<Finding, "ruleId" | "ruleVersion">,
): Finding {
  return {
    ...finding,
    ruleId: PYPI_RULE_IDS[rule],
    ruleVersion: PYPI_RULES_VERSION,
  };
}

function findPyPiMetadataFile(files: FileRecord[], kind: PyPiArtifactKind): FileRecord | undefined {
  if (kind === "wheel") return files.find((file) => /\.dist-info\/METADATA$/i.test(file.path));
  return (
    files.find((file) => file.path === "PKG-INFO") ??
    files.find((file) => /(^|\/)[^/]+\.egg-info\/PKG-INFO$/i.test(file.path))
  );
}

function parseMetadataHeaders(text: string): Map<string, string[]> {
  const headers = new Map<string, string[]>();
  let currentKey: string | null = null;
  let currentValue = "";
  const commit = () => {
    if (!currentKey) return;
    const list = headers.get(currentKey) ?? [];
    list.push(currentValue.trim());
    headers.set(currentKey, list);
  };

  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    if (!line) break;
    if (/^[ \t]/.test(line) && currentKey) {
      currentValue += ` ${line.trim()}`;
      continue;
    }
    commit();
    const colon = line.indexOf(":");
    if (colon <= 0) {
      currentKey = null;
      currentValue = "";
      continue;
    }
    currentKey = line.slice(0, colon).toLowerCase();
    currentValue = line.slice(colon + 1).trim();
  }
  commit();
  return headers;
}

function firstHeader(headers: Map<string, string[]>, key: string): string | null {
  return headers.get(key.toLowerCase())?.[0] ?? null;
}

function parseWheelBoolean(value: string | null): boolean | null {
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}
