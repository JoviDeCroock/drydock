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

// Incremental SHA-256 for entry bodies that are discarded rather than
// retained. In the sandbox (workerd) this rides `crypto.DigestStream`, which
// hashes chunks as they pass through without accumulating them — a skipped
// multi-hundred-megabyte binary costs native hashing CPU, not memory. Node
// (the logic-test runner) has no DigestStream, so the fallback buffers chunks
// and one-shot digests; test fixtures are small, and the sandbox never takes
// that branch.
export function createSha256Digester() {
  if (typeof crypto !== "undefined" && typeof crypto.DigestStream === "function") {
    const stream = new crypto.DigestStream("SHA-256");
    const writer = stream.getWriter();
    return {
      update(chunk) {
        return writer.write(chunk);
      },
      async finalize() {
        await writer.close();
        const digest = await stream.digest;
        return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
      },
    };
  }
  const chunks = [];
  let total = 0;
  return {
    update(chunk) {
      chunks.push(chunk);
      total += chunk.byteLength;
    },
    async finalize() {
      const out = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return sha256Hex(out);
    },
  };
}

// Bounded sequential reader over a ReadableStream, shared by the streaming
// tar and zip parsers. `fill` buffers ahead, `take` consumes exactly-filled
// bytes, `discard` drops bytes without retaining them (optionally feeding
// each dropped chunk to a sink, e.g. a digester or an inflater). `consumed`
// is the absolute stream offset of the next unread byte — the zip parser
// uses it to record local-header offsets for the central-directory
// cross-check. `maxStreamBytes` bounds total bytes pulled from the stream.
export function createStreamCursor(body, maxStreamBytes) {
  const reader = body.getReader();
  const streamLimit = Number.isFinite(maxStreamBytes) ? maxStreamBytes : Infinity;
  const chunks = [];
  let buffered = 0;
  let streamed = 0;
  let consumedBytes = 0;
  let streamDone = false;

  async function fill(target) {
    while (buffered < target && !streamDone) {
      const { value, done } = await reader.read();
      if (done) {
        streamDone = true;
        break;
      }
      streamed += value.byteLength;
      if (streamed > streamLimit) {
        reader.cancel().catch(() => undefined);
        throw tarError("archive expands beyond safety limit");
      }
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
    consumedBytes += count;
    return out;
  }

  async function discard(count, sink) {
    let remaining = count;
    while (remaining > 0) {
      if (!buffered && !(await fill(1))) return false;
      const head = chunks[0];
      if (head.byteLength <= remaining) {
        if (sink) await sink(head);
        remaining -= head.byteLength;
        buffered -= head.byteLength;
        consumedBytes += head.byteLength;
        chunks.shift();
      } else {
        if (sink) await sink(head.subarray(0, remaining));
        chunks[0] = head.subarray(remaining);
        buffered -= remaining;
        consumedBytes += remaining;
        remaining = 0;
      }
    }
    return true;
  }

  function cancel() {
    reader.cancel().catch(() => undefined);
  }

  function consumed() {
    return consumedBytes;
  }

  return { fill, take, discard, cancel, consumed };
}

// Identify a native/executable container from a file's leading bytes. Runs on
// hostile evidence: it only reads fixed offsets and never interprets content.
// Extension checks alone skew detection toward Windows (`.exe`/`.dll`) — Linux
// ELF and macOS Mach-O binaries inside packages are conventionally
// extensionless (`bin/foo-linux-x64`), so the native-artifact rule needs this
// content signal. Must stay self-contained (no module-level constants): it is
// serialized into the sandbox worker via renderTarParserSource.
export function sniffNativeArtifact(bytes) {
  if (!bytes || bytes.byteLength < 4) return null;
  const b0 = bytes[0];
  const b1 = bytes[1];
  const b2 = bytes[2];
  const b3 = bytes[3];
  if (b0 === 0x7f && b1 === 0x45 && b2 === 0x4c && b3 === 0x46) return "elf";
  if (b0 === 0x00 && b1 === 0x61 && b2 === 0x73 && b3 === 0x6d) return "wasm";
  const magic = b0 * 0x1000000 + b1 * 0x10000 + b2 * 0x100 + b3;
  // Thin Mach-O, both widths and endiannesses.
  if (
    magic === 0xfeedface ||
    magic === 0xfeedfacf ||
    magic === 0xcefaedfe ||
    magic === 0xcffaedfe
  ) {
    return "macho";
  }
  // Fat/universal Mach-O shares 0xCAFEBABE with Java class files. Disambiguate
  // like file(1): the next big-endian u32 is the architecture count for a fat
  // binary (small), but the class-file version for Java (>= 45).
  if ((magic === 0xcafebabe || magic === 0xbebafeca) && bytes.byteLength >= 8) {
    const swapped = magic === 0xbebafeca;
    const count = swapped
      ? bytes[7] * 0x1000000 + bytes[6] * 0x10000 + bytes[5] * 0x100 + bytes[4]
      : bytes[4] * 0x1000000 + bytes[5] * 0x10000 + bytes[6] * 0x100 + bytes[7];
    return count > 0 && count < 20 ? "macho" : null;
  }
  // MZ (DOS/PE). The definitive PE check needs e_lfanew, which can point past
  // a captured head, so accept the DOS header alone — but require the NUL
  // bytes every real 64-byte DOS header contains so prose that merely starts
  // with "MZ" is not flagged.
  if (b0 === 0x4d && b1 === 0x5a && bytes.byteLength >= 64) {
    for (let i = 2; i < 64; i++) {
      if (bytes[i] === 0) return "pe";
    }
  }
  return null;
}

// Retain the first `limit` bytes flowing through a discard sink so a
// content-skipped body can still be magic-byte sniffed without buffering the
// body. Must stay self-contained: serialized into the sandbox worker via
// renderTarParserSource.
export function createHeadCapture(limit) {
  const head = new Uint8Array(limit);
  let filled = 0;
  return {
    update(chunk) {
      if (filled >= limit || !chunk || !chunk.byteLength) return;
      const take = Math.min(limit - filled, chunk.byteLength);
      head.set(chunk.subarray(0, take), filled);
      filled += take;
    },
    bytes() {
      return head.subarray(0, filled);
    },
  };
}

export async function summarizeFile(path, body) {
  const flags = [];
  const skipTextSample = shouldSkipTextSample(path);
  if (skipTextSample) flags.push("text-sample-skipped");
  const native = sniffNativeArtifact(body);
  if (native) flags.push("native-" + native);
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

export function summarizeSkippedFile(path, size, sha256, head) {
  // Record for an entry whose body exceeded the retention limit: the content
  // was never buffered (so there is no text sample), but it WAS hashed as it
  // streamed past, so the diff layer can still tell "byte-identical to the
  // baseline" from "changed but never inspected". The head bytes ride along
  // from the discard sink so an uninspectable body still yields format
  // evidence — a skipped 200 MB extensionless ELF is exactly the artifact the
  // native rule must see.
  const flags = ["content-skipped"];
  const native = sniffNativeArtifact(head);
  if (native) flags.push("native-" + native);
  return { path, size, sha256: sha256 || "", flags };
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

// The *root* manifest an ecosystem derives package identity/dependencies from:
// npm's `package.json` (the `package/` prefix is already stripped) and a PyPI
// sdist's `PKG-INFO`/`pyproject.toml`, which live at the archive root or under a
// single `<name>-<version>/` directory. A body too large to inspect here would
// null the manifest and leave identity/deps uninspected, so it fails the parse
// rather than degrading to a finding. Matching is anchored to the root (not the
// basename anywhere) so a benign deeply-nested/vendored manifest-named file is
// skipped, not fatal.
export function isRootManifestPath(path) {
  const normalized = String(path || "").replaceAll("\\", "/");
  if (normalized === "package.json") return true;
  if (normalized === "PKG-INFO" || normalized === "pyproject.toml") return true;
  const slash = normalized.indexOf("/");
  if (slash === -1 || normalized.indexOf("/", slash + 1) !== -1) return false;
  const rest = normalized.slice(slash + 1);
  return rest === "PKG-INFO" || rest === "pyproject.toml";
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
// content-skipped (path + declared size + sha256 streamed via DigestStream,
// no text) instead of failing the parse — the esbuild/rover pattern of
// multi-hundred-megabyte prepackaged platform binaries alongside a small
// manifest.
export async function readTarStream(body, maxFiles, maxTarBytes, maxStreamBytes) {
  const nul = String.fromCharCode(0);
  if (!body) throw tarError("tarball decompression failed");
  const cursor = createStreamCursor(body, maxStreamBytes);
  const { fill, take, discard } = cursor;

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
  let regularEntryCount = 0;

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
        // Count every regular entry, not just distinct paths: duplicate paths
        // replace their earlier entry in `files`, so without this a tar could
        // carry thousands of records for one path — each streamed and hashed —
        // while never tripping the file-count cap.
        regularEntryCount += 1;
        if (regularEntryCount > maxFiles) throw tarError("archive contains too many files");
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
        // A duplicate path replaces (does not add to) its earlier entry under
        // last-write-wins, so exclude that earlier copy's retained bytes from the
        // budget here — otherwise a duplicate that would fit after the release is
        // wrongly skipped, leaving the very bytes a consumer receives uninspected.
        const priorContribution = path && seenPaths.has(path) ? retainedByPath.get(path) || 0 : 0;
        const budgetBase = retainedBytes - priorContribution;
        // Retention tiers, tightest first:
        //  - the root npm manifest is ALWAYS inspected — parsePackageJson depends
        //    on it, and it is a single deduped path, so this adds at most one
        //    manifest body (≤ maxTarBytes) and cannot be starved by earlier files;
        //  - other manifests (nested npm, PyPI/wheel metadata, whose root path is
        //    attacker-shaped and so cannot get the guarantee) draw on a bounded
        //    second maxTarBytes of headroom, so a tar stuffed with manifest-named
        //    files still cannot amplify retained memory;
        //  - everything else must fit the shared maxTarBytes budget.
        const isNpmRootManifest = path === "package.json";
        const mustRetainBody = path ? isRetainedManifestPath(path) : false;
        const retainBody =
          size <= maxTarBytes &&
          (isNpmRootManifest ||
            budgetBase + size <= maxTarBytes ||
            (mustRetainBody && budgetBase + size <= 2 * maxTarBytes));
        // A root manifest we cannot inspect — too large for the per-file limit, or
        // crowded out of the retention budget by earlier manifest-named entries —
        // must fail the parse rather than degrade its name/version/dependency
        // metadata to a content-skipped finding, honoring the fail-closed manifest
        // guarantee for PyPI (whose attacker-shaped root path cannot get npm's
        // always-retain guarantee) as well as npm. Nested/vendored manifest-named
        // files are not root manifests and are skipped below, not fatal.
        if (path && isRootManifestPath(path) && !retainBody) {
          throw tarError("invalid tar entry size");
        }
        let summarized = null;
        let contributed = 0;
        if (path && retainBody) {
          if (!(await fill(size))) throw tarError("truncated tar entry");
          summarized = await summarizeFile(path, take(size));
          contributed = size;
        } else {
          // The body is dropped, but hashed on the way past: the digest costs
          // no memory and lets the diff layer prove a skipped binary is
          // byte-identical to (or diverged from) the published baseline. The
          // first 64 bytes (the longest magic sniffNativeArtifact reads — a
          // DOS header) are retained for native-artifact detection.
          const digester = path ? createSha256Digester() : null;
          const headCapture = path ? createHeadCapture(64) : null;
          const sink = digester
            ? (chunk) => {
                headCapture.update(chunk);
                return digester.update(chunk);
              }
            : undefined;
          if (!(await discard(size, sink))) {
            throw tarError("truncated tar entry");
          }
          if (path && digester) {
            summarized = summarizeSkippedFile(
              path,
              size,
              await digester.finalize(),
              headCapture.bytes(),
            );
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
              detail: `${detail}; path, size, and sha256 recorded but content not inspected`,
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
    cursor.cancel();
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
      throw tarError("archive expands beyond safety limit");
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

// Buffered compatibility wrapper over the streaming zip reader. Retention and
// streaming-work budgets are both `maxArchiveBytes`, so any archive the old
// central-directory parser rejected for expansion is still rejected.
export async function readZipArchive(buffer, maxFiles, maxArchiveBytes) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const parsed = await readZipStream(
    new Response(bytes).body,
    maxFiles,
    maxArchiveBytes,
    maxArchiveBytes,
  );
  return parsed.files;
}

// Central-directory-driven parse of a fully buffered zip. VSIX archives need
// this path: vsce packs them with yazl, whose streamed entries set general
// purpose bit 3 and carry their sizes in a data descriptor AFTER the entry
// data — a forward-only streaming walk cannot locate the entry boundary, but
// the central directory (what consumers read) carries the authoritative
// sizes, so buffering under the wire cap and walking the CD handles them
// exactly the way VS Code / yauzl do. Wheels and sdists never need this:
// Python's zipfile writes sizes in local headers, so they take the streaming
// reader instead of paying the buffer.
export async function readZipArchiveBuffered(buffer, maxFiles, maxArchiveBytes) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const eocd = findZipEndOfCentralDirectory(bytes);
  if (eocd < 0) throw tarError("zip central directory not found");

  const entryCount = readUint16Le(bytes, eocd + 10);
  const centralDirectorySize = readUint32Le(bytes, eocd + 12);
  const centralDirectoryOffset = readUint32Le(bytes, eocd + 16);
  if (
    entryCount === 0xffff ||
    centralDirectorySize === 0xffffffff ||
    centralDirectoryOffset === 0xffffffff
  ) {
    throw tarError("zip64 archives are not supported");
  }
  if (centralDirectoryOffset + centralDirectorySize > bytes.length) {
    throw tarError("truncated zip central directory");
  }

  const files = [];
  let expandedBytes = 0;
  let offset = centralDirectoryOffset;
  const pathDecoder = new TextDecoder("utf-8", { fatal: false });
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > bytes.length || readUint32Le(bytes, offset) !== 0x02014b50) {
      throw tarError("invalid zip central directory");
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
    if (fileNameEnd > bytes.length) throw tarError("truncated zip filename");

    const rawPath = pathDecoder.decode(bytes.subarray(fileNameStart, fileNameEnd));
    const path = normalizeZipPath(rawPath);
    offset = fileNameEnd + extraLength + commentLength;

    if (!path) continue;
    if (files.length >= maxFiles) throw tarError("archive contains too many files");
    if (uncompressedSize > maxArchiveBytes || expandedBytes + uncompressedSize > maxArchiveBytes) {
      throw tarError("archive expands beyond safety limit");
    }
    if (
      localHeaderOffset + 30 > bytes.length ||
      readUint32Le(bytes, localHeaderOffset) !== 0x04034b50
    ) {
      throw tarError("invalid zip local header");
    }
    const localFileNameLength = readUint16Le(bytes, localHeaderOffset + 26);
    const localExtraLength = readUint16Le(bytes, localHeaderOffset + 28);
    const dataOffset = localHeaderOffset + 30 + localFileNameLength + localExtraLength;
    if (dataOffset + compressedSize > bytes.length) throw tarError("truncated zip entry");

    let body;
    if (compressionMethod === 0) {
      body = bytes.subarray(dataOffset, dataOffset + compressedSize);
    } else if (compressionMethod === 8) {
      body = await inflateRawBounded(
        bytes.subarray(dataOffset, dataOffset + compressedSize),
        maxArchiveBytes,
      );
    } else {
      throw tarError("unsupported zip compression method");
    }
    if (body.length !== uncompressedSize) throw tarError("zip entry size mismatch");
    expandedBytes += body.length;
    files.push(await summarizeFile(path, body));
  }
  return files;
}

// Caps the raw bytes flowing out of a stream. gzip/deflate can decode an
// arbitrarily large input to almost no output (empty stored/flush blocks), so
// a decompressed-byte budget alone does not bound wire bytes or inflater CPU —
// this bounds the compressed side before a DecompressionStream ever sees it.
// The overflow error is tagged (tarError) so the sandbox maps it to 413.
export function boundedByteStream(body, maxBytes) {
  let total = 0;
  return body.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        total += chunk.byteLength;
        if (total > maxBytes) {
          controller.error(tarError("archive expands beyond safety limit"));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
}

// Streams one deflated zip entry body off the cursor through native inflate,
// handing each inflated chunk to `onChunk` — the compressed payload is
// consumed chunk-by-chunk and never accumulated, so a hostile entry whose
// compressed stream dwarfs its declared uncompressed size (empty flush-block
// padding) costs stream budget, not memory. Inflated output is bounded by the
// declared uncompressed size; any disagreement fails closed.
export async function pumpDeflatedZipEntry(cursor, compressedSize, uncompressedSize, onChunk) {
  const ds = new DecompressionStream("deflate-raw");
  const writer = ds.writable.getWriter();
  let inflated = 0;
  const drain = (async () => {
    const reader = ds.readable.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      inflated += value.byteLength;
      if (inflated > uncompressedSize) {
        reader.cancel().catch(() => undefined);
        throw tarError("zip entry size mismatch");
      }
      await onChunk(value);
    }
  })();
  let discardError = null;
  const ok = await cursor
    .discard(compressedSize, (chunk) => writer.write(chunk))
    .catch((err) => {
      discardError = err;
      return false;
    });
  // Close (or abort) the inflater before awaiting the drain so a hostile
  // truncated deflate stream cannot leave both sides waiting on each other.
  let closeFailed = false;
  if (ok) {
    await writer.close().catch(() => {
      closeFailed = true;
    });
  } else {
    writer.abort(tarError("truncated zip entry")).catch(() => undefined);
  }
  // The drain's verdict comes first: an inflated-size overflow cancels the
  // pipe, which also makes the write/close side reject — those errors are
  // downstream noise, the tagged overflow is the cause.
  try {
    await drain;
  } catch (err) {
    if (err && err.tarSafety) throw err;
    throw tarError("zip entry decompression failed");
  }
  if (!ok) {
    if (discardError && discardError.tarSafety) throw discardError;
    throw tarError("truncated zip entry");
  }
  if (closeFailed) throw tarError("zip entry decompression failed");
  if (inflated !== uncompressedSize) throw tarError("zip entry size mismatch");
}

// Hash (and validate the declared size of) a zip entry body that is being
// discarded rather than retained. Deflated bodies stream through native
// inflate + digest, so a skipped entry costs CPU but no memory. The first 64
// decompressed bytes (the longest magic sniffNativeArtifact reads — a DOS
// header) are retained for native-artifact detection.
export async function digestSkippedZipEntry(cursor, compressedSize, uncompressedSize, method) {
  const digester = createSha256Digester();
  const headCapture = createHeadCapture(64);
  const sink = (chunk) => {
    headCapture.update(chunk);
    return digester.update(chunk);
  };
  if (method === 0) {
    if (!(await cursor.discard(compressedSize, sink))) {
      throw tarError("truncated zip entry");
    }
    return { sha256: await digester.finalize(), head: headCapture.bytes() };
  }
  await pumpDeflatedZipEntry(cursor, compressedSize, uncompressedSize, sink);
  return { sha256: await digester.finalize(), head: headCapture.bytes() };
}

// Materialize a retained deflated entry via the streaming pump: only the
// inflated output (≤ the declared uncompressed size, already checked against
// the retention budget) is buffered, never the compressed payload.
export async function inflateRetainedZipEntry(cursor, compressedSize, uncompressedSize) {
  const chunks = [];
  await pumpDeflatedZipEntry(cursor, compressedSize, uncompressedSize, (chunk) => {
    chunks.push(chunk);
  });
  const out = new Uint8Array(uncompressedSize);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

// Streaming zip reader with the same retention/skip semantics as
// readTarStream: `maxTarBytes` bounds retained bytes (per entry and
// cumulative); oversized bodies are hashed and recorded as content-skipped
// instead of buffered; `maxStreamBytes` bounds both raw bytes consumed and
// cumulative declared expansion (fail-closed "archive expands beyond safety
// limit").
//
// Unlike the old buffered parser this walks LOCAL file headers (the central
// directory only arrives at the end of the stream), but consumers — pip,
// Python's zipfile — trust the CENTRAL directory. Parsing only local headers
// would let a crafted wheel show the scanner different bytes than consumers
// extract, so every central-directory record is cross-checked against the
// local entry at its recorded offset (path, method, sizes) and any
// disagreement in either direction fails closed. Data-descriptor (bit 3),
// encrypted (bit 0), and zip64 entries are rejected: Python's zipfile never
// writes them for wheels/sdists, and each would make the local view
// unverifiable.
export async function readZipStream(body, maxFiles, maxTarBytes, maxStreamBytes) {
  if (!body) throw tarError("archive download failed");
  const cursor = createStreamCursor(body, maxStreamBytes);
  const expansionLimit = Number.isFinite(maxStreamBytes) ? maxStreamBytes : Infinity;
  const pathDecoder = new TextDecoder("utf-8", { fatal: false });

  const files = [];
  const suspicious = [];
  const suspiciousLimit = Math.max(1, Number.isFinite(maxFiles) ? maxFiles : 250);
  let suspiciousLimitReached = false;
  const seenPaths = new Map();
  const localEntries = new Map();
  // Bytes each retained path contributes to `retainedBytes`, so a later
  // duplicate that replaces an entry releases the earlier body's budget instead
  // of double-counting it (which would prematurely exhaust the retention limit).
  const retainedByPath = new Map();
  // Duplicate-name resolution seen by the LOCAL walk vs. declared by the
  // CENTRAL directory. Python's zipfile resolves duplicate names by
  // central-directory order (NameToInfo is built CD-record-by-record, last
  // wins), while this parser resolved them in local-header order — a CD that
  // lists duplicates in a different order would make consumers read a body
  // the scanner replaced. Cross-checked at EOCD; any disagreement fails closed.
  const lastLocalOffsetByPath = new Map();
  const cdWinnerOffsetByPath = new Map();
  let localFileRecordCount = 0;
  let retainedBytes = 0;
  let expandedBytes = 0;
  let sawCentralDirectory = false;
  let centralEntryCount = 0;

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
    while (true) {
      const headerOffset = cursor.consumed();
      if (!(await cursor.fill(4))) throw tarError("zip central directory not found");
      const signature = readUint32Le(cursor.take(4), 0);

      if (signature === 0x04034b50) {
        // Local file header. Fixed fields after the signature: flags@2,
        // method@4, crc@10, compressed size@14, uncompressed size@18,
        // name length@22, extra length@24 (26 bytes total).
        if (sawCentralDirectory) throw tarError("invalid zip central directory");
        if (!(await cursor.fill(26))) throw tarError("truncated zip entry");
        const header = cursor.take(26);
        const flags = readUint16Le(header, 2);
        const method = readUint16Le(header, 4);
        const compressedSize = readUint32Le(header, 14);
        const uncompressedSize = readUint32Le(header, 18);
        const fileNameLength = readUint16Le(header, 22);
        const extraLength = readUint16Le(header, 24);
        if (flags & 0x0001) throw tarError("encrypted zip entries are not supported");
        if (flags & 0x0008) throw tarError("zip data-descriptor entries are not supported");
        if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
          throw tarError("zip64 archives are not supported");
        }
        if (method !== 0 && method !== 8) throw tarError("unsupported zip compression method");
        if (method === 0 && compressedSize !== uncompressedSize) {
          throw tarError("zip entry size mismatch");
        }
        if (!(await cursor.fill(fileNameLength))) throw tarError("truncated zip filename");
        const rawPath = pathDecoder.decode(cursor.take(fileNameLength));
        if (!(await cursor.discard(extraLength))) throw tarError("truncated zip entry");
        localEntries.set(headerOffset, { rawPath, method, compressedSize, uncompressedSize });

        // Count every non-directory record, not just distinct paths: duplicate
        // records replace their earlier entry in `files`, so without this a
        // zip could carry thousands of records for one path — each parsed,
        // inflated, and hashed — while never tripping the file-count cap.
        if (!rawPath.endsWith("/")) {
          localFileRecordCount += 1;
          if (localFileRecordCount > maxFiles) throw tarError("archive contains too many files");
        }

        expandedBytes += uncompressedSize;
        if (expandedBytes > expansionLimit) throw tarError("archive expands beyond safety limit");

        const path = normalizeZipPath(rawPath);
        if (!path) {
          // Directory markers and unsafe paths are dropped like the buffered
          // parser dropped them, but their bytes still have to leave the stream.
          if (!(await cursor.discard(compressedSize))) throw tarError("truncated zip entry");
          continue;
        }
        lastLocalOffsetByPath.set(path, headerOffset);

        // A duplicate path replaces (does not add to) its earlier entry under
        // last-write-wins, so exclude that earlier copy's retained bytes from
        // the budget here — otherwise a duplicate that would fit after the
        // release is wrongly skipped, leaving the very bytes a consumer
        // receives uninspected.
        const priorContribution = seenPaths.has(path) ? retainedByPath.get(path) || 0 : 0;
        const budgetBase = retainedBytes - priorContribution;
        // Manifests (wheel METADATA, sdist PKG-INFO/pyproject.toml) are
        // identity evidence, but unlike tar's root package.json a wheel has no
        // fixed manifest path the parser could guarantee — the dist-info
        // directory is attacker-shaped. So manifests draw on a bounded second
        // maxTarBytes of headroom (total retained ≤ 2×maxTarBytes) rather than
        // an unlimited bypass, and one too large to inspect is skipped, not
        // fatal.
        const mustRetainBody = isRetainedManifestPath(path);
        const retainBody =
          uncompressedSize <= maxTarBytes &&
          (budgetBase + uncompressedSize <= maxTarBytes ||
            (mustRetainBody && budgetBase + uncompressedSize <= 2 * maxTarBytes));
        let summarized;
        let contributed = 0;
        if (retainBody) {
          // Stored entries are bounded (compressed === uncompressed ≤ the
          // retention budget, enforced above). Deflated entries stream through
          // inflate so a compressed payload padded far beyond its declared
          // uncompressed size is never buffered.
          let bodyBytes;
          if (method === 0) {
            if (!(await cursor.fill(compressedSize))) throw tarError("truncated zip entry");
            bodyBytes = cursor.take(compressedSize);
          } else {
            bodyBytes = await inflateRetainedZipEntry(cursor, compressedSize, uncompressedSize);
          }
          summarized = await summarizeFile(path, bodyBytes);
          contributed = uncompressedSize;
        } else {
          const { sha256, head } = await digestSkippedZipEntry(
            cursor,
            compressedSize,
            uncompressedSize,
            method,
          );
          summarized = summarizeSkippedFile(path, uncompressedSize, sha256, head);
          // Distinguish a body too large to inspect on its own from a small
          // body skipped only because earlier files spent the shared budget —
          // the message is user-facing evidence and must be accurate.
          const detail =
            uncompressedSize > maxTarBytes
              ? `file body (${uncompressedSize} bytes) exceeds the ${maxTarBytes}-byte per-file inspection limit`
              : `file body (${uncompressedSize} bytes) did not fit the archive's ${maxTarBytes}-byte cumulative retention budget already spent on earlier files`;
          addSuspicious({
            kind: "content-skipped",
            path,
            detail: `${detail}; path, size, and sha256 recorded but content not inspected`,
          });
        }
        if (seenPaths.has(path)) {
          // Python's zipfile resolves duplicate names last-write-wins (both for
          // extraction order and NameToInfo lookups), so inspect the bytes
          // consumers receive while surfacing the duplicate.
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
      } else if (signature === 0x02014b50) {
        // Central directory record. Fixed fields after the signature:
        // method@6, compressed size@16, uncompressed size@20, name length@24,
        // extra length@26, comment length@28, local header offset@38 (42 bytes).
        sawCentralDirectory = true;
        if (!(await cursor.fill(42))) throw tarError("invalid zip central directory");
        const header = cursor.take(42);
        const method = readUint16Le(header, 6);
        const compressedSize = readUint32Le(header, 16);
        const uncompressedSize = readUint32Le(header, 20);
        const fileNameLength = readUint16Le(header, 24);
        const extraLength = readUint16Le(header, 26);
        const commentLength = readUint16Le(header, 28);
        const localHeaderOffset = readUint32Le(header, 38);
        if (!(await cursor.fill(fileNameLength))) throw tarError("truncated zip filename");
        const rawPath = pathDecoder.decode(cursor.take(fileNameLength));
        if (!(await cursor.discard(extraLength + commentLength))) {
          throw tarError("invalid zip central directory");
        }
        const local = localEntries.get(localHeaderOffset);
        if (
          !local ||
          local.rawPath !== rawPath ||
          local.method !== method ||
          local.compressedSize !== compressedSize ||
          local.uncompressedSize !== uncompressedSize
        ) {
          throw tarError("zip central directory does not match local entries");
        }
        localEntries.delete(localHeaderOffset);
        centralEntryCount += 1;
        // Track the CD's duplicate-name winner (last CD record for a name
        // wins in zipfile's NameToInfo) for the EOCD order cross-check.
        const cdPath = normalizeZipPath(rawPath);
        if (cdPath) cdWinnerOffsetByPath.set(cdPath, localHeaderOffset);
      } else if (signature === 0x06054b50) {
        // End of central directory: total entry count@6, comment length@16
        // (18 bytes after the signature).
        if (!(await cursor.fill(18))) throw tarError("truncated zip central directory");
        const eocd = cursor.take(18);
        const totalEntries = readUint16Le(eocd, 6);
        const commentLength = readUint16Le(eocd, 16);
        if (totalEntries === 0xffff) throw tarError("zip64 archives are not supported");
        if (totalEntries !== centralEntryCount) throw tarError("invalid zip central directory");
        if (localEntries.size > 0) {
          // Local entries the central directory never listed: bytes the scanner
          // saw but consumers will not extract — or an overlap trick. Fail closed.
          throw tarError("zip central directory does not match local entries");
        }
        for (const [dupPath, localOffset] of lastLocalOffsetByPath) {
          // The scanner kept the LAST LOCAL body for each name; consumers keep
          // the LAST CENTRAL record's. A CD that orders duplicates differently
          // would hand consumers a body the scanner replaced — fail closed.
          if (cdWinnerOffsetByPath.get(dupPath) !== localOffset) {
            throw tarError("zip central directory does not match local entries");
          }
        }
        if (commentLength > 0 && !(await cursor.discard(commentLength))) {
          throw tarError("truncated zip central directory");
        }
        if (await cursor.fill(1))
          throw tarError("trailing data after zip end of central directory");
        break;
      } else if (signature === 0x06064b50 || signature === 0x07064b50) {
        throw tarError("zip64 archives are not supported");
      } else {
        throw tarError(
          sawCentralDirectory || localEntries.size > 0
            ? "invalid zip central directory"
            : "zip central directory not found",
        );
      }
    }
    return { files, suspicious };
  } finally {
    // Release the stream on every exit — success, break, or any thrown parser
    // error — so a malformed archive never leaves the reader lock held and the
    // upstream fetch pipe open against the sandbox budget.
    cursor.cancel();
  }
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
