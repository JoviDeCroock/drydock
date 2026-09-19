// Entry-name view of a packed fixture tarball, shared by the fixture builder
// and `test/e2e-fixture-tarballs.test.mjs`.
//
// The builder cannot ask `tar -t` what it just wrote: macOS tar folds
// AppleDouble `._name` members back into extended attributes when it reads an
// archive, so the metadata it adds on write is invisible in a listing taken on
// the same host. Reading the headers directly is what makes the check below
// mean anything.

import { gunzipSync } from "node:zlib";

const BLOCK = 512;
const NAME_OFFSET = 0;
const SIZE_OFFSET = 124;
const TYPEFLAG_OFFSET = 156;
const PREFIX_OFFSET = 345;
// Headers that describe the member after them rather than a packed file: pax
// extended/global headers and GNU's long-name/long-link records.
const METADATA_TYPEFLAGS = new Set(["x", "g", "L", "K"]);

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
  for (let offset = 0; offset + BLOCK <= bytes.length;) {
    const name = readString(bytes, offset + NAME_OFFSET, 100);
    // The archive ends at the first zero block; trailing padding is not a member.
    if (!name) break;
    const prefix = readString(bytes, offset + PREFIX_OFFSET, 155);
    const typeflag = readTypeflag(bytes, offset + TYPEFLAG_OFFSET);
    if (!METADATA_TYPEFLAGS.has(typeflag)) names.push(prefix ? `${prefix}/${name}` : name);
    offset += BLOCK + Math.ceil(readOctal(bytes, offset + SIZE_OFFSET, 12) / BLOCK) * BLOCK;
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

function readString(bytes, offset, length) {
  const field = bytes.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return field.toString("utf8", 0, end === -1 ? field.length : end).trim();
}

function readTypeflag(bytes, offset) {
  const value = bytes[offset];
  // A regular file is `0`, but historic writers leave the field NUL.
  return !value || value === 0x30 ? "0" : String.fromCharCode(value);
}

function readOctal(bytes, offset, length) {
  const text = readString(bytes, offset, length);
  const value = Number.parseInt(text, 8);
  return Number.isFinite(value) && value > 0 ? value : 0;
}
