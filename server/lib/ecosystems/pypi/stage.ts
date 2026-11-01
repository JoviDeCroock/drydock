import { isRecord } from "../../platform/guards";
import { isValidPyPiProjectName, normalizePyPiProjectName } from "./manifest";
import {
  PYPI_STAGE_FILE_ORIGINS,
  PYPI_STAGE_INDEX_ORIGINS,
  SAFE_VERSION_RE,
  SHA256_RE,
} from "./types";
import { pyPiVersionsEquivalent } from "./version";

/**
 * PEP 694 (Upload 2.0) staged previews for the PyPI workflow gate.
 *
 * PEP 694 is a draft and is not live on pypi.org. The workflow creates the
 * publishing session and uploads with its own credentials, then registers the
 * session through the gate artifact (`pypi-stage.json`). Drydock reviews the
 * bytes the stage holds. Everything here is pure so the parsing and identity
 * rules can be tested without a network.
 *
 * A stage URL, and every file URL a stage page lists, is a capability: anyone
 * holding it can read the unpublished bytes. It must never reach logs, errors,
 * plaintext persistence, scan artifacts, the sandbox, or UI. Every message this
 * module produces names projects, files, and digest prefixes only.
 */

export const PYPI_STAGE_REFERENCE_FILENAME = "pypi-stage.json";
const PYPI_STAGE_REFERENCE_SCHEMA = "drydock.pypi-stage.v1";
export const PYPI_STAGE_REFERENCE_MAX_BYTES = 16 * 1024;
const MAX_STAGE_ENTRIES = 32;
const MAX_URL_LENGTH = 2048;

export function stageFileOrigins(indexOrigin: string): readonly string[] {
  return PYPI_STAGE_FILE_ORIGINS[indexOrigin] ?? [];
}

export type PyPiStageErrorCode =
  | "stage_reference_invalid"
  | "stage_unavailable"
  | "stage_identity_mismatch"
  | "stage_session_mismatch";

export class PyPiStageError extends Error {
  constructor(
    public code: PyPiStageErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PyPiStageError";
  }
}

export interface PyPiStageReferenceEntry {
  name: string;
  version: string;
  /** Capability URL. Keep in memory only; see the module comment. */
  stageUrl: URL;
  /**
   * PEP 694 `links.session`, used only when the organization opted this
   * project into Drydock-managed sessions. The session gateway validates it
   * before any credential is attached; nothing here trusts it.
   */
  sessionUrl: string | null;
}

/**
 * Parse one `pypi-stage.json`. Unknown keys are ignored so the schema can grow
 * while PEP 694 settles; an unknown schema id fails closed, because a workflow
 * that tried to bind a stage must not silently fall back to an unbound review.
 */
export function parsePyPiStageReference(text: string): PyPiStageReferenceEntry[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw invalid(`${PYPI_STAGE_REFERENCE_FILENAME} is not valid JSON`);
  }
  if (!isRecord(raw)) throw invalid(`${PYPI_STAGE_REFERENCE_FILENAME} must be a JSON object`);
  if (raw.schema !== PYPI_STAGE_REFERENCE_SCHEMA) {
    throw invalid(`${PYPI_STAGE_REFERENCE_FILENAME} schema must be ${PYPI_STAGE_REFERENCE_SCHEMA}`);
  }
  // A single-project release may put the entry at the top level.
  const rawEntries = raw.stages === undefined ? [raw] : raw.stages;
  if (!Array.isArray(rawEntries) || rawEntries.length === 0) {
    throw invalid(`${PYPI_STAGE_REFERENCE_FILENAME} stages must be a non-empty array`);
  }
  if (rawEntries.length > MAX_STAGE_ENTRIES) {
    throw invalid(`${PYPI_STAGE_REFERENCE_FILENAME} lists more than ${MAX_STAGE_ENTRIES} stages`);
  }
  return rawEntries.map((entry, index) => parseStageEntry(entry, index));
}

function parseStageEntry(entry: unknown, index: number): PyPiStageReferenceEntry {
  const label = `stage ${index + 1}`;
  if (!isRecord(entry)) throw invalid(`${label} must be an object`);
  const name = typeof entry.name === "string" ? entry.name : "";
  const version = typeof entry.version === "string" ? entry.version : "";
  if (!isValidPyPiProjectName(name)) throw invalid(`${label} name is not a valid project name`);
  if (!SAFE_VERSION_RE.test(version)) throw invalid(`${label} version is not a safe version`);
  const rawUrl = entry["stage-url"] ?? entry.stage_url;
  if (typeof rawUrl !== "string" || rawUrl.length > MAX_URL_LENGTH) {
    throw invalid(`${label} (${name}) needs a stage-url string`);
  }
  const stageUrl = parseAllowedStageUrl(rawUrl);
  if (!stageUrl) {
    throw invalid(
      `${label} (${name}) stage-url must be an https URL on ${PYPI_STAGE_INDEX_ORIGINS.join(" or ")}`,
    );
  }
  const rawSession = entry["session-url"] ?? entry.session_url;
  if (
    rawSession !== undefined &&
    (typeof rawSession !== "string" || rawSession.length > MAX_URL_LENGTH)
  ) {
    throw invalid(`${label} (${name}) session-url must be a string`);
  }
  return { name, version, stageUrl, sessionUrl: rawSession ?? null };
}

