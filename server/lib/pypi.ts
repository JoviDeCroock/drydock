import {
  computeRisk,
  createPackageDiff,
  deterministicFindings,
  redactFindings,
  type DiffEntry,
  type FileRecord,
  type Finding,
  type RiskLevel,
} from "./review";

export const PYPI_RELEASE_MANIFEST_SCHEMA = "drydock.release-artifacts.v1";
export const PYPI_RULES_VERSION = "0.1.0";

export const PYPI_RULE_IDS = {
  metadataMissing: "pypi.metadata-missing",
  metadataMismatch: "pypi.metadata-mismatch",
  wheelRecordMissing: "pypi.wheel-record-missing",
  pthExecution: "pypi.pth-execution",
  setupInstallCommand: "pypi.setup-install-command",
  nativeArtifact: "pypi.native-artifact",
} as const;

export type PyPiArtifactKind = "wheel" | "sdist";

export interface PyPiReleaseManifestArtifact {
  path: string;
  sha256: string;
  url?: string;
  kind: PyPiArtifactKind;
}

export interface PyPiReleaseManifest {
  schema: typeof PYPI_RELEASE_MANIFEST_SCHEMA;
  ecosystem: "pypi";
  package: string;
  version: string;
  artifacts: PyPiReleaseManifestArtifact[];
}

export interface PyPiArtifactInput {
  path: string;
  files: FileRecord[];
}

export interface PyPiArtifactSummary {
  path: string;
  kind: PyPiArtifactKind;
  metadataPath: string | null;
  name: string | null;
  version: string | null;
  requiresDist: string[];
  wheel: {
    recordPath: string | null;
    tags: string[];
    rootIsPurelib: boolean | null;
  } | null;
}

export interface PyPiPreparedArtifact extends PyPiArtifactInput {
  kind: PyPiArtifactKind;
  summary: PyPiArtifactSummary;
}

export interface PyPiReleaseCandidateReview {
  ecosystem: "pypi";
  manifest: PyPiReleaseManifest;
  package: {
    name: string | null;
    version: string | null;
  };
  artifactCount: number;
  fileCount: number;
  previousFileCount: number;
  artifacts: PyPiArtifactSummary[];
  diff: DiffEntry[];
  ruleFindings: Finding[];
  risk: RiskLevel;
}

export interface PyPiProjectMetadata {
  info?: { name?: string; version?: string };
  releases?: Record<string, PyPiReleaseFile[]>;
  urls?: PyPiReleaseFile[];
}

export interface PyPiReleaseFile {
  filename?: string;
  packagetype?: string;
  url?: string;
  size?: number;
  upload_time_iso_8601?: string;
  digests?: { sha256?: string };
  yanked?: boolean;
}

export type PyPiBaselineSelectionSource = "latest-published" | "upload-time" | "none";

export interface PyPiBaselineSelection {
  version: string | null;
  source: PyPiBaselineSelectionSource;
  reason: string;
}

export interface PyPiRemoteArtifact {
  filename: string;
  url: string;
  sha256: string | null;
  packagetype: string | null;
  kind: PyPiArtifactKind;
  size: number | null;
}

const PYPI_PROJECT_NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const SAFE_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._!+-]{0,127}$/;
const SHA256_RE = /^[a-f0-9]{64}$/i;
const PYPI_ARTIFACT_LIMIT = 20;

export function normalizePyPiProjectName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

export function isValidPyPiProjectName(name: string): boolean {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name.length <= 214 &&
    PYPI_PROJECT_NAME_RE.test(name)
  );
}

export function inferPyPiArtifactKind(path: string): PyPiArtifactKind | null {
  const lower = path.toLowerCase();
  if (lower.endsWith(".whl")) return "wheel";
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) return "sdist";
  return null;
}

