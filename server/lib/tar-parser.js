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
/** @typedef {{ kind: "non-regular"|"duplicate"|"unicode-confusable"|"content-skipped"|"retention-tier"|"parser-differential", path: string, detail: string, archive?: "zip" }} TarSuspiciousEntry */

export function readString(bytes, start, len) {
  // POSIX tar fields are NUL-terminated bytes with no declared charset, but
  // modern tars (including npm pack) put UTF-8 in there. Decoding as UTF-8
  // is needed so Unicode confusable checks see the actual codepoints rather
  // than per-byte latin-1 fragments.
  //
  // The NUL cut is node-tar's `decString` verbatim: `.replace(/\0.*/, "")`
  // without the `s` flag, so text after a newline that follows the NUL
  // survives. A reader that stops at the first NUL sees an empty name where
  // node-tar sees `\nx` and rejects a header npm accepts — or accepts a header
  // whose linkname npm sees as non-empty and rejects — putting the two on
  // different block boundaries for the rest of the archive. `ignoreBOM` because
  // node-tar's `Buffer.toString("utf8")` keeps a leading U+FEFF while
  // TextDecoder drops it by default — a BOM-only name is a truthy path there.
  return new TextDecoder("utf-8", { fatal: false, ignoreBOM: true })
    .decode(bytes.subarray(start, start + len))
    .replace(/\0.*/, "");
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

export function normalizePeerDependenciesMeta(value) {
  const out = {};
  if (!isPlainObject(value)) return out;
  for (const [key, nested] of Object.entries(value)) {
    if (isPlainObject(nested) && typeof nested.optional === "boolean") {
      out[key] = { optional: nested.optional };
    }
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

/**
 * Recorded paths must be the paths the *consumer* installs, so the caller names
 * the strip depth its consumer extracts with:
 *
 * - `"strip1"` — npm/pacote's `tar.x({ strip: 1 })`: drop the archive's first
 *   path component whatever it is called.
 * - `"keep"` — keep every component. A PyPI sdist's `<name>-<version>/` root is
 *   real to pip; `pypi/acquire.ts` strips the common root afterwards and uses
 *   entries outside it as evidence.
 * - `"package-prefix"` (default) — strip a literal leading `package/` only. This
 *   is the ecosystem-unknown parse: a workflow-gate bundle's `.tgz` is claimed
 *   by both npm and PyPI on filename alone and the ecosystem is decided from the
 *   parsed contents, so this parse has to surface an npm root manifest while
 *   leaving a PyPI root intact.
 *
 * Spelled as literals rather than shared constants because these functions are
 * stringified into the sandbox worker and may not close over module scope.
 */
export function normalizeTarPath(rawPath, rootStrip = "package-prefix") {
  const nul = String.fromCharCode(0);
  if (!rawPath || rawPath.includes(nul) || rawPath.includes("\\")) return null;
  const rawParts = rawPath.split("/");
  // node-tar applies `strip` in `[CHECKPATH]`, before it normalizes the path and
  // before its `..` and absolute-root checks, so the strip decides those: `../x`
  // becomes `x` and npm writes it, while `package/../x` becomes `../x` and npm
  // rejects it. Stripping here first and letting the checks below see what is
  // left reproduces both. It also has to be unconditional: an entry with no
  // directory component strips to nothing and npm installs no file for it, so
  // giving it back its own name would let a top-level decoy collide with — and
  // last-write-wins over — the entry whose bytes npm actually installs. The
  // caller discloses the null instead, which keeps the evidence without
  // attributing it to a path npm writes.
  const stripsFirstComponent = rootStrip === "strip1";
  // In the ecosystem-unknown parse, a `package` that is not first —
  // `./package/x`, `/package/x` — is a real directory to npm, so it is one here.
  const leadsWithPackage = rootStrip === "package-prefix" && rawParts[0] === "package";
  let path = (stripsFirstComponent ? rawParts.slice(1).join("/") : rawPath).replace(/^\/+/, "");
  if (!path || path.startsWith("../") || path.includes("/../") || /^[A-Za-z]:/.test(path))
    return null;
  const trailingSlash = path.endsWith("/");
  // `.` segments are no-ops that every extractor collapses, so they are dropped
  // rather than rejected: rejecting them meant `package/./binding.gyp` produced
  // no record at all while npm wrote `binding.gyp`. `..` stays fatal.
  const parts = path.split("/").filter((part) => part && part !== ".");
  if (!parts.length || parts.some((part) => part === "..")) return null;
  // Stripped after normalization so a doubled separator inside it is collapsed
  // first (`package//x` is `x`, the same file npm writes).
  if (leadsWithPackage && parts[0] === "package" && (parts.length > 1 || trailingSlash)) {
    parts.shift();
  }
  if (!parts.length) return null;
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

// A file entry whose name normalizeZipPath rejects used to vanish, deleting
// the only evidence it exists. pip resolves `a/../x` to a file inside
// site-packages, and Windows extractors split on backslashes, so the entry is
// disclosed (mirroring the tar reader) with its content left uninspected.
// `archive: "zip"` lets the review explain it in zip terms instead of the tar
// reader's node-tar framing. Exported so the sandbox render includes it.
export function unrepresentableZipEntry(rawPath) {
  if (!rawPath || rawPath.endsWith("/")) return null;
  return {
    kind: "parser-differential",
    archive: "zip",
    path: clipTextSample(rawPath, 256) || "<unnamed>",
    detail:
      rawPath.length > 512
        ? "entry path exceeds the 512-character limit this reader records; the entry was not inspected"
        : "entry path is not representable as a safe relative path (`..` segment, `./` before a `.dist-info`/`.data` directory, drive letter, backslash, or NUL); installers that normalize paths may still extract it, so its content was not inspected here",
  };
}

// Python's zipfile (pip), yauzl and Info-ZIP decode an entry name as cp437
// unless general-purpose bit 11 marks it UTF-8. Decoding every name as lossy
// UTF-8 collapses distinct cp437 names (`hook\x80.pth`, `hook\x81.pth`) onto
// one replacement-character path, so only one of the bodies pip installs
// would be read. The table is inline because this function is stringified
// into the sandbox worker.
export function decodeZipName(bytes, flags) {
  if (flags & 0x0800) return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const high =
    "\u00c7\u00fc\u00e9\u00e2\u00e4\u00e0\u00e5\u00e7\u00ea\u00eb\u00e8\u00ef\u00ee\u00ec\u00c4\u00c5\u00c9\u00e6\u00c6\u00f4\u00f6\u00f2\u00fb\u00f9\u00ff\u00d6\u00dc\u00a2\u00a3\u00a5\u20a7\u0192\u00e1\u00ed\u00f3\u00fa\u00f1\u00d1\u00aa\u00ba\u00bf\u2310\u00ac\u00bd\u00bc\u00a1\u00ab\u00bb\u2591\u2592\u2593\u2502\u2524\u2561\u2562\u2556\u2555\u2563\u2551\u2557\u255d\u255c\u255b\u2510\u2514\u2534\u252c\u251c\u2500\u253c\u255e\u255f\u255a\u2554\u2569\u2566\u2560\u2550\u256c\u2567\u2568\u2564\u2565\u2559\u2558\u2552\u2553\u256b\u256a\u2518\u250c\u2588\u2584\u258c\u2590\u2580\u03b1\u00df\u0393\u03c0\u03a3\u03c3\u00b5\u03c4\u03a6\u0398\u03a9\u03b4\u221e\u03c6\u03b5\u2229\u2261\u00b1\u2265\u2264\u2320\u2321\u00f7\u2248\u00b0\u2219\u00b7\u221a\u207f\u00b2\u25a0\u00a0";
  let name = "";
  for (const byte of bytes) name += byte < 0x80 ? String.fromCharCode(byte) : high[byte - 0x80];
  return name;
}

export function normalizeZipPath(rawPath) {
  const nul = String.fromCharCode(0);
  if (!rawPath || rawPath.includes(nul) || rawPath.includes("\\")) return null;
  let path = rawPath.replace(/^\/+/, "");
  if (!path || path.endsWith("/") || path.startsWith("../") || path.includes("/../")) return null;
  if (/^[A-Za-z]:/.test(path)) return null;
  // `.` segments are no-ops that pip and every zip extractor collapse
  // (`./evil.pth` lands in site-packages as `evil.pth`), so they are dropped
  // as the tar reader drops them; rejecting them left that file unread.
  const parts = path.split("/").filter((part) => part && part !== ".");
  if (!parts.length || parts.some((part) => part === "..")) return null;
  // Except where pip reads the raw first segment: it finds `*.dist-info` and
  // routes `*.data` schemes by the name as written, so `./x.dist-info/METADATA`
  // is not the metadata pip reads and `./x.data/purelib/y` installs under
  // `x.data/`. Collapsing those would merge a decoy onto the real path.
  if (path.split("/")[0] === "." && /\.(?:dist-info|data)$/i.test(parts[0])) return null;
  path = parts.join("/");
  // Collapsing can expose a drive letter the early check missed (`./C:x`).
  if (/^[A-Za-z]:/.test(path)) return null;
  if (path.length > 512) return null;
  return path;
}

export function parsePax(body) {
  // Mirrors node-tar's `parseKV`, because the reader that resolves these records
  // for `npm install` is the one whose answer matters. Three properties have to
  // match or an archive can hand npm one path and the reviewer another: it is
  // line-based rather than a walk over the declared lengths, a malformed line
  // costs only that line instead of the rest of the body, and the body is read
  // as raw UTF-8 — a NUL byte or a run of control characters does not blank it.
  // `ignoreBOM`: node-tar keeps a leading U+FEFF, which makes `parseInt` of the
  // first record NaN and drops that record; stripping it would apply a `size`
  // npm never reads.
  const text = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(body);
  const encoder = new TextEncoder();
  const out = {};
  for (const line of text.replace(/\n$/, "").split("\n")) {
    // The declared length counts the record's own bytes plus the newline the
    // split consumed.
    if (parseInt(line, 10) !== encoder.encode(line).length + 1) continue;
    const record = line.slice(String(parseInt(line, 10)).length + 1);
    const equals = record.indexOf("=");
    // A record with no `=` is not dropped: node-tar keeps it as the key with an
    // empty value, so `size` alone is a zero-length body to npm and `path` alone
    // makes it reject every following header. Only an empty key is skipped.
    const rawKey = equals === -1 ? record : record.slice(0, equals);
    if (!rawKey) continue;
    const key = rawKey.replace(/^SCHILY\.(dev|ino|nlink)/, "$1");
    const value = equals === -1 ? "" : record.slice(equals + 1);
    // node-tar coerces an all-digit value to a number. Values stay strings here,
    // but through the same coercion, so `size=0123` is 123 and a numeric `path`
    // is recognizable at the point where node-tar's decode would throw on it.
    out[key] = /^[0-9]+$/.test(value) ? String(Number(value)) : value;
  }
  return out;
}

// Where a pax body reads differently to node-tar's line split (`parsePax`)
// than to CPython's tarfile, which walks the declared lengths over the raw
// bytes, or carries keys only one of them honors. Returns noun phrases for the
// caller's disclosure, empty for a body every reader parses the same way. Only
// the keys that decide where bytes land are compared: macOS bsdtar writes raw
// binary xattr values that node-tar's UTF-8 line split drops and a length walk
// keeps, which changes nothing either reader installs. A body is up to 1 MiB
// of attacker-chosen records, so every pass is linear in its size.
export function paxBodyAnomalies(body) {
  const decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });
  const strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const encoder = new TextEncoder();
  const keys = new Set();
  const repeated = new Set();
  const byLine = {};
  for (const line of decoder.decode(body).replace(/\n$/, "").split("\n")) {
    if (parseInt(line, 10) !== encoder.encode(line).length + 1) continue;
    const record = line.slice(String(parseInt(line, 10)).length + 1);
    const equals = record.indexOf("=");
    const key = equals === -1 ? record : record.slice(0, equals);
    if (!key) continue;
    if (keys.has(key)) repeated.add(key);
    keys.add(key);
    if (key === "path" || key === "linkpath" || key === "size") {
      byLine[key] = equals === -1 ? "" : record.slice(equals + 1);
    }
  }
  // CPython's walk: `<len> <key>=<value>\n` records tiling the body up to the
  // end or a NUL byte. Older releases stop at the first record that does not
  // fit; newer ones refuse the header, which ends the archive for pip.
  const byLength = {};
  const notUtf8 = [];
  let tiles = true;
  for (let pos = 0; pos < body.length && body[pos] !== 0;) {
    let end = pos;
    while (end < body.length && end - pos < 20 && body[end] >= 0x30 && body[end] <= 0x39) end += 1;
    const length = Number(String.fromCharCode(...body.subarray(pos, end)));
    const record = body.subarray(end + 1, pos + length - 1);
    const equals = record.indexOf(0x3d);
    if (
      end === pos ||
      body[end] !== 0x20 ||
      length <= end - pos + 1 ||
      pos + length > body.length ||
      body[pos + length - 1] !== 0x0a ||
      equals < 1
    ) {
      tiles = false;
      break;
    }
    const key = decoder.decode(record.subarray(0, equals));
    keys.add(key);
    if (key === "path" || key === "linkpath" || key === "size") {
      const value = record.subarray(equals + 1);
      byLength[key] = decoder.decode(value);
      // CPython keeps undecodable bytes (surrogateescape) where node-tar
      // writes U+FFFD, even when the two happen to be the same length.
      if (key !== "size" && !notUtf8.includes(key)) {
        try {
          strict.decode(value);
        } catch {
          notUtf8.push(key);
        }
      }
    }
    pos += length;
  }
  const quoted = (list) =>
    clipTextSample(
      list
        .slice(0, 8)
        .map((key) => `\`${key}\``)
        .join(", ") + (list.length > 8 ? `, and ${list.length - 8} more` : ""),
      160,
    );
  const anomalies = [];
  if (!tiles) {
    anomalies.push(
      "records a length-walking reader cannot parse (declared lengths that do not tile the body, or a record without `key=`), which node-tar reads line by line while CPython tarfile stops at them or, in newer releases, refuses the header and ends the archive",
    );
  } else {
    const differing = ["path", "linkpath", "size"].filter((key) => byLine[key] !== byLength[key]);
    if (differing.length) {
      anomalies.push(
        `${quoted(differing)} records that node-tar's line split and CPython tarfile's length walk read differently`,
      );
    }
    if (notUtf8.length) {
      anomalies.push(
        `${quoted(notUtf8)} values that are not valid UTF-8, which node-tar writes with replacement characters and CPython tarfile writes as the raw bytes`,
      );
    }
  }
  if (repeated.size) {
    const list = [...repeated];
    anomalies.push(
      `the ${list.length === 1 ? "key" : "keys"} ${quoted(list)} more than once, where readers that keep the first value (tar-rs) disagree with node-tar`,
    );
  }
  const sparse = [...keys].filter((key) => key.startsWith("GNU.sparse."));
  if (sparse.length) {
    anomalies.push(
      `GNU sparse keys (${quoted(sparse)}), which make CPython tarfile rebuild the member from a sparse map, changing the bytes, size or name it writes, while node-tar ignores them and installs the raw body`,
    );
  }
  return anomalies;
}

// node-tar validates every header's checksum with the checksum field itself
// counted as eight spaces, and both readers have to agree on the result: a
// header node-tar rejects is skipped without consuming its body, so it re-reads
// the declared body as further headers. Caller fails the parse on a mismatch
// rather than trying to follow that, which would mean walking a different
// archive than npm from that block on.
export function tarHeaderChecksum(header) {
  let computed = 8 * 0x20;
  for (let i = 0; i < 148; i++) computed += header[i];
  for (let i = 156; i < 512; i++) computed += header[i];
  // Read the declared value exactly as node-tar does: twelve bytes from offset
  // 148 (it deliberately overruns the eight-byte field), cut at the first NUL,
  // trimmed, parsed as octal. Being any stricter would fail archives npm reads
  // fine; being any looser would accept headers npm skips.
  const declared =
    header[148] & 0x80
      ? // A base-256 encoded checksum is not something any writer emits, and
        // matching node-tar's large-number decode for it would be one more
        // place to diverge silently.
        null
      : parseInt(
          new TextDecoder("utf-8", { fatal: false, ignoreBOM: true })
            .decode(header.subarray(148, 160))
            .replace(/\0.*/, "")
            .trim(),
          8,
        );
  return { computed, declared: Number.isNaN(declared) ? null : declared };
}

// node-tar decodes a numeric header field whose first byte has the high bit set
// as base-256, and that decode throws out of the whole header decode — the
// block is skipped without consuming its body, exactly like a checksum failure
// — when the prefix byte is neither 0x80 (positive) nor 0xff (two's complement)
// or the value is not a safe integer. An octal field never throws (an
// unparsable one is simply undefined), so only the base-256 shape is checked.
// The arithmetic mirrors node-tar's `large-numbers.js` so both readers reject
// the same values.
export function isRejectedTarNumber(header, offset, length) {
  const prefix = header[offset];
  if (!(prefix & 0x80)) return false;
  if (prefix !== 0x80 && prefix !== 0xff) return true;
  let value = 0;
  if (prefix === 0x80) {
    for (let i = offset + 1; i < offset + length; i++) {
      if (header[i] !== 0) value += header[i] * Math.pow(256, offset + length - i - 1);
    }
  } else {
    let flipped = false;
    for (let i = offset + length - 1; i >= offset; i--) {
      const byte = header[i];
      let f;
      if (flipped) f = (0xff ^ byte) & 0xff;
      else if (byte === 0) f = 0;
      else {
        flipped = true;
        f = ((0xff ^ byte) + 1) & 0xff;
      }
      if (f !== 0) value -= f * Math.pow(256, offset + length - i - 1);
    }
  }
  return !Number.isSafeInteger(value);
}

// Map typeflag bytes to a short label used in tar.suspicious-entry findings.
// The standard ustar/POSIX values: 0 regular, 1 hardlink, 2 symlink,
// 3 char device, 4 block device, 5 directory, 6 fifo. Typeflag 7 (contiguous
// file) is absent because node-tar extracts it as an ordinary file, so this
// reader reads it as one too rather than reporting it.
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
  return createDigester("SHA-256");
}

// Incremental digest for any WebCrypto hash name. Split out of
// createSha256Digester so the archive-level integrity digest (SHA-1, matching
// npm's `shasum`) shares one streaming implementation with the per-file
// content hashes. Must stay self-contained: serialized into the sandbox worker
// via renderTarParserSource.
export function createDigester(algorithm) {
  if (typeof crypto !== "undefined" && typeof crypto.DigestStream === "function") {
    const stream = new crypto.DigestStream(algorithm);
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
      const digest = await crypto.subtle.digest(algorithm, out);
      return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    },
  };
}

