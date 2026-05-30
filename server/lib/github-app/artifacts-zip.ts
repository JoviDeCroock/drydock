import {
  findZipEndOfCentralDirectory,
  inflateRawBounded,
  normalizeZipPath,
  readUint16Le,
  readUint32Le,
} from "../tar-parser.js";
import {
  MAX_OUTER_ZIP_BYTES,
  MAX_OUTER_ZIP_ENTRIES,
  MAX_PER_ENTRY_BYTES,
  WorkflowArtifactError,
} from "./artifacts";

export interface ExtractedEntry {
  path: string;
  bytes: Uint8Array;
}

export async function extractOuterZipEntries(zip: Uint8Array): Promise<ExtractedEntry[]> {
  const eocd = findZipEndOfCentralDirectory(zip);
  if (eocd < 0) {
    throw new WorkflowArtifactError(
      "bundle_unavailable",
      "artifact zip central directory not found",
    );
  }
  const entryCount = readUint16Le(zip, eocd + 10);
  const centralDirectorySize = readUint32Le(zip, eocd + 12);
  const centralDirectoryOffset = readUint32Le(zip, eocd + 16);
  if (
    entryCount === 0xffff ||
    centralDirectorySize === 0xffffffff ||
    centralDirectoryOffset === 0xffffffff
  ) {
    throw new WorkflowArtifactError("bundle_unavailable", "zip64 archives are not supported");
  }
  if (entryCount > MAX_OUTER_ZIP_ENTRIES) {
    throw new WorkflowArtifactError("bundle_too_large", "artifact zip contains too many entries");
  }
  if (centralDirectoryOffset + centralDirectorySize > zip.byteLength) {
    throw new WorkflowArtifactError("bundle_unavailable", "truncated zip central directory");
  }

  const entries: ExtractedEntry[] = [];
  let totalExpanded = 0;
  let offset = centralDirectoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > zip.byteLength || readUint32Le(zip, offset) !== 0x02014b50) {
      throw new WorkflowArtifactError("bundle_unavailable", "invalid zip central directory entry");
    }
    const compressionMethod = readUint16Le(zip, offset + 10);
    const compressedSize = readUint32Le(zip, offset + 20);
    const uncompressedSize = readUint32Le(zip, offset + 24);
    const fileNameLength = readUint16Le(zip, offset + 28);
    const extraLength = readUint16Le(zip, offset + 30);
    const commentLength = readUint16Le(zip, offset + 32);
    const localHeaderOffset = readUint32Le(zip, offset + 42);
    const fileNameStart = offset + 46;
    const fileNameEnd = fileNameStart + fileNameLength;
    if (fileNameEnd > zip.byteLength) {
      throw new WorkflowArtifactError("bundle_unavailable", "truncated zip filename");
    }
    const rawPath = new TextDecoder("utf-8", { fatal: false }).decode(
      zip.subarray(fileNameStart, fileNameEnd),
    );
    offset = fileNameEnd + extraLength + commentLength;

    // Directory entries / paths that fail normalization → reject hard. Path
    // traversal in artifact entries is `artifact_path_unsafe`. Directory
    // markers (trailing slash) are silently skipped because GitHub's
    // upload-artifact action always packs files only — this matches the
    // existing readZipArchive semantics.
    if (!rawPath || rawPath.endsWith("/")) continue;
    if (containsPathTraversal(rawPath)) {
      throw new WorkflowArtifactError(
        "artifact_path_unsafe",
        `zip entry ${rawPath} has an unsafe path`,
      );
    }
    const path = normalizeZipPath(rawPath);
    if (!path) {
      throw new WorkflowArtifactError(
        "artifact_path_unsafe",
        `zip entry ${rawPath} has an unsafe path`,
      );
    }
    if (uncompressedSize > MAX_PER_ENTRY_BYTES) {
      throw new WorkflowArtifactError("bundle_too_large", `zip entry ${path} is too large`);
    }
    if (totalExpanded + uncompressedSize > MAX_OUTER_ZIP_BYTES) {
      throw new WorkflowArtifactError("bundle_too_large", "zip expands beyond safety limit");
    }
    if (
      localHeaderOffset + 30 > zip.byteLength ||
      readUint32Le(zip, localHeaderOffset) !== 0x04034b50
    ) {
      throw new WorkflowArtifactError("bundle_unavailable", "invalid zip local header");
    }
    const localFileNameLength = readUint16Le(zip, localHeaderOffset + 26);
    const localExtraLength = readUint16Le(zip, localHeaderOffset + 28);
    const dataOffset = localHeaderOffset + 30 + localFileNameLength + localExtraLength;
    if (dataOffset + compressedSize > zip.byteLength) {
      throw new WorkflowArtifactError("bundle_unavailable", "truncated zip entry");
    }
    let body: Uint8Array;
    if (compressionMethod === 0) {
      body = zip.subarray(dataOffset, dataOffset + compressedSize).slice();
    } else if (compressionMethod === 8) {
      body = await inflateRawBounded(
        zip.subarray(dataOffset, dataOffset + compressedSize),
        MAX_OUTER_ZIP_BYTES,
      );
    } else {
      throw new WorkflowArtifactError(
        "bundle_unavailable",
        `unsupported zip compression method ${compressionMethod}`,
      );
    }
    if (body.byteLength !== uncompressedSize) {
      throw new WorkflowArtifactError("bundle_unavailable", "zip entry size mismatch");
    }
    totalExpanded += body.byteLength;
    entries.push({ path, bytes: body });
  }
  return entries;
}

function containsPathTraversal(rawPath: string): boolean {
  if (rawPath.includes("\0") || rawPath.includes("\\")) return true;
  if (rawPath.startsWith("/")) return true;
  if (rawPath.startsWith("../") || rawPath.includes("/../") || rawPath.endsWith("/..")) return true;
  if (/^[A-Za-z]:/.test(rawPath)) return true;
  return false;
}
