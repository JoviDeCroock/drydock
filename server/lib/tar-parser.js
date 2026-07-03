// Pure tar parsing helpers used by the sandbox download worker.
//
// This module is loaded two ways:
//   1. As an ESM module by the regression tests in `test/tar-parser.test.mjs`.
//   2. Through `Function.prototype.toString()` from `server/lib/sandbox.ts`,
//      which concatenates the source of each exported function into the
//      dynamic Worker that runs in the isolated sandbox.
//
// Constraints:
//   - Only built-in globals available in both Node and Cloudflare Workers
//     (crypto.subtle, TextDecoder, DecompressionStream) may be referenced.
//   - No external imports; everything must be self-contained.
//   - Identifier names matter: when the rendered source runs in the sandbox,
//     cross-function calls resolve by the lexical names below.

/** @typedef {{ path: string, size: number, sha256: string, flags: string[], textSample?: string }} ParsedFile */
/** @typedef {{ kind: "non-regular"|"duplicate"|"unicode-confusable"|"content-skipped", path: string, detail: string }} TarSuspiciousEntry */

export function readString(bytes, start, len) {
  let end = start;
  const limit = start + len;
  while (end < limit && bytes[end]) end++;
  // POSIX tar fields are NUL-terminated bytes with no declared charset, but
  // modern tars (including npm pack) put UTF-8 in there. Decoding as UTF-8
  // is needed so Unicode confusable checks see the actual codepoints rather
  // than per-byte latin-1 fragments.
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(start, end));
}

export function decodeText(bytes) {
  if (bytes.some((b) => b === 0)) return "";
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  // Count C0 control characters (other than tab/newline/CR) without spreading
  // the string into a per-codepoint array. decodeText now runs over whole files
  // rather than a bounded sample (issue #191): `[...text]` on a multi-megabyte
  // file would allocate one boxed string per character and blow the Worker
  // memory limit, so iterate code units in place instead.
  let control = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) control++;
  }
  if (control > Math.max(5, text.length * 0.02)) return "";
  return text;
}

export function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeStringRecord(value) {
  const out = {};
  if (!isPlainObject(value)) return out;
  for (const [key, nested] of Object.entries(value)) {
    if (typeof nested === "string") out[key] = nested;
  }
  return out;
}

export function normalizeStringList(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === "string");
}

// Strip zero-width and bidi/format characters and fold visually-confusable
// separators back to their ASCII forms before path checks. Without this,
// paths like `binding​.gyp` (zero-width space) or `binding⁄gyp`
// (fraction slash) would slip past `isRootGypPath` while npm's own extract
// may canonicalize the entry, producing a reviewer/consumer mismatch.
export function canonicalizePath(path) {
  if (typeof path !== "string") return "";
  return path
    .replace(/[\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF\u180E]/g, "")
    .replace(/[\u2044\u2215\uFF0F]/g, "/")
    .replace(/[\uFF3C]/g, "\\")
    .replace(/[\uFF0E\u2024]/g, ".");
}

export function hasUnicodeConfusables(path) {
  if (typeof path !== "string" || !path) return false;
  return canonicalizePath(path) !== path;
}

export function isRootGypPath(path) {
  if (typeof path !== "string") return false;
  const canonical = canonicalizePath(path);
  return !canonical.includes("/") && /\.gyp$/i.test(canonical);
}

export function hasImplicitNodeGypInstall(files, packageJson) {
  if (!isPlainObject(packageJson)) return false;
  const scripts = normalizeStringRecord(packageJson.scripts);
  const hasRootGyp = Array.isArray(files) && files.some((f) => f && isRootGypPath(f.path));
  return hasRootGyp && !scripts.install && !scripts.preinstall && packageJson.gypfile !== false;
}

export function isSafePaxPath(value) {
  const nul = String.fromCharCode(0);
  return typeof value === "string" && !value.includes(nul) && !value.includes("\\");
}

