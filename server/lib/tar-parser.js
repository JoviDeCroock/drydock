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

// String.fromCharCode(0) avoids embedding a literal NUL byte in this source
// file, which would not survive every round-trip through tooling.
const NUL = String.fromCharCode(0);
export function readString(bytes, start, len) {
  let out = "";
  for (let i = start; i < start + len && bytes[i]; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

export function decodeText(bytes) {
  if (bytes.some((b) => b === 0)) return "";
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const control = [...text].filter((ch) => ch < " " && !"\n\r\t".includes(ch)).length;
  if (control > Math.max(5, text.length * 0.02)) return "";
  return text;
}

export function isSafePaxPath(value) {
  return typeof value === "string" && !value.includes(NUL) && !value.includes("\\");
}

export function normalizeTarPath(rawPath) {
  if (!rawPath || rawPath.includes(NUL) || rawPath.includes("\\")) return null;
  let path = rawPath.replace(/^\/+/, "").replace(/^package\//, "");
  if (!path || path.startsWith("../") || path.includes("/../") || /^[A-Za-z]:/.test(path))
    return null;
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

export async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function summarizeFile(path, body, maxBytesPerFile) {
  const flags = [];
  if (body.length > maxBytesPerFile) flags.push("truncated");
  const sample = body.subarray(0, Math.min(body.length, maxBytesPerFile));
  const text = decodeText(sample);
  if (!text) flags.push("binary");
  return {
    path,
    size: body.length,
    sha256: await sha256Hex(body),
    flags,
    ...(text ? { textSample: text } : {}),
  };
}

export async function readTar(buffer, maxFiles, maxBytesPerFile, maxTarBytes) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const files = [];
  let nextLongName = null;
  let pax = null;

  for (let offset = 0; offset + 512 <= bytes.length && files.length < maxFiles; ) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;

    const rawName = readString(header, 0, 100);
    const prefix = readString(header, 345, 155);
    const sizeText = readString(header, 124, 12).trim() || "0";
    if (!/^[0-7]+$/.test(sizeText)) throw new Error("invalid tar entry size");
    const size = parseInt(sizeText, 8);
    if (!Number.isFinite(size) || size < 0 || size > maxTarBytes)
      throw new Error("invalid tar entry size");
    const type = String.fromCharCode(header[156] || 48);
    offset += 512;
    if (offset + size > bytes.length) throw new Error("truncated tar entry");
    const body = bytes.subarray(offset, offset + size);

    if (type === "x") {
      pax = parsePax(body);
      if (pax && typeof pax.path === "string" && !isSafePaxPath(pax.path)) {
        throw new Error("invalid pax path");
      }
    } else if (type === "L") {
      // readString already stops at the first NUL terminator, so the long-name
      // payload is implicitly trimmed at the NUL boundary.
      const candidate = readString(body, 0, body.length);
      if (!isSafePaxPath(candidate)) throw new Error("invalid long-name path");
      nextLongName = candidate;
    } else if (type === "0" || type === NUL) {
      const path = normalizeTarPath(
        (pax && pax.path) || nextLongName || (prefix ? prefix + "/" : "") + rawName,
      );
      if (path) files.push(await summarizeFile(path, body, maxBytesPerFile));
      nextLongName = null;
      pax = null;
    } else if (type === "1" || type === "2") {
      // Hardlinks and symlinks are skipped so link targets cannot escape the package tree.
      nextLongName = null;
      pax = null;
    } else if (type !== "L") {
      nextLongName = null;
      pax = null;
    }

    offset += Math.ceil(size / 512) * 512;
  }
  return files;
}

export function parsePackageJson(files) {
  const pkg = files.find((f) => f.path === "package.json" && f.textSample);
  if (!pkg || !pkg.textSample) return null;
  try {
    const parsed = JSON.parse(pkg.textSample);
    return {
      name: parsed.name,
      version: parsed.version,
      scripts: parsed.scripts || {},
      dependencies: parsed.dependencies || {},
      devDependencies: parsed.devDependencies || {},
      peerDependencies: parsed.peerDependencies || {},
      optionalDependencies: parsed.optionalDependencies || {},
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

export async function gunzipBounded(body, maxBytes) {
  if (!body) throw new Error("tarball decompression failed");
  const ds = new DecompressionStream("gzip");
  const reader = body.pipeThrough(ds).getReader();
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
  return out.buffer;
}