/**
 * Accept only an https stage root on an allowlisted index origin. Credentials,
 * non-default ports, query strings, and fragments are refused: the project page
 * is built by appending a path segment, and a stage token must live in the
 * path where the PEP's `--extra-index-url` usage puts it.
 */
export function parseAllowedStageUrl(raw: string): URL | null {
  const url = parseStrictHttpsUrl(raw);
  if (!url || !PYPI_STAGE_INDEX_ORIGINS.includes(url.origin)) return null;
  return url;
}

/** https, no credentials, no explicit port, no query or fragment. */
export function parseStrictHttpsUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  if (url.search || url.hash || raw.includes("#") || raw.includes("?")) return null;
  return url;
}

/** PEP 503 project page under the stage root: `<root>/<normalized>/`. */
export function stageProjectUrl(stageUrl: URL, projectName: string): URL {
  const root = stageUrl.pathname.endsWith("/") ? stageUrl.pathname : `${stageUrl.pathname}/`;
  const url = new URL(stageUrl.toString());
  url.pathname = `${root}${encodeURIComponent(normalizePyPiProjectName(projectName))}/`;
  return url;
}

/** Merge entries from every `pypi-stage.json` the run uploaded. */
export function mergeStageReferences(
  references: PyPiStageReferenceEntry[][],
): Map<string, PyPiStageReferenceEntry> {
  const merged = new Map<string, PyPiStageReferenceEntry>();
  for (const entry of references.flat()) {
    const key = normalizePyPiProjectName(entry.name);
    const seen = merged.get(key);
    if (!seen) {
      merged.set(key, entry);
      continue;
    }
    if (
      !pyPiVersionsEquivalent(seen.version, entry.version) ||
      seen.stageUrl.href !== entry.stageUrl.href ||
      seen.sessionUrl !== entry.sessionUrl
    ) {
      throw invalid(`more than one stage reference names project ${entry.name}`);
    }
  }
  return merged;
}

// ── Simple index project page (PEP 691 JSON, PEP 503 HTML) ───────────────────

const PEP691_JSON_CONTENT_TYPE = "application/vnd.pypi.simple.v1+json";
const PEP691_HTML_CONTENT_TYPE = "application/vnd.pypi.simple.v1+html";
export const STAGE_INDEX_ACCEPT = `${PEP691_JSON_CONTENT_TYPE}, ${PEP691_HTML_CONTENT_TYPE};q=0.2, text/html;q=0.1`;
const MAX_STAGE_FILES = 20_000;
const SAFE_FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._+!-]{0,254}$/;

interface StageIndexFile {
  filename: string;
  sha256: string | null;
  /** Absolute download URL (a capability), or null when absent/unparseable. */
  url: URL | null;
  /** PEP 700 `size` (simple API 1.1+), or null when the page declares none. */
  size: number | null;
}

export interface StageProjectPage {
  /** The page's own project name (PEP 691 `name`); PEP 503 pages carry none. */
  name: string | null;
  files: StageIndexFile[];
}

export function parseStageProjectPage(
  body: string,
  contentType: string | null,
  pageUrl: URL,
): StageProjectPage {
  const type = (contentType ?? "").split(";")[0].trim().toLowerCase();
  if (type === PEP691_JSON_CONTENT_TYPE) return parsePep691Json(body, pageUrl);
  if (type === PEP691_HTML_CONTENT_TYPE || type === "text/html") {
    return parsePep503Html(body, pageUrl);
  }
  throw unavailable(`stage index answered with unsupported content type ${type || "(none)"}`);
}