export function normalizeTarPath(rawPath) {
  const nul = String.fromCharCode(0);
  if (!rawPath || rawPath.includes(nul) || rawPath.includes("\\")) return null;
  let path = rawPath.replace(/^\/+/, "").replace(/^package\//, "");
  if (!path || path.startsWith("../") || path.includes("/../") || /^[A-Za-z]:/.test(path))
    return null;
  const parts = path.split("/").filter(Boolean);
  if (!parts.length || parts.some((part) => part === "." || part === "..")) return null;
  path = parts.join("/");
  // Re-check the drive-letter guard on the canonical form. Stripping the
  // `package/` prefix can re-expose one the early check missed: `package//C:`
  // reduces to `/C:` (leading slash dodges the early test), then collapsing the
  // empty segment joins it to `C:` — a Windows drive-relative path the parser
  // is meant to reject. Found by the archive-parser fuzz suite (issue #311).
  if (/^[A-Za-z]:/.test(path)) return null;
  if (path.length > 512) return null;
  return path;
}

export function normalizeZipPath(rawPath) {
  const nul = String.fromCharCode(0);
  if (!rawPath || rawPath.includes(nul) || rawPath.includes("\\")) return null;
  let path = rawPath.replace(/^\/+/, "");
  if (!path || path.endsWith("/") || path.startsWith("../") || path.includes("/../")) return null;
  if (/^[A-Za-z]:/.test(path)) return null;
  const parts = path.split("/").filter(Boolean);
  if (!parts.length || parts.some((part) => part === "." || part === "..")) return null;
  path = parts.join("/");
  if (path.length > 512) return null;
  return path;
}

export function parsePax(body) {
  const text = decodeText(body.subarray(0, Math.min(body.length, 8192)));
  const out = {};
  let index = 0;
  while (index < text.length) {
    const space = text.indexOf(" ", index);
    if (space === -1) break;
    const length = Number(text.slice(index, space));
    if (!Number.isFinite(length) || length <= 0) break;
    const record = text.slice(space + 1, index + length).replace(/\n$/, "");
    const equals = record.indexOf("=");
    if (equals > 0) out[record.slice(0, equals)] = record.slice(equals + 1);
    index += length;
  }
  return out;
}

// Map typeflag bytes to a short label used in tar.suspicious-entry findings.
// The standard ustar/POSIX values: 0 regular, 1 hardlink, 2 symlink,
// 3 char device, 4 block device, 5 directory, 6 fifo, 7 contiguous/reserved.
export function describeNonRegularType(type) {
  switch (type) {
    case "1":
      return "hardlink";
    case "2":
      return "symlink";
    case "3":
      return "character-device";
    case "4":
      return "block-device";
    case "5":
      return "directory";
    case "6":
      return "fifo";
    case "7":
      return "reserved";
    default:
      return "non-regular";
  }
}

export async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function summarizeFile(path, body) {
  const flags = [];
  const skipTextSample = shouldSkipTextSample(path);
  if (skipTextSample) flags.push("text-sample-skipped");
  const hash = await sha256Hex(body);
  if (skipTextSample) {
    return {
      path,
      size: body.length,
      sha256: hash,
      flags,
    };
  }
  // Decode the WHOLE file, not a fixed-size head. Deterministic detection runs
  // over textSample in the parent worker, so clipping here is exactly the
  // truncation hole that lets an attacker bury a payload past a fixed window
  // (issue #191). The persisted/display sample is bounded separately at the
  // persistence layer; per-body work is bounded by the per-file cap and total
  // retained bytes by the streaming reader's retention budget and MAX_FILES.
  const text = decodeText(body);
  if (!text) flags.push("binary");
  return {
    path,
    size: body.length,
    sha256: hash,
    flags,
    ...(text ? { textSample: text } : {}),
  };
}

export function shouldSkipTextSample(path) {
  const normalized = String(path || "")
    .replaceAll("\\", "/")
    .toLowerCase();
  const basename = normalized.slice(normalized.lastIndexOf("/") + 1);

  // Source maps and minified bundles are generated, large, and hostile to a
  // human diff, so we keep their metadata/hashes but skip the text sample.
  // TypeScript declaration files (.d.ts) are deliberately NOT skipped: they are
  // small, human-readable, and describe the package's public API surface, which
  // is exactly what supply-chain review needs to diff.
  if (basename.endsWith(".map")) return true;
  if (/\.min\.(?:js|mjs|cjs|css)$/.test(basename)) return true;

  return false;
}

export function summarizeSkippedFile(path, size) {
  // Metadata-only record for an entry whose body exceeded the retention limit:
  // path and declared size are kept so the release manifest stays complete, but
  // the content was never buffered, so there is no hash or text sample.
  return { path, size, sha256: "", flags: ["content-skipped"] };
}

// Manifests carry the identity/metadata every ecosystem review depends on
// (name, version, install hooks, dependency and RECORD/METADATA data), so they
// must always be inspected even when the retention budget has been spent on
// large prepackaged binaries. Matching by basename covers npm's `package.json`,
// PyPI sdists' `PKG-INFO`/`pyproject.toml`, and wheel `METADATA` regardless of
// the version directory the archive nests them under. A manifest too large to
// inspect fails the parse (see readTarStream) rather than silently nulling the
// package's identity.
export function isRetainedManifestPath(path) {
  const normalized = String(path || "").replaceAll("\\", "/");
  const basename = normalized.slice(normalized.lastIndexOf("/") + 1);
  return (
    basename === "package.json" ||
    basename === "PKG-INFO" ||
    basename === "pyproject.toml" ||
    basename === "METADATA"
  );
}

// Tags a parser safety-limit / malformed-archive error so the sandbox worker can
// distinguish it from an upstream gzip/stream failure without matching on exact
// message strings (which silently drift when a message is reworded).
export function tarError(message) {
  const err = new Error(message);
  err.tarSafety = true;
  return err;
}

export async function readTar(buffer, maxFiles, maxTarBytes) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  return readTarStream(new Response(bytes).body, maxFiles, maxTarBytes, Infinity);
}