// Hash an archive's raw wire bytes while the parser reads the same stream, so
// a scan can prove the artifact it reviewed is the artifact the registry
// recorded. A truncated or substituted download otherwise reads as "the
// publisher removed these files" — indistinguishable, from the report alone,
// from a real deletion.
//
// The digest is deliberately NOT a tap that finalizes on flush. The tar reader
// stops at the end-of-archive marker and cancels its stream, leaving the
// trailing blocks and the gzip footer unread, so an inline tap would only ever
// see a prefix and would report a mismatch on every healthy scan. Instead the
// wrapper owns the source reader until the caller chooses the outcome:
// `digest()` drains whatever a successful consumer left behind (it is called
// once parsing is done, so there is no one left to steal bytes from), while
// `abort()` cancels immediately after a parser/decompression failure. A raw
// stream cancel cannot choose between those outcomes because both successful
// tar completion and malformed input cancel the parser-side reader.
//
// It reports a digest ONLY when it observed the source's own EOF — an errored
// or over-cap stream returns null so the caller degrades to "unverified"
// instead of accusing a publisher of tampering.
//
// `maxBytes` bounds the hashed wire bytes: past it the pass-through continues
// (parsing is bounded separately) but the digest is abandoned, so verification
// never becomes the reason a large-but-honest artifact costs extra CPU. Pass
// the wire budget the caller already permits, not a tighter one: a cap below
// what the parser will happily read turns verification off for exactly the
// large artifacts whose downloads are most likely to be truncated.
// Must stay self-contained: serialized into the sandbox worker via
// renderTarParserSource.
export function digestArchiveStream(body, maxBytes, algorithm) {
  const reader = body.getReader();
  const algorithms = Array.isArray(algorithm) ? algorithm : [algorithm || "SHA-1"];
  const digesters = algorithms.map((name) => ({ name, digester: createDigester(name) }));
  const limit = Number.isFinite(maxBytes) ? maxBytes : Infinity;
  let total = 0;
  let capped = false;
  let sawEof = false;
  let broken = false;
  let aborted = false;
  let draining = null;
  let aborting = null;
  let passThrough = null;
  // Pass-through pulls and the post-consumer drain both read the same source,
  // and workerd's ReadableStream rejects a second read while one is pending
  // ("only supports a single pending read request at a time"), so every read
  // queues behind the previous one. Chaining also keeps chunks in stream order,
  // which the digest depends on.
  let readChain = Promise.resolve();

  function readOnce() {
    const result = readChain.then(() => reader.read());
    readChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function consume(value) {
    total += value.byteLength;
    if (capped) return;
    if (total > limit) {
      capped = true;
      return;
    }
    await Promise.all(digesters.map(({ digester }) => digester.update(value)));
  }

  async function drain() {
    try {
      for (;;) {
        if (aborted) return;
        const { value, done } = await readOnce();
        if (aborted) return;
        if (done) {
          sawEof = true;
          return;
        }
        await consume(value);
        // Past the cap there is no digest left to complete, so stop paying to
        // read a tail nobody is parsing either.
        if (capped) {
          await reader.cancel().catch(() => undefined);
          return;
        }
      }
    } catch {
      broken = true;
    }
  }

  const stream = new ReadableStream({
    start(controller) {
      passThrough = controller;
    },
    async pull(controller) {
      let chunk;
      try {
        chunk = await readOnce();
        // Hashing sits inside the same guard as the read: a digester failure
        // escaping here would leave `broken` false and `sawEof` false, so
        // digest() would drain the rest of the source and return a
        // well-formed hash over the archive minus this chunk — a mismatch
        // accusing a publisher of bytes they did stage.
        if (!aborted && !chunk.done) await consume(chunk.value);
      } catch (err) {
        if (aborted) return;
        broken = true;
        controller.error(err);
        return;
      }
      if (aborted) return;
      if (chunk.done) {
        sawEof = true;
        controller.close();
        return;
      }
      controller.enqueue(chunk.value);
    },
    cancel() {
      // A parser cancel has two meanings that only its caller can distinguish:
      // a successful tar reader stopped at the end marker, or a malformed
      // archive failed closed. Leave the source owned but idle until the caller
      // chooses digest() (drain the valid tail) or abort() (cancel immediately).
    },
  });

  function startDrain() {
    if (!draining) draining = drain();
    return draining;
  }

  return {
    body: stream,
    // Call once the consumer has finished with `body`: any bytes it did not
    // read are pulled here so the digest covers the whole archive.
    async digest() {
      if (aborted) return null;
      if (!sawEof && !broken && !capped) await startDrain();
      if (aborted || broken || capped || !sawEof) return null;
      const values = await Promise.all(
        digesters.map(async ({ name, digester }) => [name, await digester.finalize()]),
      );
      return Array.isArray(algorithm) ? Object.fromEntries(values) : values[0][1];
    },
    // A failed parse has no review to bind, so cancel the source instead of
    // draining hostile bytes for a digest the caller will discard.
    async abort() {
      aborted = true;
      // Fail the pass-through too. Every `aborted` guard returns without
      // enqueuing, closing, or erroring, so a consumer with a read in flight
      // would otherwise hang forever instead of seeing the abort. Erroring a
      // stream the consumer already cancelled or closed is a no-op.
      if (passThrough) {
        try {
          passThrough.error(new Error("archive stream aborted"));
        } catch {
          // Already closed or errored by the consumer.
        }
      }
      if (!aborting) {
        aborting = reader.cancel().then(
          () => undefined,
          () => undefined,
        );
      }
      await aborting;
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
  let head = 0;
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

  function currentHead() {
    return chunks[head];
  }

  function compact() {
    if (head === 0) return;
    if (head === chunks.length) {
      chunks.length = 0;
      head = 0;
      return;
    }
    if (head > 64 && head * 2 >= chunks.length) {
      chunks.splice(0, head);
      head = 0;
    }
  }

  function take(count) {
    const out = new Uint8Array(count);
    let offset = 0;
    while (offset < count) {
      const chunk = currentHead();
      const need = count - offset;
      if (chunk.byteLength <= need) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
        buffered -= chunk.byteLength;
        head += 1;
        compact();
      } else {
        out.set(chunk.subarray(0, need), offset);
        chunks[head] = chunk.subarray(need);
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
      const chunk = currentHead();
      if (chunk.byteLength <= remaining) {
        if (sink) await sink(chunk);
        remaining -= chunk.byteLength;
        buffered -= chunk.byteLength;
        consumedBytes += chunk.byteLength;
        head += 1;
        compact();
      } else {
        if (sink) await sink(chunk.subarray(0, remaining));
        chunks[head] = chunk.subarray(remaining);
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

export async function summarizeFile(path, body, maxTextSampleChars = 0) {
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
  // over textSample in the parent worker, so clipping the *scanned* text is
  // exactly the truncation hole that lets an attacker bury a payload past a
  // fixed window (issue #191). The persisted/display sample is bounded
  // separately at the persistence layer; per-body work is bounded by the
  // per-file cap and total retained bytes by the streaming reader's retention
  // budget and MAX_FILES.
  //
  // `maxTextSampleChars` is opt-in and 0 (unbounded) for every reviewed/staged
  // parse. It exists for baseline (already-published) parses, whose samples are
  // never scanned as the release under review and never persisted — see
  // BASELINE_TEXT_SAMPLE_LIMIT. A clipped body is flagged `baseline-truncated`,
  // not `truncated`, so the reviewed side's display-truncation flag keeps its
  // meaning. Binary/control-character classification always reads the full body,
  // so the `binary` flag and the hash stay identical to an uncapped parse; only
  // how much of the decoded text is carried changes.
  const text = decodeText(body);
  if (!text) flags.push("binary");
  const limit = maxTextSampleChars > 0 && !isRetainedManifestPath(path) ? maxTextSampleChars : 0;
  const clipped = limit > 0 && text.length > limit ? clipTextSample(text, limit) : text;
  // Deliberately NOT the `truncated` flag the persistence layer adds to a
  // reviewed file's display sample: only baseline parses set a cap, and
  // `createPackageDiff` unions both sides' flags into the canonical diff entry,
  // where a bare `truncated` would read as "the reviewed body was clipped".
  if (clipped !== text) flags.push("baseline-truncated");
  return {
    path,
    size: body.length,
    sha256: hash,
    flags,
    ...(clipped ? { textSample: clipped } : {}),
  };
}

// Cut a decoded body back to the last complete line inside `limit` characters.
// Line-granular so the clipped tail cannot make the last retained line of a
// baseline file read as modified purely because it was cut mid-line. Falls back
// to the hard character cut when the limit lands inside one very long line.
export function clipTextSample(text, limit) {
  const head = text.slice(0, limit);
  const lastBreak = head.lastIndexOf("\n");
  return lastBreak > 0 ? head.slice(0, lastBreak + 1) : head;
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

export async function readTar(
  buffer,
  maxFiles,
  maxTarBytes,
  maxTextSampleChars = 0,
  rootStrip = "package-prefix",
) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  return readTarStream(
    new Response(bytes).body,
    maxFiles,
    maxTarBytes,
    Infinity,
    undefined,
    maxTextSampleChars,
    rootStrip,
  );
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
//
// File counts are tiered the same way bytes are: `maxFiles` bounds how many
// bodies keep a full text sample (the expensive tier — whole-body decode plus
// downstream detection work), while `maxEntries` is the hard cap on entries
// walked at all. Big-but-honest sdists (numpy vendors its entire build system:
// 8k+ files) parse instead of failing; files past the full-inspection tier are
// still hashed and native-sniffed, so the diff layer can prove them identical
// to (or diverged from) the baseline.
export async function readTarStream(
  body,
  maxFiles,
  maxTarBytes,
  maxStreamBytes,
  maxEntries,
  maxTextSampleChars = 0,
  rootStrip = "package-prefix",
) {
  const nul = String.fromCharCode(0);
  if (!body) throw tarError("tarball decompression failed");
  const cursor = createStreamCursor(body, maxStreamBytes);
  const { fill, take, discard } = cursor;
  // Entry cap can only widen the file cap, never shrink it: callers that don't
  // opt into the two-tier split keep the old single-cap behavior.
  const entryLimit = Math.max(Number.isFinite(maxEntries) ? maxEntries : maxFiles, maxFiles);

  const files = [];
  const suspicious = [];
  const suspiciousLimit = Math.max(1, Number.isFinite(maxFiles) ? maxFiles : 250);
  let suspiciousLimitReached = false;
  const seenPaths = new Map();
  // Bytes each retained path contributes to `retainedBytes`, so a later
  // duplicate that replaces an entry releases the earlier body's budget instead
  // of double-counting it (which would prematurely exhaust the retention limit).
  const retainedByPath = new Map();
  // Pending extended-header state: `pax` is the local record (PAX `x`/`X` plus
  // GNU `L`/`N`/`K` long names, merged), cleared by the next non-metadata entry;
  // `paxGlobal` is the archive-wide record, which is not. Both are merged in
  // place, last value winning: copying the pending record per header costs
  // headers × pending keys, which a run of large headers turns quadratic.
  let pax = null;
  let paxGlobal = null;
  // Whether the pending path came through a PAX record as all digits: node-tar
  // coerces that to a Number (and its typeflag-0 decode then throws on it),
  // but a GNU `L`/`N` long name of the same digits stays a string.
  let paxPathNumeric = false;
  // How the pending record was built. node-tar merges every metadata header
  // before a member into one record, last value winning. CPython's tarfile
  // (pip's reader) lets the first record win, POSIX treats an empty pax value
  // as deleting the field, and uv's tar-codec refuses these shapes outright.
  // The path recorded here stays node-tar's; these counts only disclose that
  // the answer depends on the reader.
  let metaShape = null;
  const globalNotices = new Set();
  let retainedBytes = 0;
  let entryCount = 0;
  let retainedTextCount = 0;
  // Bulk demotions (cumulative budget spent, full-inspection tier filled) are
  // coverage disclosure, not per-file anomalies: one aggregate suspicious entry
  // per cause, with the count filled in once the walk finishes. Per-file
  // entries stay reserved for bodies over the per-file inspection limit.
  let demotedByBudget = 0;
  let demotedByTier = 0;
  let budgetNotice = null;
  let tierNotice = null;
  // A node-tar null block only ends the archive when the block after it is also
  // null, so the first one is held pending rather than acted on.
  let pendingNullBlock = false;
  let entriesAfterNullBlock = 0;
  let nullBlockNotice = null;
  let rejectedBlocks = 0;
  let rejectedNotice = null;

  // A header npm's reader rejects. Recorded once, with a count: each one is a
  // block this reader also skips without consuming a body, so the two stay on
  // the same boundaries, but no publisher toolchain emits any of them.
  function rejectHeader() {
    rejectedBlocks += 1;
    if (!rejectedNotice) {
      rejectedNotice = { kind: "parser-differential", path: "<archive>", detail: "" };
      suspicious.push(rejectedNotice);
    }
  }

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

  function currentMetaShape() {
    if (!metaShape) {
      metaShape = {
        gnuName: 0,
        gnuLink: 0,
        paxPath: 0,
        paxLinkpath: 0,
        paxSize: 0,
        empty: [],
        oversized: [],
        emptyGnu: [],
        paxBody: new Set(),
        oldGnu: false,
        sizedMeta: false,
        cpythonPath: null,
      };
    }
    return metaShape;
  }

  function addOnce(list, value) {
    if (!list.includes(value)) list.push(value);
  }

  function noteMetadata(type, parsed) {
    currentMetaShape();
    if (type === "L" || type === "N") metaShape.gnuName += 1;
    else if (type === "K") metaShape.gnuLink += 1;
    else {
      if (typeof parsed.path === "string") metaShape.paxPath += 1;
      if (typeof parsed.linkpath === "string") metaShape.paxLinkpath += 1;
      if (typeof parsed.size === "string") metaShape.paxSize += 1;
      // parsePax keeps `key=` and a bare `key` alike as "", the
      // present-but-empty record node-tar applies and POSIX defines as deleting
      // the field. Only the keys that decide where bytes land are disclosed.
      for (const key of ["path", "linkpath", "size"]) {
        if (parsed[key] === "") addOnce(metaShape.empty, key);
      }
    }
  }

  // One entry per member, so repeating the shape cannot spend the suspicious
  // cap faster than the archive spends entries.
  function discloseMetadataShape(path) {
    const shape = metaShape;
    metaShape = null;
    if (!shape) return;
    const details = [];
    if (shape.gnuName > 0 && shape.paxPath > 0) {
      details.push(
        "member carries both a GNU long-name record (`L`/`N`) and a pax `path` record; node-tar merges them and keeps whichever came last, while other extractors honor one tar family over the other or refuse the archive",
      );
    }
    if (shape.gnuLink > 0 && shape.paxLinkpath > 0) {
      details.push(
        "member carries both a GNU long-link record (`K`) and a pax `linkpath` record; node-tar merges them and keeps whichever came last, while other extractors honor one tar family over the other or refuse the archive",
      );
    }
    const repeated = [
      [shape.gnuName, "GNU long-name records (`L`/`N`)", "path"],
      [shape.gnuLink, "GNU long-link records (`K`)", "link target"],
      [shape.paxPath, "pax extended headers that set `path`", "path"],
      [shape.paxLinkpath, "pax extended headers that set `linkpath`", "link target"],
      [shape.paxSize, "pax extended headers that set `size`", "body length"],
    ];
    for (const [count, what, field] of repeated) {
      if (count > 1) {
        details.push(
          `member carries ${count} ${what}; node-tar uses the last, other extractors may use the first, so the ${field} depends on the extractor`,
        );
      }
    }
    for (const key of shape.empty) {
      details.push(
        key === "size"
          ? "member's pax header carries an empty `size` record (a tombstone); node-tar reads a zero-length body, while a reader that treats it as deleting the field uses the header's own size, so the two walk the rest of the archive on different block boundaries"
          : `member's pax header carries an empty \`${key}\` record (a tombstone); node-tar takes the empty value, while a reader that treats it as deleting the field falls back to the header's own ${key === "path" ? "name" : "linkname"} field or an earlier record`,
      );
    }
    if (shape.oldGnu) {
      details.push(
        "member is named by an old GNU `N` record; node-tar reads it as a long path, while extractors without that type (CPython tarfile) extract the record as a file of its own and keep the member's header name",
      );
    }
    for (const type of shape.oversized) {
      details.push(
        `member is preceded by a \`${type}\` metadata header larger than node-tar's 1 MiB limit; node-tar ignores it, while extractors without that limit (CPython tarfile) apply it, so the member's path, link target or size depends on the extractor`,
      );
    }
    for (const type of shape.emptyGnu) {
      details.push(
        `member is preceded by a zero-length GNU \`${type}\` record; node-tar ignores it, while CPython tarfile applies the empty ${type === "L" ? "name" : "link target"}`,
      );
    }
    if (shape.cpythonPath !== null) {
      details.push(
        `member's header has no ustar magic but a non-empty prefix field; node-tar ignores the prefix, while pip's CPython tarfile joins it and extracts the member as \`${shape.cpythonPath}\``,
      );
    }
    if (shape.paxBody.size) {
      details.push(`member's pax header carries ${[...shape.paxBody].join("; and ")}`);
    }
    if (shape.sizedMeta) {
      details.push(
        "a pending pax `size` record also sized a metadata header before this member; node-tar applies it to that header's body, while CPython tarfile applies it only to the member, so the two read different block boundaries",
      );
    }
    if (details.length) {
      addSuspicious({ kind: "parser-differential", path, detail: details.join("; ") });
    }
  }

  // A global header applies archive-wide, so each differential shape is
  // disclosed once rather than per header.
  function discloseGlobalNotice(key) {
    if (globalNotices.has(key)) return;
    globalNotices.add(key);
    const details = {
      path: "a pax global header sets `path` or `linkpath`; node-tar ignores both, while extractors that apply global records name the following entries by it",
      size: "a pax global header sets `size`; node-tar applies it to every following entry without its own size, while extractors that ignore a global size read the header's own, so the two walk the archive on different block boundaries",
      oversized:
        "a pax global header larger than node-tar's 1 MiB limit was ignored; extractors without that limit (CPython tarfile) apply it to the entries that follow",
      body: "a pax global header body carries records that node-tar (splitting on newlines) and CPython tarfile (walking the declared lengths) read differently, or GNU sparse keys that change the bytes CPython tarfile writes",
    };
    addSuspicious({ kind: "parser-differential", path: "<archive>", detail: details[key] });
  }

  function discloseGlobalRecord(parsed) {
    if (typeof parsed.path === "string" || typeof parsed.linkpath === "string") {
      discloseGlobalNotice("path");
    }
    if (typeof parsed.size === "string") discloseGlobalNotice("size");
  }

  try {
    while (await fill(512)) {
      const header = take(512);
      const checksum = tarHeaderChecksum(header);
      // node-tar's null block is one whose every byte outside the checksum field
      // is zero and whose checksum field does not parse — not only an all-zero
      // block. Two blocks with, say, spaces in that field end the archive for
      // npm, so they must end it here or the entries after them are reported as
      // files npm never writes. (A base-256 checksum on an otherwise-zero block
      // parses, so node-tar treats that as a checksum failure instead.)
      const isNullBlock =
        checksum.computed === 8 * 0x20 && checksum.declared === null && !(header[148] & 0x80);
      if (isNullBlock) {
        // The tar end-of-archive marker is TWO consecutive null blocks, and
        // node-tar — the reader `npm install` extracts with — ends the archive
        // only on the second one; a lone null block is skipped and parsing
        // resumes at the next header. Ending here on the first block would let
        // an archive hide every following entry behind one null block: the
        // reviewer sees a short archive while the consumer's extractor reads on
        // and writes the rest.
        if (pendingNullBlock) break;
        pendingNullBlock = true;
        continue;
      }
      if (pendingNullBlock) {
        pendingNullBlock = false;
        if (!nullBlockNotice) {
          // Pushed directly rather than through addSuspicious: entries that only
          // a two-block-aware reader reaches are exactly what a reviewer must
          // see, so this disclosure must survive a suspicious list already at
          // its cap.
          nullBlockNotice = { kind: "parser-differential", path: "<archive>", detail: "" };
          suspicious.push(nullBlockNotice);
        }
      }
      entryCount += 1;
      if (entryCount > entryLimit) throw tarError("archive contains too many files");

      // A block npm's reader rejects is skipped *without consuming its declared
      // body*, and the next 512 bytes are read as another header. Treating one
      // as an entry would consume that body and put the two readers on different
      // block boundaries for everything after it — one rejected header would
      // hide the whole tail of the archive. node-tar rejects a header on a
      // checksum mismatch, on a base-256 numeric field it cannot decode, on an
      // empty path, and on a linkname where the type does not allow one (or a
      // link with none); each is mirrored below.
      if (checksum.declared === null || checksum.declared !== checksum.computed) {
        if (header[148] & 0x80) {
          // A base-256 encoded checksum: node-tar decodes it, and no writer
          // emits it. Rather than reimplement that decode and risk skipping a
          // block npm reads as an entry, fail closed on the one shape where
          // this reader cannot be sure which way node-tar will go.
          throw tarError("invalid tar header checksum");
        }
        rejectHeader();
        continue;
      }

      const rawName = readString(header, 0, 100);
      const type = String.fromCharCode(header[156] || 48);
      // Metadata headers: `x`/`X` extended, `g` global, `L`/`N` long path, `K`
      // long linkpath. node-tar merges all of them into one pending record that
      // survives until the next non-metadata entry, so a `K` sitting between an
      // `L` and its file must not drop the long path.
      const isMeta =
        type === "x" ||
        type === "X" ||
        type === "g" ||
        type === "L" ||
        type === "N" ||
        type === "K";

      // The ustar prefix field is only a prefix when the ustar magic says so —
      // node-tar reads bytes 345+ as a path component only then, and reads 130
      // rather than 155 of them when byte 475 is NUL (old GNU tars put atime
      // there). Reading it unconditionally would report a nested path for an
      // entry npm writes at the package root, which is exactly where the root
      // manifest and `binding.gyp` rules look.
      const ustar =
        readString(header, 257, 6) === "ustar" && header[263] === 48 && header[264] === 48;
      const prefix = ustar ? readString(header, 345, header[475] !== 0 ? 155 : 130) : "";
      // node-tar decodes each numeric field only when no PAX record — local,
      // then global — overrides that key, and a base-256 field it cannot decode
      // throws out of the header decode: the block is skipped without consuming
      // its body, like a checksum failure. The checksum is handled above and
      // `size` below (a base-256 size fails the parse rather than the header);
      // the device and time fields exist only under the ustar magic, and the
      // times only when byte 475 is NUL, because otherwise those bytes are the
      // long prefix. Only a key node-tar's `Pax` record carries can be
      // overridden: its constructor copies uid, gid, mtime, atime, and ctime but
      // never mode or the device numbers, so a `mode=` record changes nothing
      // and those fields are always decoded from the header.
      const numericFields = [
        ["mode", 100, 8, false],
        ["uid", 108, 8, true],
        ["gid", 116, 8, true],
        ["mtime", 136, 12, true],
      ];
      if (ustar) {
        numericFields.push(["devmaj", 329, 8, false], ["devmin", 337, 8, false]);
        if (header[475] === 0) {
          numericFields.push(["atime", 476, 12, true], ["ctime", 488, 12, true]);
        }
      }
      const overriddenByPax = (key) =>
        (pax !== null && typeof pax[key] === "string") ||
        (paxGlobal !== null && typeof paxGlobal[key] === "string");
      if (
        numericFields.some(
          ([key, offset, length, paxCarried]) =>
            !(paxCarried && overriddenByPax(key)) && isRejectedTarNumber(header, offset, length),
        )
      ) {
        rejectHeader();
        continue;
      }
      // node-tar coerces an all-digit PAX value to a number, and `path=123` then
      // makes its header decode throw — but only for typeflag `0`/NUL, where it
      // calls `.slice` on the path to spot a trailing `/`. The block is skipped
      // without consuming a body and the record stays pending, so every regular
      // file after it is skipped the same way, while a metadata or non-regular
      // header in between is still read (and a later `x` can replace the path).
      if (paxPathNumeric && (type === "0" || type === nul)) {
        rejectHeader();
        continue;
      }
      // A PAX/long name replaces the header's own name. node-tar prepends the
      // ustar prefix to the header's path but then overwrites the whole thing
      // with the extended-header path when there is one, so the prefix survives
      // only for an entry named by its own header. Prepending it to a PAX path
      // would report `lib/package/binding.gyp` for a file npm writes at the root.
      const paxPath = pax && typeof pax.path === "string" ? pax.path : null;
      const namePath = paxPath === null ? rawName : paxPath;
      // With byte 475 set node-tar prepends the prefix unconditionally, so an
      // empty prefix still yields `/` + name — a truthy path for an empty name
      // (accepted, body consumed) and a leading slash that puts `package/…`
      // one level down for npm's `strip: 1`.
      const headerPath =
        prefix || (ustar && header[475] !== 0) ? prefix + "/" + namePath : namePath;
      const rawCandidate = paxPath === null ? headerPath : paxPath;
      // An empty path is a header npm's reader rejects without consuming its
      // body. An empty `path=` record counts as present, so under a ustar prefix
      // the header's path is `prefix/` and node-tar accepts it, consumes the
      // body, and only then drops the entry in unpack — so that case falls
      // through to the unrepresentable-path disclosure below instead. A numeric
      // `path=0` is the Number 0 to node-tar — falsy, so rejected — unless a
      // prefix turns it into the string `prefix/0`.
      if (!headerPath || (paxPathNumeric && Number(paxPath) === 0 && headerPath === paxPath)) {
        rejectHeader();
        continue;
      }

      // node-tar reads the linkname field itself here, never the `K`/PAX
      // override, and rejects the header when it disagrees with the type.
      const linkname = readString(header, 157, 100);
      const isLink = type === "1" || type === "2";
      if (isLink ? !linkname : linkname && type !== "x" && type !== "g") {
        rejectHeader();
        continue;
      }

      // CPython's `TarInfo.frombuf` (pip's sdist reader) joins any non-empty
      // prefix field to the name whatever the magic says, unless an extended
      // header names the member or the type is GNU. node-tar reads bytes 345+
      // only under the ustar magic, so the two name the same member differently.
      if (!isMeta && !ustar && header[345] !== 0 && paxPath === null && type !== "S") {
        const prefixEnd = header.subarray(345, 500).indexOf(0);
        const cpythonPrefix = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(
          header.subarray(345, prefixEnd < 0 ? 500 : 345 + prefixEnd),
        );
        currentMetaShape().cpythonPath = clipTextSample(cpythonPrefix + "/" + rawName, 256);
      }

      // PAX and long-name blocks describe the entry after them rather than an
      // entry of their own, so they must not inflate the count of entries a
      // first-block reader misses.
      if (nullBlockNotice && !isMeta) entriesAfterNullBlock += 1;

      const sizeText = readString(header, 124, 12).trim() || "0";
      if (!/^[0-7]+$/.test(sizeText)) throw tarError("invalid tar entry size");
      let size = parseInt(sizeText, 8);
      if (!Number.isFinite(size) || size < 0) throw tarError("invalid tar entry size");
      // node-tar takes a PAX `size` over the header's own — local first, then
      // global, and it applies to metadata blocks too. Without this an archive
      // can declare one body length to this reader and another to npm and put
      // every following entry on a different block boundary. `size=0` counts:
      // node-tar falls through only on a missing record, not a zero one.
      const paxSize =
        pax && typeof pax.size === "string"
          ? pax.size
          : paxGlobal && typeof paxGlobal.size === "string"
            ? paxGlobal.size
            : null;
      if (paxSize !== null) {
        // An empty value (`size=` or a `size` record with no `=`) is a
        // zero-length body to node-tar, whose remaining-bytes check treats the
        // empty string as nothing left to read. Any other non-digit value has no
        // defined outcome there, so it fails the parse.
        if (paxSize !== "" && !/^[0-9]+$/.test(paxSize)) throw tarError("invalid tar entry size");
        size = paxSize === "" ? 0 : Number(paxSize);
        if (!Number.isSafeInteger(size) || size < 0) throw tarError("invalid tar entry size");
      }

      // node-tar reads a `0`/NUL entry whose name ends in `/` as a directory,
      // and npm does not write it. Typeflag `7` (contiguous file) it extracts as
      // an ordinary file, so it is read as one here.
      const namedDirectory = (type === "0" || type === nul) && namePath.endsWith("/");
      const isRegular = !namedDirectory && (type === "0" || type === nul || type === "7");
      // A directory record carries no body whatever it declares: node-tar zeroes
      // the size, so a directory claiming one would swallow the entries npm goes
      // on to extract.
      if (type === "5" || namedDirectory) size = 0;
      const padding = Math.ceil(size / 512) * 512 - size;

      // Only regular files stream-skip oversized bodies (the prepackaged-binary
      // case). Non-regular entries are never legitimately huge, so an oversized
      // body is malformed/hostile — fail closed rather than burn the sandbox's
      // CPU budget discarding it. Metadata carries its own limit below.
      if (!isRegular && !isMeta && size > maxTarBytes) throw tarError("invalid tar entry size");

      if (isMeta) {
        // node-tar sizes a metadata body by a pending local `size` record too;
        // CPython's tarfile applies that record only to the member it precedes.
        if (pax !== null && typeof pax.size === "string") currentMetaShape().sizedMeta = true;
        // CPython's tarfile has no `N` type: it extracts the record as a file of
        // its own and leaves the member its header name.
        if (type === "N") currentMetaShape().oldGnu = true;
        // node-tar ignores a metadata entry larger than 1 MiB outright: the body
        // is skipped and the pending record left untouched. Honoring a larger
        // one would apply a path npm never sees, but readers without the limit
        // do apply it.
        if (size > 1024 * 1024) {
          if (!(await discard(size))) throw tarError("truncated tar entry");
          if (type === "g") discloseGlobalNotice("oversized");
          else addOnce(currentMetaShape().oversized, type);
        } else if (size > 0) {
          if (!(await fill(size))) throw tarError("truncated tar entry");
          const body = take(size);
          if (type === "g") {
            // A global header's `path` and `linkpath` do not carry to later
            // entries (node-tar drops both when merging it in) but its other
            // attributes, `size` among them, do. It does not clear the pending
            // local record either.
            const parsed = parsePax(body);
            discloseGlobalRecord(parsed);
            if (paxBodyAnomalies(body).length) discloseGlobalNotice("body");
            paxGlobal = Object.assign(paxGlobal ?? {}, parsed);
          } else if (type === "x" || type === "X") {
            const parsed = parsePax(body);
            if (typeof parsed.path === "string") paxPathNumeric = /^[0-9]+$/.test(parsed.path);
            noteMetadata(type, parsed);
            // Bounded: a member can sit behind any number of `x` headers, and
            // the phrases name attacker-chosen keys, so they can all differ.
            const anomalies = currentMetaShape().paxBody;
            for (const anomaly of paxBodyAnomalies(body)) {
              if (anomalies.size < 8) anomalies.add(anomaly);
            }
            pax = Object.assign(pax ?? {}, parsed);
            if (typeof pax.path === "string" && !isSafePaxPath(pax.path)) {
              throw tarError("invalid pax path");
            }
          } else {
            // readString already stops at the first NUL terminator, so the
            // long-name payload is implicitly trimmed at the NUL boundary.
            const candidate = readString(body, 0, body.length);
            noteMetadata(type, null);
            if (type === "K") {
              // Long link target. Parsed only so it cannot be mistaken for an
              // entry of its own; link targets are not reviewed here.
              pax = Object.assign(pax ?? {}, { linkpath: candidate });
            } else {
              if (!isSafePaxPath(candidate)) throw tarError("invalid long-name path");
              pax = Object.assign(pax ?? {}, { path: candidate });
              paxPathNumeric = false;
            }
          }
        } else if (type === "L" || type === "K") {
          // A zero-length metadata entry never enters node-tar's meta state, so
          // it changes nothing: an empty `L` must not set an empty path that
          // rejects the file it precedes. CPython's tarfile applies the empty
          // value, and no writer emits one.
          addOnce(currentMetaShape().emptyGnu, type);
        }
        if (padding > 0) await discard(padding);
        continue;
      }

      if (isRegular) {
        const canonicalCandidate = canonicalizePath(rawCandidate);
        const path = normalizeTarPath(rawCandidate, rootStrip);
        const canonicalPath = normalizeTarPath(canonicalCandidate, rootStrip);
        // A regular file whose path this reader cannot represent used to be
        // dropped outright, which deleted the only evidence that it exists. npm
        // still extracts several of these — a backslash is an ordinary filename
        // character on POSIX, so is a leading `C:`, and node-tar has no length
        // cap — so the entry is disclosed instead: the reviewer sees that the
        // archive carries a file this reader could not name, and its body is
        // skipped rather than silently attributed to nothing.
        if (!path) {
          addSuspicious({
            kind: "parser-differential",
            path: clipTextSample(rawCandidate, 256) || "<unnamed>",
            detail:
              rawCandidate.length > 512
                ? "entry path exceeds the 512-character limit this reader records; the entry was not inspected"
                : rootStrip === "strip1" && !rawCandidate.includes("/")
                  ? "entry has no directory component, so npm's `strip: 1` leaves no path and installs no file for it; recorded as evidence the archive carries it, with its content not inspected here"
                  : "entry path is not representable as a safe relative path (traversal sequence, drive letter, or backslash separator); npm's reader may still extract it, so its content was not inspected here",
          });
        }
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
        // The full-inspection tier bounds text-sample retention by count the
        // way the budget bounds it by bytes; manifests keep drawing on their
        // bounded byte headroom past the tier because identity evidence is
        // exactly what must not be starved by a padded archive.
        const tierFull = retainedTextCount >= maxFiles;
        const retainBody =
          size <= maxTarBytes &&
          (isNpmRootManifest ||
            (!tierFull && budgetBase + size <= maxTarBytes) ||
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
          summarized = await summarizeFile(path, take(size), maxTextSampleChars);
          contributed = size;
          retainedTextCount += 1;
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
            // A body over the per-file limit is a notable artifact in its own
            // right (the prepackaged-binary pattern) and keeps its per-file
            // entry. Small bodies demoted in bulk — budget spent or tier
            // filled — collapse into one aggregate entry per cause: a large
            // sdist can demote thousands of files, and a per-file entry for
            // each would flood the suspicious list and the findings built
            // from it. Each demoted file still carries its content-skipped
            // flag, size, and sha256 in the file record.
            if (size > maxTarBytes) {
              addSuspicious({
                kind: "content-skipped",
                path,
                detail: `file body (${size} bytes) exceeds the ${maxTarBytes}-byte per-file inspection limit; path, size, and sha256 recorded but content not inspected`,
              });
            } else if (tierFull) {
              demotedByTier += 1;
              if (!tierNotice) {
                // Pushed directly, not via addSuspicious: an archive that
                // fills the suspicious cap with per-file entries first must
                // not silently drop the coverage disclosure, and the
                // aggregates are bounded to one per cause.
                tierNotice = { kind: "retention-tier", path: "<archive>", detail: "" };
                suspicious.push(tierNotice);
              }
            } else {
              demotedByBudget += 1;
              if (!budgetNotice) {
                budgetNotice = { kind: "retention-tier", path: "<archive>", detail: "" };
                suspicious.push(budgetNotice);
              }
            }
          }
        }
        if (path && summarized) {
          if (seenPaths.has(path)) {
            // Match last-write-wins extraction so downstream checks inspect the
            // bytes consumers are likely to receive, while still surfacing the duplicate.
            addSuspicious({
              kind: "duplicate",
              path,
              detail:
                files[seenPaths.get(path)].sha256 === summarized.sha256
                  ? "duplicate path; later entry replaced earlier entry"
                  : "duplicate path; later entry replaced earlier entry with different content, so the earlier body was not inspected",
            });
            retainedBytes -= retainedByPath.get(path) || 0;
            files[seenPaths.get(path)] = summarized;
          } else {
            if (files.length >= entryLimit) throw tarError("archive contains too many files");
            seenPaths.set(path, files.length);
            files.push(summarized);
          }
          retainedByPath.set(path, contributed);
          retainedBytes += contributed;
        }
        discloseMetadataShape(path || clipTextSample(rawCandidate, 256) || "<unnamed>");
        pax = null;
        paxPathNumeric = false;
      } else {
        // Non-regular entry (hardlink, symlink, device, directory, fifo,
        // reserved). npm publish never emits these; a hand-crafted tar can.
        const reportedPath =
          normalizeTarPath(canonicalizePath(rawCandidate), rootStrip) || rawCandidate || "";
        // A `0`/NUL entry whose name ends in `/` is a directory to node-tar, so
        // it is reported as the directory record it is rather than as its
        // typeflag byte.
        const reportedType = namedDirectory ? "5" : type;
        addSuspicious({
          kind: "non-regular",
          path: reportedPath,
          detail: `typeflag ${reportedType} (${describeNonRegularType(reportedType)})`,
        });
        discloseMetadataShape(reportedPath || "<unnamed>");
        if (!(await discard(size))) throw tarError("truncated tar entry");
        pax = null;
        paxPathNumeric = false;
      }

      // Inter-entry padding; a missing final pad block is tolerated like the
      // buffer reader tolerated a trailing partial block.
      if (padding > 0) await discard(padding);
    }
    // Metadata no member consumed (every later header rejected, or the archive
    // ended) still decided how npm walked the blocks after it.
    discloseMetadataShape("<archive>");
    // The aggregate demotion notices were pushed at first occurrence (so they
    // survive the suspicious-entry cap); the final counts only exist now.
    if (budgetNotice) {
      budgetNotice.detail = `the archive's ${maxTarBytes}-byte cumulative retention budget was spent on earlier files; ${demotedByBudget} additional file bodies were recorded hash-only (path, size, sha256) without content inspection`;
    }
    if (tierNotice) {
      tierNotice.detail = `the archive exceeds the ${maxFiles}-file full-inspection tier; ${demotedByTier} additional file bodies were recorded hash-only (path, size, sha256) without content inspection`;
    }
    if (rejectedNotice) {
      rejectedNotice.detail = `${rejectedBlocks} header ${rejectedBlocks === 1 ? "block is one npm's reader rejects" : "blocks are ones npm's reader rejects"} (checksum mismatch, a base-256 numeric field it cannot decode, missing path, or a linkname the entry type does not allow); each was skipped without consuming the body it declared, as npm's reader does, so the entries after it are the ones npm extracts`;
    }
    if (nullBlockNotice) {
      nullBlockNotice.detail = `${entriesAfterNullBlock} ${entriesAfterNullBlock === 1 ? "entry follows" : "entries follow"} a node-tar null block that is not part of the two-block end-of-archive marker; a reader that ends the archive at the first null block never sees them`;
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
export async function readZipArchiveBuffered(
  buffer,
  maxFiles,
  maxArchiveBytes,
  maxEntries,
  maxTextSampleChars = 0,
) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const eocd = findZipEndOfCentralDirectory(bytes);
  if (eocd < 0) throw tarError("zip central directory not found");

  const entryCount = readUint16Le(bytes, eocd + 10);
  const entryLimit = Math.max(Number.isFinite(maxEntries) ? maxEntries : maxFiles, maxFiles);
  const centralDirectorySize = readUint32Le(bytes, eocd + 12);
  const centralDirectoryOffset = readUint32Le(bytes, eocd + 16);
  if (
    entryCount === 0xffff ||
    centralDirectorySize === 0xffffffff ||
    centralDirectoryOffset === 0xffffffff
  ) {
    throw tarError("zip64 archives are not supported");
  }
  if (entryCount > entryLimit) throw tarError("archive contains too many files");
  if (centralDirectoryOffset + centralDirectorySize > bytes.length) {
    throw tarError("truncated zip central directory");
  }

  const files = [];
  const suspicious = [];
  let expandedBytes = 0;
  let retainedTextCount = 0;
  let demotedByTier = 0;
  let tierNotice = null;
  let offset = centralDirectoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > bytes.length || readUint32Le(bytes, offset) !== 0x02014b50) {
      throw tarError("invalid zip central directory");
    }
    const nameFlags = readUint16Le(bytes, offset + 8);
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

    const rawPath = decodeZipName(bytes.subarray(fileNameStart, fileNameEnd), nameFlags);
    const path = normalizeZipPath(rawPath);
    offset = fileNameEnd + extraLength + commentLength;

    if (!path) {
      const unrepresentable = unrepresentableZipEntry(rawPath);
      if (unrepresentable) suspicious.push(unrepresentable);
      continue;
    }
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
    const tierFull = retainedTextCount >= maxFiles;
    if (!tierFull || isRetainedManifestPath(path)) {
      files.push(await summarizeFile(path, body, maxTextSampleChars));
      retainedTextCount += 1;
    } else {
      files.push(
        summarizeSkippedFile(path, uncompressedSize, await sha256Hex(body), body.subarray(0, 64)),
      );
      demotedByTier += 1;
      if (!tierNotice) {
        tierNotice = { kind: "retention-tier", path: "<archive>", detail: "" };
        suspicious.push(tierNotice);
      }
    }
  }
  if (tierNotice) {
    tierNotice.detail = `the archive exceeds the ${maxFiles}-file full-inspection tier; ${demotedByTier} additional file bodies were recorded hash-only (path, size, sha256) without content inspection`;
  }
  return { files, suspicious };
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
export async function readZipStream(
  body,
  maxFiles,
  maxTarBytes,
  maxStreamBytes,
  maxEntries,
  maxTextSampleChars = 0,
) {
  if (!body) throw tarError("archive download failed");
  const cursor = createStreamCursor(body, maxStreamBytes);
  const expansionLimit = Number.isFinite(maxStreamBytes) ? maxStreamBytes : Infinity;
  // Two-tier caps, mirroring readTarStream: `maxFiles` bounds full text-sample
  // retention, `maxEntries` (never below maxFiles) is the hard walk cap.
  const entryLimit = Math.max(Number.isFinite(maxEntries) ? maxEntries : maxFiles, maxFiles);

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
  let localEntryCount = 0;
  let retainedBytes = 0;
  let expandedBytes = 0;
  let sawCentralDirectory = false;
  let centralEntryCount = 0;
  let retainedTextCount = 0;
  // Bulk demotions aggregate into one suspicious entry per cause (see
  // readTarStream); per-file entries stay reserved for oversized bodies.
  let demotedByBudget = 0;
  let demotedByTier = 0;
  let budgetNotice = null;
  let tierNotice = null;

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
        const rawPath = decodeZipName(cursor.take(fileNameLength), flags);
        if (!(await cursor.discard(extraLength))) throw tarError("truncated zip entry");
        localEntries.set(headerOffset, { rawPath, method, compressedSize, uncompressedSize });

        // Bound every local record, including directory markers and unsafe
        // paths, since each still consumes parser and central-directory work.
        localEntryCount += 1;
        if (localEntryCount > entryLimit) throw tarError("archive contains too many files");

        expandedBytes += uncompressedSize;
        if (expandedBytes > expansionLimit) throw tarError("archive expands beyond safety limit");

        const path = normalizeZipPath(rawPath);
        if (!path) {
          const unrepresentable = unrepresentableZipEntry(rawPath);
          if (unrepresentable) addSuspicious(unrepresentable);
          // Their bytes still have to leave the stream.
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
        // Full-inspection tier: same count bound as readTarStream, with the
        // same manifest exemption (identity evidence draws on its bounded
        // byte headroom regardless of how many files preceded it).
        const tierFull = retainedTextCount >= maxFiles;
        const retainBody =
          uncompressedSize <= maxTarBytes &&
          ((!tierFull && budgetBase + uncompressedSize <= maxTarBytes) ||
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
          summarized = await summarizeFile(path, bodyBytes, maxTextSampleChars);
          contributed = uncompressedSize;
          retainedTextCount += 1;
        } else {
          const { sha256, head } = await digestSkippedZipEntry(
            cursor,
            compressedSize,
            uncompressedSize,
            method,
          );
          summarized = summarizeSkippedFile(path, uncompressedSize, sha256, head);
          // Oversized bodies keep their per-file entry (the prepackaged-binary
          // pattern); bulk demotions collapse into the per-cause aggregates,
          // mirroring readTarStream.
          if (uncompressedSize > maxTarBytes) {
            addSuspicious({
              kind: "content-skipped",
              path,
              detail: `file body (${uncompressedSize} bytes) exceeds the ${maxTarBytes}-byte per-file inspection limit; path, size, and sha256 recorded but content not inspected`,
            });
          } else if (tierFull) {
            demotedByTier += 1;
            if (!tierNotice) {
              // Pushed directly, not via addSuspicious: an archive that fills
              // the suspicious cap with per-file entries first must not
              // silently drop the coverage disclosure, and the aggregates are
              // bounded to one per cause.
              tierNotice = { kind: "retention-tier", path: "<archive>", detail: "" };
              suspicious.push(tierNotice);
            }
          } else {
            demotedByBudget += 1;
            if (!budgetNotice) {
              budgetNotice = { kind: "retention-tier", path: "<archive>", detail: "" };
              suspicious.push(budgetNotice);
            }
          }
        }
        if (seenPaths.has(path)) {
          // Python's zipfile resolves duplicate names last-write-wins (both for
          // extraction order and NameToInfo lookups), so inspect the bytes
          // consumers receive while surfacing the duplicate.
          addSuspicious({
            kind: "duplicate",
            path,
            detail:
              files[seenPaths.get(path)].sha256 === summarized.sha256
                ? "duplicate path; later entry replaced earlier entry"
                : "duplicate path; later entry replaced earlier entry with different content, so the earlier body was not inspected",
          });
          retainedBytes -= retainedByPath.get(path) || 0;
          files[seenPaths.get(path)] = summarized;
        } else {
          if (files.length >= entryLimit) throw tarError("archive contains too many files");
          seenPaths.set(path, files.length);
          files.push(summarized);
        }
        retainedByPath.set(path, contributed);
        retainedBytes += contributed;
      } else if (signature === 0x02014b50) {
        // Central directory record. Fixed fields after the signature:
        // flags@4, method@6, compressed size@16, uncompressed size@20, name length@24,
        // extra length@26, comment length@28, local header offset@38 (42 bytes).
        sawCentralDirectory = true;
        if (!(await cursor.fill(42))) throw tarError("invalid zip central directory");
        const header = cursor.take(42);
        const flags = readUint16Le(header, 4);
        const method = readUint16Le(header, 6);
        const compressedSize = readUint32Le(header, 16);
        const uncompressedSize = readUint32Le(header, 20);
        const fileNameLength = readUint16Le(header, 24);
        const extraLength = readUint16Le(header, 26);
        const commentLength = readUint16Le(header, 28);
        const localHeaderOffset = readUint32Le(header, 38);
        if (!(await cursor.fill(fileNameLength))) throw tarError("truncated zip filename");
        // Decoded by the central record's own flag: zipfile does the same and
        // refuses an archive whose local name decodes differently.
        const rawPath = decodeZipName(cursor.take(fileNameLength), flags);
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
    // The aggregate demotion notices were pushed at first occurrence (so they
    // survive the suspicious-entry cap); the final counts only exist now.
    if (budgetNotice) {
      budgetNotice.detail = `the archive's ${maxTarBytes}-byte cumulative retention budget was spent on earlier files; ${demotedByBudget} additional file bodies were recorded hash-only (path, size, sha256) without content inspection`;
    }
    if (tierNotice) {
      tierNotice.detail = `the archive exceeds the ${maxFiles}-file full-inspection tier; ${demotedByTier} additional file bodies were recorded hash-only (path, size, sha256) without content inspection`;
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
      peerDependenciesMeta: normalizePeerDependenciesMeta(parsed.peerDependenciesMeta),
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