export function parsePyPiReleaseManifest(value: unknown): PyPiReleaseManifest {
  if (!isRecord(value)) throw new Error("manifest must be an object");
  if (value.schema !== PYPI_RELEASE_MANIFEST_SCHEMA) {
    throw new Error(`manifest schema must be ${PYPI_RELEASE_MANIFEST_SCHEMA}`);
  }
  if (value.ecosystem !== "pypi") throw new Error("manifest ecosystem must be pypi");
  const packageName = String(value.package || "");
  const version = String(value.version || "");
  if (!isValidPyPiProjectName(packageName))
    throw new Error("manifest package is not a valid PyPI project name");
  if (!SAFE_VERSION_RE.test(version))
    throw new Error("manifest version is not a safe PyPI version string");
  if (!Array.isArray(value.artifacts) || !value.artifacts.length) {
    throw new Error("manifest must include at least one artifact");
  }
  if (value.artifacts.length > PYPI_ARTIFACT_LIMIT) {
    throw new Error(`manifest must include no more than ${PYPI_ARTIFACT_LIMIT} artifacts`);
  }

  const artifacts = value.artifacts.map((artifact, index) => {
    if (!isRecord(artifact)) throw new Error(`artifact ${index + 1} must be an object`);
    const path = String(artifact.path || "");
    if (!isSafeManifestPath(path)) throw new Error(`artifact ${index + 1} path is not safe`);
    const kind = inferPyPiArtifactKind(path);
    if (!kind) throw new Error(`artifact ${index + 1} must be a wheel or sdist`);
    const sha256 = String(artifact.sha256 || "");
    if (!SHA256_RE.test(sha256))
      throw new Error(`artifact ${index + 1} sha256 must be a hex SHA-256 digest`);
    const url = typeof artifact.url === "string" && artifact.url ? artifact.url : undefined;
    if (url && !isSafeHttpsUrl(url)) throw new Error(`artifact ${index + 1} url must be https`);
    return { path, sha256: sha256.toLowerCase(), url, kind };
  });

  return {
    schema: PYPI_RELEASE_MANIFEST_SCHEMA,
    ecosystem: "pypi",
    package: packageName,
    version,
    artifacts,
  };
}

export function preparePyPiArtifact(input: PyPiArtifactInput): PyPiPreparedArtifact {
  const kind = inferPyPiArtifactKind(input.path);
  if (!kind) throw new Error("PyPI artifact must be a wheel or sdist");
  const files = kind === "sdist" ? stripCommonArchiveRoot(input.files) : input.files;
  return {
    path: input.path,
    kind,
    files,
    summary: summarizePyPiArtifact(input.path, kind, files),
  };
}

export function createPyPiReleaseCandidateReview(input: {
  manifest: PyPiReleaseManifest;
  artifacts: PyPiArtifactInput[];
  previousArtifacts?: PyPiArtifactInput[];
}): PyPiReleaseCandidateReview {
  assertManifestArtifactSet(input.manifest, input.artifacts);
  const artifacts = input.artifacts.map(preparePyPiArtifact);
  const previousArtifacts = (input.previousArtifacts ?? []).map(preparePyPiArtifact);
  const stagedFiles = flattenPyPiArtifactFiles(artifacts);
  const previousFiles = flattenPyPiArtifactFiles(previousArtifacts);
  const diff = createPackageDiff(previousFiles, stagedFiles);
  const packageIdentity = pickPackageIdentity(input.manifest, artifacts);
  const ruleFindings = redactFindings([
    ...deterministicFindings(stagedFiles, diff, null),
    ...pyPiReleaseFindings(input.manifest, artifacts),
  ]);

  return {
    ecosystem: "pypi",
    manifest: input.manifest,
    package: packageIdentity,
    artifactCount: artifacts.length,
    fileCount: stagedFiles.length,
    previousFileCount: previousFiles.length,
    artifacts: artifacts.map((artifact) => artifact.summary),
    diff,
    ruleFindings,
    risk: computeRisk(ruleFindings),
  };
}

export async function fetchPyPiProjectMetadata(
  projectName: string,
  options: { registryUrl?: string } = {},
): Promise<PyPiProjectMetadata> {
  if (!isValidPyPiProjectName(projectName)) throw new Error("invalid PyPI project name");
  const registry = (options.registryUrl || "https://pypi.org/pypi").replace(/\/$/, "");
  const res = await fetch(`${registry}/${encodeURIComponent(projectName)}/json`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`PyPI metadata fetch failed: ${res.status}`);
  return (await res.json()) as PyPiProjectMetadata;
}