// Streaming tar reader. Walks entries sequentially as decompressed bytes
// arrive, so the whole archive never has to fit in memory: `maxTarBytes`
// bounds the bytes *retained* for inspection (per entry and cumulatively),
// while `maxStreamBytes` bounds the total bytes consumed from the stream.
// Regular files whose body would blow the retention budget are recorded as
// content-skipped (path + declared size, no hash/text) instead of failing the
// parse — the esbuild/rover pattern of multi-hundred-megabyte prepackaged
// platform binaries alongside a small manifest.
export async function readTarStream(body, maxFiles, maxTarBytes, maxStreamBytes) {
  const nul = String.fromCharCode(0);
  if (!body) throw tarError("tarball decompression failed");
  const reader = body.getReader();
  const chunks = [];
  let buffered = 0;
  let streamed = 0;
  let streamDone = false;

  async function fill(target) {
    while (buffered < target && !streamDone) {
      const { value, done } = await reader.read();
      if (done) {
        streamDone = true;
        break;
      }
      streamed += value.byteLength;
      if (streamed > maxStreamBytes) throw tarError("archive expands beyond safety limit");
      chunks.push(value);
      buffered += value.byteLength;
    }
    return buffered >= target;
  }

  function take(count) {
    const out = new Uint8Array(count);
    let offset = 0;
    while (offset < count) {
      const head = chunks[0];
      const need = count - offset;
      if (head.byteLength <= need) {
        out.set(head, offset);
        offset += head.byteLength;
        buffered -= head.byteLength;
        chunks.shift();
      } else {
        out.set(head.subarray(0, need), offset);
        chunks[0] = head.subarray(need);
        buffered -= need;
        offset = count;
      }
    }
    return out;
  }

  async function discard(count) {
    let remaining = count;
    while (remaining > 0) {
      if (!buffered && !(await fill(1))) return false;
      const head = chunks[0];
      if (head.byteLength <= remaining) {
        remaining -= head.byteLength;
        buffered -= head.byteLength;
        chunks.shift();
      } else {
        chunks[0] = head.subarray(remaining);
        buffered -= remaining;
        remaining = 0;
      }
    }
    return true;
  }

  const files = [];
  const suspicious = [];
  const suspiciousLimit = Math.max(1, Number.isFinite(maxFiles) ? maxFiles : 250);
  let suspiciousLimitReached = false;
  const seenPaths = new Map();
  // Bytes each retained path contributes to `retainedBytes`, so a later
  // duplicate that replaces an entry releases the earlier body's budget instead
  // of double-counting it (which would prematurely exhaust the retention limit).
  const retainedByPath = new Map();
  let nextLongName = null;
  let pax = null;
  let retainedBytes = 0;

  function addSuspicious(entry) {
    if (suspicious.length < suspiciousLimit) {
      suspicious.push(entry);
      return;
    }
    if (!suspiciousLimitReached) {
      suspiciousLimitReached = true;
      suspicious.push({
        kind: "non-regular",
        path: "<archive>",
        detail: `suspicious entry limit reached (${suspiciousLimit}); additional entries omitted`,
      });
    }
  }

  try {
    while (await fill(512)) {
      const header = take(512);
      if (header.every((b) => b === 0)) break;

      const rawName = readString(header, 0, 100);
      const prefix = readString(header, 345, 155);
      const sizeText = readString(header, 124, 12).trim() || "0";
      if (!/^[0-7]+$/.test(sizeText)) throw tarError("invalid tar entry size");
      const size = parseInt(sizeText, 8);
      if (!Number.isFinite(size) || size < 0) throw tarError("invalid tar entry size");
      const type = String.fromCharCode(header[156] || 48);
      const isRegular = type === "0" || type === nul;
      const padding = Math.ceil(size / 512) * 512 - size;

      // Only regular files stream-skip oversized bodies (the prepackaged-binary
      // case). Metadata (x/g/L) and non-regular entries must be materialized or
      // are never legitimately huge, so an oversized body is malformed/hostile —
      // fail closed rather than burn the sandbox's CPU budget discarding it.
      if (!isRegular && size > maxTarBytes) throw tarError("invalid tar entry size");

      if (type === "x" || type === "g" || type === "L") {
        if (!(await fill(size))) throw tarError("truncated tar entry");
        const body = take(size);
        if (type === "x") {
          // Local PAX header. Its path attribute applies only to the next entry.
          pax = parsePax(body);
          if (pax && typeof pax.path === "string" && !isSafePaxPath(pax.path)) {
            throw tarError("invalid pax path");
          }
        } else if (type === "g") {
          // Global PAX metadata does not override the path of following entries.
          // Ignoring path here keeps scanner paths aligned with tar extraction.
          parsePax(body);
          nextLongName = null;
          pax = null;
        } else {
          // readString already stops at the first NUL terminator, so the long-name
          // payload is implicitly trimmed at the NUL boundary.
          const candidate = readString(body, 0, body.length);
          if (!isSafePaxPath(candidate)) throw tarError("invalid long-name path");
          nextLongName = candidate;
        }
      } else if (isRegular) {
        const rawCandidate =
          (pax && pax.path) || nextLongName || (prefix ? prefix + "/" : "") + rawName;
        const canonicalCandidate = canonicalizePath(rawCandidate);
        const path = normalizeTarPath(rawCandidate);
        const canonicalPath = normalizeTarPath(canonicalCandidate);
        if (rawCandidate !== canonicalCandidate) {
          addSuspicious({
            kind: "unicode-confusable",
            path: canonicalPath || path || "<invalid-path>",
            detail: canonicalPath
              ? "path contained zero-width or visually-confusable characters"
              : "path contained zero-width or visually-confusable characters and normalized to an unsafe path",
          });
        }
        // The root npm manifest is the one file parsePackageJson depends on, and
        // a body too large to inspect there would silently null the manifest and
        // disable every manifest-derived detection. A >25MB package.json is only
        // ever hostile, so fail closed. Nested/vendored manifest-named files are
        // not the package manifest, so they are skipped (below), not fatal.
        if (path === "package.json" && size > maxTarBytes) {
          throw tarError("invalid tar entry size");
        }
        // Manifests bypass the shared retention budget so a package's identity is
        // always inspected even behind large binaries, but they draw on a bounded
        // headroom (a second maxTarBytes) rather than an unlimited bypass — a tar
        // stuffed with manifest-named files cannot amplify retained memory past
        // 2×maxTarBytes.
        const mustRetainBody = path ? isRetainedManifestPath(path) : false;
        const retainBody =
          size <= maxTarBytes &&
          (retainedBytes + size <= maxTarBytes ||
            (mustRetainBody && retainedBytes + size <= 2 * maxTarBytes));
        let summarized = null;
        let contributed = 0;
        if (path && retainBody) {
          if (!(await fill(size))) throw tarError("truncated tar entry");
          summarized = await summarizeFile(path, take(size));
          contributed = size;
        } else {
          if (!(await discard(size))) throw tarError("truncated tar entry");
          if (path) {
            summarized = summarizeSkippedFile(path, size);
            // Distinguish a body too large to inspect on its own from a small
            // body skipped only because earlier files spent the shared budget —
            // the message is user-facing evidence and must be accurate.
            const detail =
              size > maxTarBytes
                ? `file body (${size} bytes) exceeds the ${maxTarBytes}-byte per-file inspection limit`
                : `file body (${size} bytes) did not fit the archive's ${maxTarBytes}-byte cumulative retention budget already spent on earlier files`;
            addSuspicious({
              kind: "content-skipped",
              path,
              detail: `${detail}; metadata recorded but content not inspected`,
            });
          }
        }
        if (path && summarized) {
          if (seenPaths.has(path)) {
            // Match last-write-wins extraction so downstream checks inspect the
            // bytes consumers are likely to receive, while still surfacing the duplicate.
            addSuspicious({
              kind: "duplicate",
              path,
              detail: "duplicate path; later entry replaced earlier entry",
            });
            retainedBytes -= retainedByPath.get(path) || 0;
            files[seenPaths.get(path)] = summarized;
          } else {
            if (files.length >= maxFiles) throw tarError("archive contains too many files");
            seenPaths.set(path, files.length);
            files.push(summarized);
          }
          retainedByPath.set(path, contributed);
          retainedBytes += contributed;
        }
        nextLongName = null;
        pax = null;
      } else {
        // Non-regular entry (hardlink, symlink, device, directory, fifo,
        // reserved). npm publish never emits these; a hand-crafted tar can.
        const rawCandidate =
          (pax && pax.path) || nextLongName || (prefix ? prefix + "/" : "") + rawName;
        const reportedPath = normalizeTarPath(canonicalizePath(rawCandidate)) || rawCandidate || "";
        addSuspicious({
          kind: "non-regular",
          path: reportedPath,
          detail: `typeflag ${type} (${describeNonRegularType(type)})`,
        });
        if (!(await discard(size))) throw tarError("truncated tar entry");
        nextLongName = null;
        pax = null;
      }

      // Inter-entry padding; a missing final pad block is tolerated like the
      // buffer reader tolerated a trailing partial block.
      if (padding > 0) await discard(padding);
    }
    return { files, suspicious };
  } finally {
    // Release the stream on every exit — success, break, or any thrown parser
    // error — so a malformed archive never leaves the reader lock held and the
    // upstream fetch/DecompressionStream pipe open against the sandbox budget.
    reader.cancel().catch(() => undefined);
  }
}