function parsePep691Json(body: string, pageUrl: URL): StageProjectPage {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    throw unavailable("stage index JSON is malformed");
  }
  if (!isRecord(raw) || !isRecord(raw.meta) || !Array.isArray(raw.files)) {
    throw unavailable("stage index JSON is not a PEP 691 project page");
  }
  const apiVersion = raw.meta["api-version"];
  if (typeof apiVersion !== "string" || !/^1\.\d+$/.test(apiVersion)) {
    throw unavailable("stage index JSON uses an unsupported simple API version");
  }
  if (raw.files.length > MAX_STAGE_FILES) throw unavailable("stage index lists too many files");
  const files = raw.files.map((file): StageIndexFile => {
    if (!isRecord(file) || typeof file.filename !== "string") {
      throw unavailable("stage index JSON has a file entry without a filename");
    }
    const hashes = isRecord(file.hashes) ? file.hashes : {};
    return {
      filename: safeFilename(file.filename),
      sha256: normalizeSha256(hashes.sha256),
      url: resolveFileUrl(typeof file.url === "string" ? file.url : "", pageUrl),
      size:
        typeof file.size === "number" && Number.isSafeInteger(file.size) && file.size >= 0
          ? file.size
          : null,
    };
  });
  return { name: typeof raw.name === "string" ? raw.name : null, files };
}

// Anchors are the only structure PEP 503 defines. The page is hostile input:
// bounded by the caller's byte cap and by the file cap here, and only text is
// extracted — nothing is rendered, and URLs are followed only after the
// download policy admits them.
const ANCHOR_RE = /<a\b([^>]*)>([^<]*)<\/a\s*>/gi;
const HREF_RE = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;

function parsePep503Html(body: string, pageUrl: URL): StageProjectPage {
  const files: StageIndexFile[] = [];
  for (const match of body.matchAll(ANCHOR_RE)) {
    if (files.length >= MAX_STAGE_FILES) throw unavailable("stage index lists too many files");
    const hrefMatch = HREF_RE.exec(match[1]);
    const href = decodeEntities(hrefMatch?.[1] ?? hrefMatch?.[2] ?? hrefMatch?.[3] ?? "");
    const filename = safeFilename(decodeEntities(match[2]).trim());
    const fragment = href.includes("#") ? href.slice(href.indexOf("#") + 1) : "";
    const sha256 = /^sha256=([a-f0-9]{64})$/i.exec(fragment)?.[1] ?? null;
    files.push({
      filename,
      sha256: normalizeSha256(sha256),
      url: resolveFileUrl(href, pageUrl),
      size: null,
    });
  }
  return { name: null, files };
}

// PEP 503/691 allow relative file URLs; the fragment carries the hash, not
// part of the resource.
function resolveFileUrl(href: string, pageUrl: URL): URL | null {
  if (!href || href.length > MAX_URL_LENGTH) return null;
  try {
    const url = new URL(href, pageUrl);
    url.hash = "";
    return url;
  } catch {
    return null;
  }
}

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&amp;/g, "&");
}

function safeFilename(filename: string): string {
  if (!SAFE_FILENAME_RE.test(filename)) {
    throw unavailable("stage index lists a file with an unsafe filename");
  }
  return filename;
}

function normalizeSha256(value: unknown): string | null {
  return typeof value === "string" && SHA256_RE.test(value) ? value.toLowerCase() : null;
}

// ── Release file selection and identity ──────────────────────────────────────

/** Project name + version from a wheel or sdist filename, or null. */
export function parseDistributionFilename(
  filename: string,
): { name: string; version: string } | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".whl")) {
    // {distribution}-{version}(-{build})?-{python}-{abi}-{platform}.whl
    const parts = filename.slice(0, -4).split("-");
    if (parts.length !== 5 && parts.length !== 6) return null;
    return { name: parts[0], version: parts[1] };
  }
  const ext = [".tar.gz", ".zip", ".tgz"].find((suffix) => lower.endsWith(suffix));
  if (!ext) return null;
  const base = filename.slice(0, -ext.length);
  const cut = base.lastIndexOf("-");
  if (cut <= 0 || cut === base.length - 1) return null;
  return { name: base.slice(0, cut), version: base.slice(cut + 1) };
}

export interface StagedReleaseFile {
  filename: string;
  sha256: string;
  url: URL;
  size: number | null;
}

/**
 * The files a PEP 694 session for `project`/`version` would publish, as the
 * stage page lists them.
 *
 * A session publishes one name + version, so stage entries for other versions
 * cannot be published by it and are ignored, and so is an unparseable
 * filename that does not name this release (an index may overlay older
 * releases with legacy filenames). An entry that names another project, or an
 * unparseable one that starts with this project and version, fails the check
 * rather than riding along unreviewed. Every in-scope entry needs a sha256 and
 * a download URL, because Drydock reviews the staged bytes and checks them
 * against the digest the index declares.
 */