export function pickPyPiBaselineRelease(
  metadata: PyPiProjectMetadata,
  candidateVersion: string,
): PyPiBaselineSelection {
  const releases = metadata.releases ?? {};
  const latest = metadata.info?.version ?? null;
  if (latest && latest !== candidateVersion && hasUsableReleaseFiles(releases[latest])) {
    return {
      version: latest,
      source: "latest-published",
      reason: "project-json-info-version",
    };
  }

  const byUploadTime = Object.entries(releases)
    .filter(([version, files]) => version !== candidateVersion && hasUsableReleaseFiles(files))
    .map(([version, files]) => ({
      version,
      uploadedAt: newestUploadTimestamp(files),
    }))
    .filter((entry) => entry.uploadedAt > 0)
    .sort((a, b) => a.uploadedAt - b.uploadedAt)
    .at(-1);

  if (byUploadTime) {
    return {
      version: byUploadTime.version,
      source: "upload-time",
      reason: "newest-uploaded-release",
    };
  }

  return {
    version: null,
    source: "none",
    reason: "no-published-baseline",
  };
}

export function selectPyPiReleaseArtifacts(
  metadata: PyPiProjectMetadata,
  version: string,
): PyPiRemoteArtifact[] {
  return (metadata.releases?.[version] ?? [])
    .map((file) => {
      const filename = file.filename ?? "";
      const kind = inferPyPiArtifactKind(filename);
      if (!filename || !kind || !file.url) return null;
      return {
        filename,
        url: file.url,
        sha256: file.digests?.sha256 ?? null,
        packagetype: file.packagetype ?? null,
        kind,
        size: typeof file.size === "number" ? file.size : null,
      };
    })
    .filter((artifact): artifact is PyPiRemoteArtifact => artifact !== null);
}

export function isAllowedPyPiArtifactUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === "files.pythonhosted.org";
  } catch {
    return false;
  }
}