export function readUint16Le(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

export function readUint32Le(bytes, offset) {
  return (
    (bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)) >>>
    0
  );
}

export function findZipEndOfCentralDirectory(bytes) {
  const minOffset = Math.max(0, bytes.length - 65557);
  for (let offset = bytes.length - 22; offset >= minOffset; offset -= 1) {
    if (readUint32Le(bytes, offset) === 0x06054b50) return offset;
  }
  return -1;
}

export async function inflateRawBounded(bytes, maxBytes) {
  const reader = new Response(bytes).body
    .pipeThrough(new DecompressionStream("deflate-raw"))
    .getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      reader.cancel().catch(() => undefined);
      throw new Error("archive expands beyond safety limit");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export async function readZipArchive(buffer, maxFiles, maxArchiveBytes) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const eocd = findZipEndOfCentralDirectory(bytes);
  if (eocd < 0) throw new Error("zip central directory not found");

  const entryCount = readUint16Le(bytes, eocd + 10);
  const centralDirectorySize = readUint32Le(bytes, eocd + 12);
  const centralDirectoryOffset = readUint32Le(bytes, eocd + 16);
  if (
    entryCount === 0xffff ||
    centralDirectorySize === 0xffffffff ||
    centralDirectoryOffset === 0xffffffff
  ) {
    throw new Error("zip64 archives are not supported");
  }
  if (centralDirectoryOffset + centralDirectorySize > bytes.length) {
    throw new Error("truncated zip central directory");
  }

  const files = [];
  let expandedBytes = 0;
  let offset = centralDirectoryOffset;
  const pathDecoder = new TextDecoder("utf-8", { fatal: false });
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > bytes.length || readUint32Le(bytes, offset) !== 0x02014b50) {
      throw new Error("invalid zip central directory");
    }
    const compressionMethod = readUint16Le(bytes, offset + 10);
    const compressedSize = readUint32Le(bytes, offset + 20);
    const uncompressedSize = readUint32Le(bytes, offset + 24);
    const fileNameLength = readUint16Le(bytes, offset + 28);
    const extraLength = readUint16Le(bytes, offset + 30);
    const commentLength = readUint16Le(bytes, offset + 32);
    const localHeaderOffset = readUint32Le(bytes, offset + 42);
    const fileNameStart = offset + 46;
    const fileNameEnd = fileNameStart + fileNameLength;
    if (fileNameEnd > bytes.length) throw new Error("truncated zip filename");

    const rawPath = pathDecoder.decode(bytes.subarray(fileNameStart, fileNameEnd));
    const path = normalizeZipPath(rawPath);
    offset = fileNameEnd + extraLength + commentLength;

    if (!path) continue;
    if (files.length >= maxFiles) throw new Error("archive contains too many files");
    if (uncompressedSize > maxArchiveBytes || expandedBytes + uncompressedSize > maxArchiveBytes) {
      throw new Error("archive expands beyond safety limit");
    }
    if (
      localHeaderOffset + 30 > bytes.length ||
      readUint32Le(bytes, localHeaderOffset) !== 0x04034b50
    ) {
      throw new Error("invalid zip local header");
    }
    const localFileNameLength = readUint16Le(bytes, localHeaderOffset + 26);
    const localExtraLength = readUint16Le(bytes, localHeaderOffset + 28);
    const dataOffset = localHeaderOffset + 30 + localFileNameLength + localExtraLength;
    if (dataOffset + compressedSize > bytes.length) throw new Error("truncated zip entry");

    let body;
    if (compressionMethod === 0) {
      body = bytes.subarray(dataOffset, dataOffset + compressedSize);
    } else if (compressionMethod === 8) {
      body = await inflateRawBounded(
        bytes.subarray(dataOffset, dataOffset + compressedSize),
        maxArchiveBytes,
      );
    } else {
      throw new Error("unsupported zip compression method");
    }
    if (body.length !== uncompressedSize) throw new Error("zip entry size mismatch");
    expandedBytes += body.length;
    files.push(await summarizeFile(path, body));
  }
  return files;
}

