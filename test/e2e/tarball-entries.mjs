// Entry-name view of a packed fixture tarball, shared by the fixture builder
// and `test/e2e-fixture-tarballs.test.mjs`.
//
// The builder cannot ask `tar -t` what it just wrote: macOS tar folds
// AppleDouble `._name` members back into extended attributes when it reads an
// archive, so the metadata it adds on write is invisible in a listing taken on
// the same host. Reading the headers directly is what makes the check below
// mean anything.
//
// The walk follows the npm-visible reading of a tar (`server/lib/tar-parser.js`)
// rather than a strict-spec one: long-name records and pax `path=` overrides
// rename the member that follows them, and the archive ends at the second
// consecutive zero block, not the first. Anything looser fails open — it would
// report a clean entry list for an archive npm still unpacks members from.

import { gunzipSync } from "node:zlib";

const BLOCK = 512;
const NAME_OFFSET = 0;
const SIZE_OFFSET = 124;
const TYPEFLAG_OFFSET = 156;
const PREFIX_OFFSET = 345;

/** Member names of a gzipped tar, in archive order. */
export function tarballEntryNames(gzipBytes) {
  return tarEntryNames(gunzipSync(gzipBytes));
}

/** Member names of an uncompressed tar, in archive order. */
export function tarEntryNames(tarBytes) {
  const bytes = Buffer.isBuffer(tarBytes)
    ? tarBytes
    : Buffer.from(tarBytes.buffer, tarBytes.byteOffset, tarBytes.byteLength);
  const names = [];
  // Set by a GNU long-name record or a pax `path=` record for the member after it.
  let overrideName = null;
  let zeroBlocks = 0;

  for (let offset = 0; offset + BLOCK <= bytes.length;) {
    if (isZeroBlock(bytes, offset)) {
      if (++zeroBlocks === 2) break;
      offset += BLOCK;
      continue;
    }
    zeroBlocks = 0;

    const size = readSize(bytes, offset + SIZE_OFFSET);
    const typeflag = readTypeflag(bytes, offset + TYPEFLAG_OFFSET);
    const body = bytes.subarray(offset + BLOCK, offset + BLOCK + size);
    const name = readString(bytes, offset + NAME_OFFSET, 100);
    const prefix = readString(bytes, offset + PREFIX_OFFSET, 155);
    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;

    // `L` carries the next member's path, `K` its link target; `x`/`g` are pax
    // records, which can also rename the member after them.
    if (typeflag === "L") {
      overrideName = readCString(body);
      continue;
    }
    if (typeflag === "K") continue;
    if (typeflag === "x" || typeflag === "g") {
      overrideName = paxPath(body) ?? overrideName;
      continue;
    }

    names.push(overrideName || (prefix ? `${prefix}/${name}` : name));
    overrideName = null;
  }
  return names;
}

/**
 * Entries a packing host added that the package itself does not contain:
 * AppleDouble sidecars (`._name`, `__MACOSX/`) and Finder state (`.DS_Store`).
 *
 * npm never publishes these, and they are not inert to a scanner — a bare
 * `._package` member has no directory component, so `strip: 1` leaves it with
 * no path at all and the tar rules read it as a parser differential. A fixture
 * repacked with them carries findings the scenario never declared.
 */
export function hostMetadataTarEntries(names) {
  return names.filter((name) =>
    name
      .split("/")
      .filter(Boolean)
      .some(
        (segment) => segment.startsWith("._") || segment === ".DS_Store" || segment === "__MACOSX",
      ),
  );
}

function isZeroBlock(bytes, offset) {
  for (let index = offset; index < offset + BLOCK; index++) {
    if (bytes[index] !== 0) return false;
  }
  return true;
}

function readString(bytes, offset, length) {
  const field = bytes.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return field.toString("utf8", 0, end === -1 ? field.length : end).trim();
}

function readCString(body) {
  const end = body.indexOf(0);
  return body.toString("utf8", 0, end === -1 ? body.length : end).trim();
}

// pax records are `<length> <key>=<value>\n` runs.
function paxPath(body) {
  const match = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString("utf8"));
  return match ? match[1] : null;
}

function readTypeflag(bytes, offset) {
  const value = bytes[offset];
  // A regular file is `0`, but historic writers leave the field NUL.
  return !value || value === 0x30 ? "0" : String.fromCharCode(value);
}

// The size field is octal text, except for the base-256 form GNU and libarchive
// use past 8GB: high bit set on the first byte, big-endian magnitude after it.
function readSize(bytes, offset) {
  if (bytes[offset] & 0x80) {
    let value = bytes[offset] & 0x7f;
    for (let index = offset + 1; index < offset + 12; index++) value = value * 256 + bytes[index];
    return Number.isSafeInteger(value) && value > 0 ? value : 0;
  }
  const value = Number.parseInt(readString(bytes, offset, 12), 8);
  return Number.isFinite(value) && value > 0 ? value : 0;
}