function summarizePyPiArtifact(
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

function pyPiReleaseFindings(
  manifest: PyPiReleaseManifest,
  artifacts: PyPiPreparedArtifact[],
): Finding[] {
  const findings: Finding[] = [];
  const manifestName = normalizePyPiProjectName(manifest.package);
  const firstSummary = artifacts.find(
    (artifact) => artifact.summary.name && artifact.summary.version,
  )?.summary;

  for (const artifact of artifacts) {
    const { summary } = artifact;
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
      continue;
    }
    if (normalizePyPiProjectName(summary.name) !== manifestName) {
      findings.push(
        tag("metadataMismatch", {
          severity: "critical",
          file: metadataEvidencePath,
          evidence: `${artifact.path} metadata Name ${summary.name} != manifest package ${manifest.package}`,
          reason: "the release artifact package name does not match the reviewed PyPI manifest",
        }),
      );
    }
    if (summary.version !== manifest.version) {
      findings.push(
        tag("metadataMismatch", {
          severity: "critical",
          file: metadataEvidencePath,
          evidence: `${artifact.path} metadata Version ${summary.version} != manifest version ${manifest.version}`,
          reason: "the release artifact version does not match the reviewed PyPI manifest",
        }),
      );
    }
    if (
      firstSummary &&
      summary.name &&
      summary.version &&
      (normalizePyPiProjectName(summary.name) !==
        normalizePyPiProjectName(firstSummary.name ?? "") ||
        summary.version !== firstSummary.version)
    ) {
      findings.push(
        tag("metadataMismatch", {
          severity: "critical",
          file: metadataEvidencePath,
          evidence: `${artifact.path} metadata does not match the other candidate artifacts`,
          reason:
            "all PyPI artifacts in one gated release must describe the same package name and version",
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
  }

  for (const artifact of artifacts) {
    for (const file of artifact.files) {
      const filePath = namespacedPath(artifact.path, file.path);
      if (/\.pth$/i.test(file.path)) {
        const hasImportLine = Boolean(
          file.textSample?.split(/\r?\n/).some((line) => /^\s*import\s+/.test(line)),
        );
        findings.push(
          tag("pthExecution", {
            severity: hasImportLine ? "high" : "medium",
            file: filePath,
            line: hasImportLine ? firstMatchingLine(file.textSample, [/^\s*import\s+/]) : undefined,
            evidence: hasImportLine
              ? ".pth file contains an import line"
              : ".pth file included in wheel",
            reason:
              "Python .pth files can alter interpreter startup behavior when the package is installed",
          }),
        );
      }
      if (
        /(^|\/)setup\.py$/i.test(file.path) &&
        /\b(cmdclass|setuptools\.command\.install|distutils\.command\.install)\b/.test(
          file.textSample ?? "",
        )
      ) {
        findings.push(
          tag("setupInstallCommand", {
            severity: "high",
            file: filePath,
            line: firstMatchingLine(file.textSample, [
              /\bcmdclass\b/,
              /\bsetuptools\.command\.install\b/,
              /\bdistutils\.command\.install\b/,
            ]),
            evidence: "setup.py custom install command",
            reason:
              "custom Python install commands can run maintainer-controlled code during package installation",
          }),
        );
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

function flattenPyPiArtifactFiles(artifacts: PyPiPreparedArtifact[]): FileRecord[] {
  return artifacts.flatMap((artifact) =>
    artifact.files.map((file) => ({
      ...file,
      path: namespacedPath(artifactDiffNamespace(artifact), normalizePyPiDiffFilePath(file.path)),
    })),
  );
}

function assertManifestArtifactSet(
  manifest: PyPiReleaseManifest,
  artifacts: PyPiArtifactInput[],
): void {
  const manifestPaths = sortedUnique(manifest.artifacts.map((artifact) => artifact.path));
  const artifactPaths = sortedUnique(artifacts.map((artifact) => artifact.path));
  if (
    manifestPaths.length !== manifest.artifacts.length ||
    artifactPaths.length !== artifacts.length ||
    manifestPaths.length !== artifactPaths.length ||
    manifestPaths.some((path, index) => path !== artifactPaths[index])
  ) {
    throw new Error("review artifacts must exactly match manifest artifacts");
  }
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function artifactDiffNamespace(artifact: PyPiPreparedArtifact): string {
  if (artifact.kind === "sdist") return "sdist";
  const tags = artifact.summary.wheel?.tags ?? [];
  if (tags.length) return `wheel/${tags.slice().sort().map(safeDiffPathPart).join("+")}`;
  const filename = artifact.path.split("/").at(-1) ?? "";
  const wheelTags = filename
    .replace(/\.whl$/i, "")
    .split("-")
    .slice(-3);
  if (wheelTags.length === 3) return `wheel/${wheelTags.map(safeDiffPathPart).join("-")}`;
  return "wheel/unknown";
}

function normalizePyPiDiffFilePath(path: string): string {
  return path
    .replace(/(^|\/)[^/]+\.dist-info\//gi, "$1.dist-info/")
    .replace(/(^|\/)[^/]+\.egg-info\//gi, "$1.egg-info/");
}

function safeDiffPathPart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_") || "unknown";
}

function pickPackageIdentity(manifest: PyPiReleaseManifest, artifacts: PyPiPreparedArtifact[]) {
  const summary = artifacts.find(
    (artifact) => artifact.summary.name && artifact.summary.version,
  )?.summary;
  return {
    name: summary?.name ?? manifest.package ?? null,
    version: summary?.version ?? manifest.version ?? null,
  };
}

function stripCommonArchiveRoot(files: FileRecord[]): FileRecord[] {
  const pathParts = files.map((file) => file.path.split("/"));
  if (!pathParts.length || pathParts.some((parts) => parts.length < 2)) return files;
  const root = pathParts[0][0];
  if (!root || pathParts.some((parts) => parts[0] !== root)) return files;
  return files.map((file) => ({
    ...file,
    path: file.path.split("/").slice(1).join("/"),
  }));
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

function namespacedPath(artifactPath: string, filePath: string): string {
  return `${artifactPath.replace(/\/+$/, "")}/${filePath.replace(/^\/+/, "")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeManifestPath(path: string): boolean {
  if (!path || path.length > 512 || path.includes("\0") || path.includes("\\")) return false;
  if (path.startsWith("/") || path.startsWith("../") || path.includes("/../")) return false;
  if (/^[A-Za-z]:/.test(path)) return false;
  return path.split("/").every((part) => part && part !== "." && part !== "..");
}

function isSafeHttpsUrl(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

function hasUsableReleaseFiles(files: PyPiReleaseFile[] | undefined): boolean {
  return Boolean(files?.some((file) => file.url && !file.yanked));
}

function newestUploadTimestamp(files: PyPiReleaseFile[]): number {
  return Math.max(
    0,
    ...files
      .filter((file) => !file.yanked)
      .map((file) => Date.parse(file.upload_time_iso_8601 ?? ""))
      .filter((time) => Number.isFinite(time)),
  );
}

function firstMatchingLine(
  text: string | undefined | null,
  patterns: RegExp[],
): number | undefined {
  if (!text) return undefined;
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      if (pattern.test(lines[index])) return index + 1;
    }
  }
  return undefined;
}
