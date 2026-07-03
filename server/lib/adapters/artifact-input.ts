import type { FileRecord } from "../review";
import type { TarSuspiciousEntry } from "../tar-parser.js";

export interface ArtifactFilesInput {
  path: string;
  files: FileRecord[];
  suspiciousEntries?: TarSuspiciousEntry[];
}

const SUSPICIOUS_ENTRY_KINDS = new Set([
  "non-regular",
  "duplicate",
  "unicode-confusable",
  "content-skipped",
]);

// The sandbox parser caps suspicious entries at maxFiles; this bounds the
// re-validation on the adapter-input boundary so a hand-crafted input (not
// straight from the sandbox) cannot materialize an unbounded array.
const SUSPICIOUS_ENTRY_INPUT_LIMIT = 5_000;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isSafeManifestPath(path: string): boolean {
  if (!path || path.length > 512 || path.includes("\0") || path.includes("\\")) return false;
  if (path.startsWith("/") || path.startsWith("../") || path.includes("/../")) return false;
  if (/^[A-Za-z]:/.test(path)) return false;
  return path.split("/").every((part) => part && part !== "." && part !== "..");
}

/**
 * Re-validate parsed artifact `{ path, files, suspiciousEntries }` inputs on the
 * adapter-input boundary. Shared by ecosystem adapters whose pipeline input
 * carries sandbox-parsed file records (crates, Go modules).
 */
export function parseArtifactFilesInputs(raw: unknown, field: string): ArtifactFilesInput[] {
  if (!Array.isArray(raw) || !raw.length) {
    throw new Error(`adapter input must include ${field}`);
  }
  return raw.map((artifact, index) => {
    if (!isRecord(artifact)) throw new Error(`${field}[${index}] must be an object`);
    const path = typeof artifact.path === "string" ? artifact.path : "";
    if (!isSafeManifestPath(path)) throw new Error(`${field}[${index}] path is not safe`);
    if (!Array.isArray(artifact.files))
      throw new Error(`${field}[${index}] files must be an array`);
    const suspiciousEntries = parseSuspiciousEntries(artifact.suspiciousEntries);
    return {
      path,
      files: artifact.files.map((file, fileIndex) =>
        parseFileRecord(file, field, index, fileIndex),
      ),
      ...(suspiciousEntries ? { suspiciousEntries } : {}),
    };
  });
}

// Preserve (and re-validate) the tar-parser's suspicious entries across the
// adapter-input boundary so oversized content-skipped bodies still reach the
// gate's findings instead of being silently dropped during input parsing.
function parseSuspiciousEntries(raw: unknown): TarSuspiciousEntry[] | undefined {
  if (!Array.isArray(raw) || !raw.length) return undefined;
  const entries: TarSuspiciousEntry[] = [];
  for (const item of raw.slice(0, SUSPICIOUS_ENTRY_INPUT_LIMIT)) {
    if (!isRecord(item)) continue;
    if (typeof item.kind !== "string" || !SUSPICIOUS_ENTRY_KINDS.has(item.kind)) continue;
    entries.push({
      kind: item.kind as TarSuspiciousEntry["kind"],
      path: typeof item.path === "string" ? item.path : "",
      detail: typeof item.detail === "string" ? item.detail : "",
    });
  }
  return entries.length ? entries : undefined;
}

function parseFileRecord(
  raw: unknown,
  field: string,
  artifactIndex: number,
  fileIndex: number,
): FileRecord {
  if (!isRecord(raw)) {
    throw new Error(`${field}[${artifactIndex}].files[${fileIndex}] must be an object`);
  }
  const path = typeof raw.path === "string" ? raw.path : "";
  const size = typeof raw.size === "number" ? raw.size : 0;
  const sha256 = typeof raw.sha256 === "string" ? raw.sha256 : "";
  const flags = Array.isArray(raw.flags)
    ? raw.flags.filter((flag): flag is string => typeof flag === "string")
    : [];
  return {
    path,
    size,
    sha256,
    flags,
    ...(typeof raw.textSample === "string" ? { textSample: raw.textSample } : {}),
  };
}

/**
 * Strip the single shared top-level directory from an archive's file paths
 * (a `.crate`'s `{name}-{version}/`), so staged/baseline diffs align across
 * versions. Returns the files unchanged when there is no common root.
 */
export function stripCommonArchiveRoot(files: FileRecord[]): FileRecord[] {
  const pathParts = files.map((file) => file.path.split("/"));
  if (!pathParts.length || pathParts.some((parts) => parts.length < 2)) return files;
  const root = pathParts[0][0];
  if (!root || pathParts.some((parts) => parts[0] !== root)) return files;
  return files.map((file) => ({
    ...file,
    path: file.path.split("/").slice(1).join("/"),
  }));
}
