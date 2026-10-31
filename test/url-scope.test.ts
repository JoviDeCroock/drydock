import { describe, expect, test } from "vitest";
import { pathWithinBaseUrl } from "../server/lib/platform/url-scope";

const within = (url: string, base: string) => pathWithinBaseUrl(new URL(url), new URL(base));

describe("pathWithinBaseUrl", () => {
  test("a base at the origin root owns every path on its origin", () => {
    expect(
      within("https://registry.npmjs.org/-/stage/x/tarball", "https://registry.npmjs.org"),
    ).toBe("/-/stage/x/tarball");
    expect(within("https://registry.npmjs.org/pkg", "https://registry.npmjs.org/")).toBe("/pkg");
  });

  test("a base under a path owns only that subtree, with or without a trailing slash", () => {
    for (const base of ["https://host.test/npm", "https://host.test/npm/"]) {
      expect(within("https://host.test/npm/-/stage/x/tarball", base)).toBe("/-/stage/x/tarball");
      expect(within("https://host.test/npm", base)).toBeNull();
      expect(within("https://host.test/npm-evil/pkg", base)).toBeNull();
      expect(within("https://host.test/other/pkg", base)).toBeNull();
      expect(within("https://host.test/pkg", base)).toBeNull();
    }
  });

  test("dot segments are resolved by the parser before the check, encoded or not", () => {
    expect(within("https://host.test/npm/../pkg", "https://host.test/npm")).toBeNull();
    expect(within("https://host.test/npm/%2e%2e/pkg", "https://host.test/npm")).toBeNull();
    expect(within("https://host.test/npm/a/../pkg", "https://host.test/npm")).toBe("/pkg");
  });

  test("another scheme, host, or port is outside the base", () => {
    for (const url of [
      "http://host.test/npm/pkg",
      "https://other.test/npm/pkg",
      "https://host.test:8443/npm/pkg",
    ]) {
      expect(within(url, "https://host.test/npm")).toBeNull();
    }
  });
});
