import { describe, expect, test } from "vitest";
import { highestSatisfying, parseVersionSpec } from "../server/lib/review/dependency-specs";

describe("dependency review version resolution", () => {
  test.each([
    ["1.2.3", { kind: "exact", version: "1.2.3" }],
    ["^1.2.0", { kind: "range", spec: "^1.2.0" }],
    [">=1 <3 || 5.x", { kind: "range", spec: ">=1 <3 || 5.x" }],
    ["next", { kind: "dist-tag", tag: "next" }],
    ["*", { kind: "dist-tag", tag: "latest" }],
    ["", { kind: "dist-tag", tag: "latest" }],
  ])("classifies %j", (spec, expected) => {
    expect(parseVersionSpec(spec)).toEqual(expected);
  });

  test.each([
    "npm:other@1.0.0",
    "git+https://example.invalid/repo.git",
    "file:../dep",
    "workspace:*",
  ])("keeps %s unresolvable", (spec) => expect(parseVersionSpec(spec).kind).toBe("unresolvable"));

  test("selects the highest satisfying stable version", () => {
    expect(highestSatisfying(["1.2.0", "1.9.0", "2.0.0", "1.10.0"], "^1.2.0")).toBe("1.10.0");
  });

  test("admits prereleases only when the range names the same prerelease triple", () => {
    const versions = ["1.2.3-beta.1", "1.2.3-beta.2", "1.2.2"];
    expect(highestSatisfying(versions, ">=1.2.3-beta.1 <1.2.3")).toBe("1.2.3-beta.2");
    expect(highestSatisfying(versions, "^1.2.0")).toBe("1.2.2");
  });
});