export function selectStagedReleaseFiles(
  page: StageProjectPage,
  project: string,
  version: string,
): { files: StagedReleaseFile[]; problems: string[] } {
  const normalized = normalizePyPiProjectName(project);
  const problems: string[] = [];
  if (page.name !== null && normalizePyPiProjectName(page.name) !== normalized) {
    problems.push(`stage page is for project ${page.name}, not ${project}`);
  }
  const byName = new Map<string, StagedReleaseFile>();
  for (const file of page.files) {
    const parsed = parseDistributionFilename(file.filename);
    if (!parsed) {
      if (mayNameRelease(file.filename, project, version)) {
        problems.push(`stage lists ${file.filename}, which is not a wheel or sdist of ${project}`);
      }
      continue;
    }
    if (normalizePyPiProjectName(parsed.name) !== normalized) {
      problems.push(`stage lists ${file.filename}, which belongs to another project`);
      continue;
    }
    if (!pyPiVersionsEquivalent(parsed.version, version)) continue;
    if (file.sha256 === null) {
      problems.push(`stage lists ${file.filename} without a sha256 digest`);
      continue;
    }
    if (file.url === null) {
      problems.push(`stage lists ${file.filename} without a download URL`);
      continue;
    }
    const seen = byName.get(file.filename);
    if (seen && seen.sha256 !== file.sha256) {
      problems.push(`stage lists ${file.filename} more than once with different digests`);
      continue;
    }
    byName.set(file.filename, {
      filename: file.filename,
      sha256: file.sha256,
      url: file.url,
      size: file.size,
    });
  }
  if (byName.size === 0 && problems.length === 0) {
    problems.push(`stage has no files for ${project} ${version}`);
  }
  return { files: [...byName.values()], problems };
}

// Separator-insensitive prefix test: `demo_package-1.2.0-x.exe` names
// demo-package 1.2.0, `demo_package-1.1.0.egg` does not. Erring towards a
// match is deliberate, since a match fails the review rather than passing it.
function mayNameRelease(filename: string, project: string, version: string): boolean {
  const fold = (value: string) => value.toLowerCase().replace(/[-_.]+/g, "-");
  const prefix = `${fold(project)}-${fold(version)}`;
  const folded = fold(filename);
  return folded === prefix || folded.startsWith(`${prefix}-`);
}

export interface NamedDigest {
  /** Filename, or an artifact path compared by basename. */
  path: string;
  sha256: string;
}

/**
 * Byte identity between two release file sets: the same filenames, each with
 * the same sha256, and nothing extra on either side. The labels name the
 * sides in maintainer-facing messages ("artifact", "stage"). A basename that
 * appears twice on one side is a problem in itself: comparing only one copy
 * would let the other ride along unbound.
 */
export function compareDistributionSets(
  leftLabel: string,
  left: NamedDigest[],
  rightLabel: string,
  right: NamedDigest[],
): string[] {
  const problems = [
    ...duplicateBasenames(left).map((name) => `${name} appears more than once in the ${leftLabel}`),
    ...duplicateBasenames(right).map(
      (name) => `${name} appears more than once on the ${rightLabel}`,
    ),
  ];
  const leftByName = digestsByBasename(left);
  const rightByName = digestsByBasename(right);
  for (const [filename, sha256] of leftByName) {
    const other = rightByName.get(filename);
    if (other === undefined) {
      problems.push(`${filename} is in the ${leftLabel} but not on the ${rightLabel}`);
    } else if (other !== sha256) {
      problems.push(
        `${filename} sha256 differs: ${leftLabel} ${digestPrefix(sha256)}, ${rightLabel} ${digestPrefix(other)}`,
      );
    }
  }
  for (const filename of rightByName.keys()) {
    if (!leftByName.has(filename)) {
      problems.push(`${filename} is on the ${rightLabel} but not in the ${leftLabel}`);
    }
  }
  return problems;
}

export function duplicateBasenames(entries: Array<{ path: string }>): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const entry of entries) {
    const name = basename(entry.path);
    if (seen.has(name)) duplicates.add(name);
    seen.add(name);
  }
  return [...duplicates];
}

function digestsByBasename(entries: NamedDigest[]): Map<string, string> {
  return new Map(entries.map((entry) => [basename(entry.path), entry.sha256.toLowerCase()]));
}

export function digestPrefix(sha256: string): string {
  return `${sha256.slice(0, 12)}…`;
}

export function basename(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? path : path.slice(cut + 1);
}

/** First few problems, joined for a maintainer-facing reason. */
export function summarizeProblems(problems: string[], limit = 3): string {
  const shown = problems.slice(0, limit).join("; ");
  return problems.length > limit ? `${shown}; +${problems.length - limit} more` : shown;
}

function invalid(message: string): PyPiStageError {
  return new PyPiStageError("stage_reference_invalid", message);
}

function unavailable(message: string): PyPiStageError {
  return new PyPiStageError("stage_unavailable", message);
}
