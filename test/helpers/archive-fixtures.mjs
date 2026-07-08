// @ts-nocheck
// Minimal tar/zip writers shared by the archive-parser specs.
//
// These produce just enough of the POSIX/ustar and ZIP container formats for
// `readTar` / `readZipArchive` to parse them. They are intentionally lenient
// (no checksum, no data-descriptor support) — the parser under test doesn't
// require those fields, and keeping the writers minimal makes the fixtures
// readable. Used by tar-parser.test.mjs, zip-parser.test.mjs, and the
// property/fuzz suite, so the round-trip and adversarial tests build archives
// the exact same way the regression tests do.

import { deflateRawSync } from "node:zlib";

export const encoder = new TextEncoder();

// --- tar -------------------------------------------------------------------

// Each header is exactly 512 bytes; entry bodies are zero-padded to a multiple
// of 512. The archive is terminated with two zero blocks.
export const TAR_BLOCK = 512;

function pad(bytes, length) {
  if (bytes.length > length) throw new Error("field overflow: " + bytes.length + " > " + length);
  const out = new Uint8Array(length);
  out.set(bytes, 0);
  return out;
}

function octal(value, length) {
  const text = value.toString(8).padStart(length - 1, "0");
  return pad(encoder.encode(text + "\0"), length);
}

export function tarHeader({ name = "", size = 0, type = "0", prefix = "" }) {
  const buf = new Uint8Array(TAR_BLOCK);
  buf.set(pad(encoder.encode(name), 100), 0);
  buf.set(pad(encoder.encode("0000644"), 8), 100); // mode
  buf.set(pad(encoder.encode("0000000"), 8), 108); // uid
  buf.set(pad(encoder.encode("0000000"), 8), 116); // gid
  buf.set(octal(size, 12), 124);
  buf.set(pad(encoder.encode("00000000000"), 12), 136); // mtime
  // checksum placeholder (8 spaces) — readTar doesn't validate it
  buf.set(pad(encoder.encode("        "), 8), 148);
  buf[156] = type.charCodeAt(0);
  buf.set(pad(encoder.encode(""), 100), 157); // linkname
  buf.set(pad(encoder.encode("ustar"), 6), 257);
  buf.set(pad(encoder.encode("00"), 2), 263);
  buf.set(pad(encoder.encode(prefix), 155), 345);
  return buf;
}

function tarBody(content) {
  const bytes = content instanceof Uint8Array ? content : encoder.encode(content);
  const padded = Math.ceil(bytes.length / TAR_BLOCK) * TAR_BLOCK;
  const out = new Uint8Array(padded);
  out.set(bytes, 0);
  return out;
}

export function buildTar(entries) {
  const parts = [];
  for (const entry of entries) {
    const data = entry.body ?? "";
    const bytes = data instanceof Uint8Array ? data : encoder.encode(data);
    parts.push(tarHeader({ ...entry, size: bytes.length }));
    parts.push(tarBody(bytes));
  }
  parts.push(new Uint8Array(TAR_BLOCK * 2)); // end-of-archive
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

// --- zip -------------------------------------------------------------------

function u16(view, offset, value) {
  view.setUint16(offset, value, true);
}

function u32(view, offset, value) {
  view.setUint32(offset, value, true);
}

function concat(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function zipEntry(entry, localOffset) {
  const name = encoder.encode(entry.path);
  const body = entry.body instanceof Uint8Array ? entry.body : encoder.encode(entry.body ?? "");
  // `rawDeflate` supplies a hand-crafted deflate payload for `body` (e.g. one
  // padded with empty stored blocks) so adversarial compressed-vs-declared-size
  // shapes can be built; sizes/method fields still describe `body`.
  const compressed = entry.rawDeflate
    ? entry.rawDeflate
    : entry.deflate
      ? new Uint8Array(deflateRawSync(body))
      : body;
  const method = entry.rawDeflate || entry.deflate ? 8 : 0;

  // `dataDescriptor` mimics yazl-style streamed entries (vsce/VSIX): general
  // purpose bit 3 set, zeroed sizes in the local header, and a signed data
  // descriptor after the entry data. The central directory still carries the
  // real sizes, as in real archives.
  const descriptor = entry.dataDescriptor ? new Uint8Array(16) : new Uint8Array(0);
  if (entry.dataDescriptor) {
    const descriptorView = new DataView(descriptor.buffer);
    u32(descriptorView, 0, 0x08074b50);
    u32(descriptorView, 4, 0); // crc (unchecked by the parser, as in buildZip)
    u32(descriptorView, 8, compressed.length);
    u32(descriptorView, 12, body.length);
  }

  const local = new Uint8Array(30 + name.length + compressed.length + descriptor.length);
  const localView = new DataView(local.buffer);
  u32(localView, 0, 0x04034b50);
  u16(localView, 4, 20);
  u16(localView, 6, entry.dataDescriptor ? 0x0808 : 0x0800);
  u16(localView, 8, method);
  u32(localView, 14, 0);
  u32(localView, 18, entry.dataDescriptor ? 0 : compressed.length);
  u32(localView, 22, entry.dataDescriptor ? 0 : body.length);
  u16(localView, 26, name.length);
  local.set(name, 30);
  local.set(compressed, 30 + name.length);
  local.set(descriptor, 30 + name.length + compressed.length);

  const central = new Uint8Array(46 + name.length);
  const centralView = new DataView(central.buffer);
  u32(centralView, 0, 0x02014b50);
  u16(centralView, 4, 20);
  u16(centralView, 6, 20);
  u16(centralView, 8, 0x0800);
  u16(centralView, 10, method);
  u32(centralView, 16, 0);
  u32(centralView, 20, compressed.length);
  u32(centralView, 24, body.length);
  u16(centralView, 28, name.length);
  u32(centralView, 42, localOffset);
  central.set(name, 46);

  return { local, central };
}

export function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let localOffset = 0;
  for (const entry of entries) {
    const built = zipEntry(entry, localOffset);
    locals.push(built.local);
    centrals.push(built.central);
    localOffset += built.local.length;
  }
  const centralDirectory = concat(centrals);
  const eocd = new Uint8Array(22);
  const view = new DataView(eocd.buffer);
  u32(view, 0, 0x06054b50);
  u16(view, 8, entries.length);
  u16(view, 10, entries.length);
  u32(view, 12, centralDirectory.length);
  u32(view, 16, localOffset);
  return concat([...locals, centralDirectory, eocd]);
}
