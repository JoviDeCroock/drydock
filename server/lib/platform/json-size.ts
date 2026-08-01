// Byte accounting for strings that are about to become JSON in a size-capped
// store (KV values cap at 25 MiB). Counted rather than encoded: the strings
// measured here are whole cache payloads (tens of MiB for a large release), and
// `TextEncoder.encode` would allocate a throwaway buffer that size on a Worker
// isolate that is already holding the parsed sides of a diff. Both functions are
// pinned to their standard-library equivalents by the "byte-length counters"
// block in `test/workers/public-diff-cache.test.ts`.

// Bytes the UTF-8 encoding of `value` occupies.
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && isLowSurrogate(value.charCodeAt(index + 1))) {
      // Surrogate pair: one 4-byte code point across two UTF-16 units.
      bytes += 4;
      index++;
    } else {
      // Includes an unpaired surrogate, which encodes as U+FFFD (3 bytes).
      bytes += 3;
    }
  }
  return bytes;
}

// JSON.stringify's short escapes; every other control character becomes \u00XX.
const JSON_SHORT_ESCAPES = new Set([0x08, 0x09, 0x0a, 0x0c, 0x0d]);

// Bytes `JSON.stringify(value)` would produce for a string, quotes included,
// without building the escaped copy. Sample costs are summed over every file in
// a payload, so materializing each escaped body just to measure it would double
// the transient allocation of the whole reduction pass.
export function jsonStringByteLength(value: string): number {
  let bytes = 2;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x20) bytes += JSON_SHORT_ESCAPES.has(code) ? 2 : 6;
    else if (code === 0x22 || code === 0x5c) bytes += 2;
    else if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && isLowSurrogate(value.charCodeAt(index + 1))) {
      bytes += 4;
      index++;
    } else if (code >= 0xd800 && code <= 0xdfff) {
      // Well-formed JSON.stringify escapes an unpaired surrogate as \udXXX.
      bytes += 6;
    } else bytes += 3;
  }
  return bytes;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
