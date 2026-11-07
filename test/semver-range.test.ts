import { describe, expect, test } from "vitest";
import {
  maxSatisfyingVersion,
  parseSemverRange,
  satisfiesSemverRange,
} from "../server/lib/ecosystems/semver-range";

// Expected values were cross-checked against node-semver 7 (`satisfies` with
// `{ loose: true }`, which npm resolves dependency specs with).
const cases: Array<[range: string, accepted: string[], rejected: string[]]> = [
  ["", ["0.0.0", "1.2.3", "10.0.0"], ["1.2.3-beta.1"]],
  ["*", ["1.0.0"], ["2.0.0-rc.1"]],
  ["1", ["1.0.0", "1.9.9"], ["2.0.0", "0.9.0", "1.2.3-beta.1"]],
  ["1.2.x", ["1.2.0", "1.2.4"], ["1.3.0"]],
  ["1.2.3", ["1.2.3"], ["1.2.4", "1.2.3-beta.2"]],
  ["v1.2.3", ["1.2.3"], ["1.2.4"]],
  ["^1.2.3", ["1.2.3", "1.9.9"], ["2.0.0", "2.0.0-0", "1.2.2", "1.2.4-beta"]],
  ["^0.2.3", ["0.2.3", "0.2.9"], ["0.3.0"]],
  ["^0.0.3", ["0.0.3"], ["0.0.4"]],
  ["^0.0", ["0.0.0", "0.0.4"], ["0.1.0"]],
  [
    "^1.2.3-beta.2",
    ["1.2.3-beta.2", "1.2.3-beta.10", "1.2.3", "1.9.9"],
    ["1.2.3-beta.1", "1.2.4-beta"],
  ],
  ["~1.2.3", ["1.2.3", "1.2.9"], ["1.3.0"]],
  ["~1", ["1.0.0", "1.9.9"], ["2.0.0"]],
  ["~> 1.2", ["1.2.0", "1.2.4"], ["1.3.0"]],
  [">1.2", ["1.3.0", "2.0.0"], ["1.2.9"]],
  [">= 1.2.3", ["1.2.3", "10.0.0"], ["1.2.2"]],
  ["<1.2", ["1.1.9"], ["1.2.0", "1.2.0-0"]],
  ["<=1.2", ["1.2.9"], ["1.3.0"]],
  [">*", [], ["0.0.0", "1.0.0"]],
  ["1.2.3 - 2.3", ["1.2.3", "2.3.9"], ["2.4.0", "1.2.2"]],
  ["1.2 - 2.3.4", ["1.2.0", "2.3.4"], ["2.3.5"]],
  [">=1.2.3 <2", ["1.2.3", "1.9.9"], ["2.0.0"]],
  ["^1 || ^3", ["1.0.0", "3.0.0"], ["2.0.0"]],
  [">=2.0.0-rc.0", ["2.0.0-rc.0", "2.0.0-rc.1", "2.0.0", "3.0.0"], ["2.1.0-rc.1"]],
  ["^2.1.0-rc.0", ["2.1.0-rc.1", "2.1.0"], ["2.2.0-rc.1"]],
  // node-semver collapses a union containing "any" to "any", dropping the
  // sibling's prerelease opt-in.
  ["* || 2.0.0-rc.1", ["2.0.0"], ["2.0.0-rc.1"]],
  [">=0.0.0 || 2.0.0-rc.1", ["2.0.0"], ["2.0.0-rc.1"]],
  // Prerelease identifiers compare in ASCII order: uppercase sorts first.
  [">=1.0.0-beta", ["1.0.0-beta", "1.0.0-beta.1", "1.0.0-rc.1", "1.0.0"], ["1.0.0-RC.1"]],
  ["<1.0.0-alpha", ["1.0.0-Zeta", "1.0.0-1"], ["1.0.0-alpha", "1.0.0-beta"]],
];

describe("satisfiesSemverRange", () => {
  test.each(cases)("%j", (range, accepted, rejected) => {
    for (const version of accepted) expect(satisfiesSemverRange(version, range)).toBe(true);
    for (const version of rejected) expect(satisfiesSemverRange(version, range)).toBe(false);
  });

  test("refuses what is not a range, so a caller can treat it as a dist-tag or unknown", () => {
    for (const spec of ["latest", "next", "1.2.3.4", "^^1", ">=a", "1.x.3", "x".repeat(300)]) {
      expect(parseSemverRange(spec)).toBeNull();
    }
  });

  test("never matches a non-semver candidate", () => {
    expect(satisfiesSemverRange("not-a-version", "*")).toBe(false);
  });
});

describe("maxSatisfyingVersion", () => {
  test("picks the highest accepted version", () => {
    const range = parseSemverRange("^2.0.0")!;
    expect(maxSatisfyingVersion(["1.9.0", "2.0.0", "2.4.1", "3.0.0", "2.5.0-rc.1"], range)).toBe(
      "2.4.1",
    );
    expect(maxSatisfyingVersion(["1.0.0"], range)).toBeNull();
  });
});
