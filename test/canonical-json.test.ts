import { describe, expect, test } from "vitest";
import { canonicalJson } from "../server/lib/platform/canonical-json";

describe("canonical JSON", () => {
  test("orders object keys by code point rather than host locale", () => {
    expect(canonicalJson({ é: 1, a: 2, _: 3, Z: 4 })).toBe('{"Z":4,"_":3,"a":2,"é":1}');
  });

  test("is stable recursively and omits undefined object properties", () => {
    expect(canonicalJson({ z: [{ b: 2, a: 1 }], missing: undefined, a: true })).toBe(
      '{"a":true,"z":[{"a":1,"b":2}]}',
    );
  });
});
