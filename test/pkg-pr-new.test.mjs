import { describe, expect, test } from "vitest";
import { diffRefLabel, isPkgPrNewUrl, parsePkgPrNewUrl } from "../src/lib/pkg-pr-new";

// The parser is the egress allowlist for pkg.pr.new preview tarballs: anything
// it accepts becomes a URL the Worker will fetch anonymously. Acceptance must
// therefore be an exact-shape match on the canonical host, and every rejection
// case here is a security boundary, not a UX nicety.

describe("parsePkgPrNewUrl", () => {
  test("parses the compact form", () => {
    expect(parsePkgPrNewUrl("https://pkg.pr.new/tinybench@a832a55")).toEqual({
      url: "https://pkg.pr.new/tinybench@a832a55",
      packageName: "tinybench",
      ref: "a832a55",
    });
  });

  test("parses the compact scoped form", () => {
    expect(parsePkgPrNewUrl("https://pkg.pr.new/@preact/signals@1234")).toEqual({
      url: "https://pkg.pr.new/@preact/signals@1234",
      packageName: "@preact/signals",
      ref: "1234",
    });
  });

  test("parses the owner/repo form", () => {
    expect(parsePkgPrNewUrl("https://pkg.pr.new/tinylibs/tinybench/tinybench@a832a55")).toEqual({
      url: "https://pkg.pr.new/tinylibs/tinybench/tinybench@a832a55",
      packageName: "tinybench",
      ref: "a832a55",
      owner: "tinylibs",
      repo: "tinybench",
    });
  });

  test("parses the owner/repo scoped form", () => {
    expect(
      parsePkgPrNewUrl("https://pkg.pr.new/preactjs/signals/@preact/signals-core@f00dcafe"),
    ).toEqual({
      url: "https://pkg.pr.new/preactjs/signals/@preact/signals-core@f00dcafe",
      packageName: "@preact/signals-core",
      ref: "f00dcafe",
      owner: "preactjs",
      repo: "signals",
    });
  });

  test("accepts a bare pkg.pr.new/ prefix without protocol", () => {
    expect(parsePkgPrNewUrl("pkg.pr.new/tinybench@a832a55")?.url).toBe(
      "https://pkg.pr.new/tinybench@a832a55",
    );
  });

  test("trims surrounding whitespace", () => {
    expect(parsePkgPrNewUrl("  https://pkg.pr.new/tinybench@a832a55  ")).not.toBeNull();
  });

  test("rejects other hosts, including lookalikes", () => {
    expect(parsePkgPrNewUrl("https://evil.example.com/tinybench@a832a55")).toBeNull();
    expect(parsePkgPrNewUrl("https://pkg.pr.new.evil.example.com/tinybench@a832a55")).toBeNull();
    expect(parsePkgPrNewUrl("https://evilpkg.pr.new/tinybench@a832a55")).toBeNull();
    expect(parsePkgPrNewUrl("https://evil.example.com/pkg.pr.new/tinybench@a832a55")).toBeNull();
  });

  test("rejects non-https, ports, and embedded credentials", () => {
    expect(parsePkgPrNewUrl("http://pkg.pr.new/tinybench@a832a55")).toBeNull();
    expect(parsePkgPrNewUrl("https://pkg.pr.new:8443/tinybench@a832a55")).toBeNull();
    expect(parsePkgPrNewUrl("https://user:pass@pkg.pr.new/tinybench@a832a55")).toBeNull();
  });

  test("rejects query strings and fragments", () => {
    expect(parsePkgPrNewUrl("https://pkg.pr.new/tinybench@a832a55?x=1")).toBeNull();
    expect(parsePkgPrNewUrl("https://pkg.pr.new/tinybench@a832a55#frag")).toBeNull();
  });

  test("rejects missing or malformed refs and names", () => {
    expect(parsePkgPrNewUrl("https://pkg.pr.new/tinybench")).toBeNull();
    expect(parsePkgPrNewUrl("https://pkg.pr.new/@a832a55")).toBeNull();
    expect(parsePkgPrNewUrl("https://pkg.pr.new/UPPER@a832a55")).toBeNull();
    expect(parsePkgPrNewUrl("https://pkg.pr.new/tinybench@")).toBeNull();
    expect(parsePkgPrNewUrl("https://pkg.pr.new/")).toBeNull();
    expect(parsePkgPrNewUrl("https://pkg.pr.new/a/b/c/d/e@f")).toBeNull();
  });

  test("normalizes dot segments and rejects percent-encoded slashes", () => {
    // WHATWG URL parsing resolves (percent-encoded) dot segments before the
    // shape check, so the canonical URL can never contain them.
    expect(parsePkgPrNewUrl("https://pkg.pr.new/%2e%2e/tinybench@a832a55")?.url).toBe(
      "https://pkg.pr.new/tinybench@a832a55",
    );
    expect(parsePkgPrNewUrl("https://pkg.pr.new/../tinybench@a832a55")?.url).toBe(
      "https://pkg.pr.new/tinybench@a832a55",
    );
    expect(parsePkgPrNewUrl("https://pkg.pr.new/a%2fb/repo/tinybench@a832a55")).toBeNull();
  });

  test("rejects oversized input", () => {
    expect(parsePkgPrNewUrl(`https://pkg.pr.new/tinybench@${"a".repeat(600)}`)).toBeNull();
  });
});

describe("diffRefLabel", () => {
  test("shortens preview URLs to pkg.pr.new@ref", () => {
    expect(diffRefLabel("https://pkg.pr.new/tinylibs/tinybench/tinybench@a832a55")).toBe(
      "pkg.pr.new@a832a55",
    );
  });

  test("passes registry versions through unchanged", () => {
    expect(diffRefLabel("1.2.3")).toBe("1.2.3");
  });
});

describe("isPkgPrNewUrl", () => {
  test("matches parse results", () => {
    expect(isPkgPrNewUrl("https://pkg.pr.new/tinybench@a832a55")).toBe(true);
    expect(isPkgPrNewUrl("1.2.3")).toBe(false);
  });
});
