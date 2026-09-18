import { describe, expect, test } from "vitest";
import { canonicalJson } from "../server/lib/platform/canonical-json";

describe("canonical JSON", () => {
  test("orders object keys by UTF-16 code unit rather than host locale", () => {
    expect(canonicalJson({ é: 1, a: 2, _: 3, Z: 4 })).toBe('{"Z":4,"_":3,"a":2,"é":1}');
  });

  // RFC 8785 sorts by UTF-16 code unit, which differs from code-point order for
  // anything outside the BMP: a surrogate pair leads with 0xD800-0xDBFF and so
  // sorts below U+FF21, even though its code point is far above it. A publisher
  // controls the manifest keys that reach a digest, so pin the distinction the
  // BMP-only fixture above cannot see.
  test("sorts astral keys by surrogate value, not by code point", () => {
    expect(canonicalJson({ Ａ: 1, "😀": 2 })).toBe('{"😀":2,"Ａ":1}');
    expect([..."Ａ😀"].map((c) => c.codePointAt(0))).toEqual([0xff21, 0x1f600]);
  });

  test("is stable recursively and omits undefined object properties", () => {
    expect(canonicalJson({ z: [{ b: 2, a: 1 }], missing: undefined, a: true })).toBe(
      '{"a":true,"z":[{"a":1,"b":2}]}',
    );
  });
});