export async function readStreamBounded(body, maxBytes) {
  if (!body) throw new Error("archive download failed");
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      reader.cancel().catch(() => undefined);
      throw new Error("archive too large");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export function parsePackageJson(files) {
  const pkg = files.find((f) => f.path === "package.json" && f.textSample);
  if (!pkg || !pkg.textSample) return null;
  try {
    const parsed = JSON.parse(pkg.textSample);
    if (!isPlainObject(parsed)) return null;
    const scripts = normalizeStringRecord(parsed.scripts);
    const npmAddsNodeGypInstall = hasImplicitNodeGypInstall(files, parsed);
    return {
      name: parsed.name,
      version: parsed.version,
      scripts: npmAddsNodeGypInstall ? { ...scripts, install: "node-gyp rebuild" } : scripts,
      ...(npmAddsNodeGypInstall ? { implicitScripts: { install: "node-gyp rebuild" } } : {}),
      ...(npmAddsNodeGypInstall || typeof parsed.gypfile !== "undefined"
        ? { gypfile: npmAddsNodeGypInstall ? true : parsed.gypfile }
        : {}),
      dependencies: parsed.dependencies || {},
      devDependencies: parsed.devDependencies || {},
      peerDependencies: parsed.peerDependencies || {},
      optionalDependencies: parsed.optionalDependencies || {},
      ...(normalizeStringList(parsed.files).length
        ? { files: normalizeStringList(parsed.files) }
        : {}),
      bin: parsed.bin,
      main: parsed.main,
      module: parsed.module,
      types: parsed.types,
      exports: parsed.exports,
    };
  } catch {
    return null;
  }
}
