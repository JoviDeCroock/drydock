// @ts-nocheck
import { describe, expect, test } from "vitest";
import {
  MAX_SEMVER_COMPARATORS_PER_BRANCH,
  MAX_SEMVER_COMPARATORS_TOTAL,
  MAX_SEMVER_RANGE_BRANCHES,
  MAX_SEMVER_RANGE_LENGTH,
  maxSatisfyingVersion,
  parseRange,
  satisfies,
} from "../server/lib/ecosystems/npm/semver";
import { parseSemver } from "../server/lib/ecosystems/npm/semver";

function matches(version, spec) {
  const range = parseRange(spec);
  const parsed = parseSemver(version);
  if (!range || !parsed) return null;
  return satisfies(parsed, range);
}

describe("npm range satisfaction", () => {
  test("caret ranges follow npm's leading-zero rules", () => {
    expect(matches("1.4.2", "^1.2.0")).toBe(true);
    expect(matches("2.0.0", "^1.2.0")).toBe(false);
    // ^0.2.3 admits 0.2.x only; ^0.0.3 admits 0.0.3 only.
    expect(matches("0.2.9", "^0.2.3")).toBe(true);
    expect(matches("0.3.0", "^0.2.3")).toBe(false);
    expect(matches("0.0.4", "^0.0.3")).toBe(false);
  });

  test("tilde ranges pin the minor when one is given", () => {
    expect(matches("1.2.9", "~1.2.3")).toBe(true);
    expect(matches("1.3.0", "~1.2.3")).toBe(false);
    expect(matches("1.9.0", "~1")).toBe(true);
    expect(matches("2.0.0", "~1")).toBe(false);
  });

  test("partial and wildcard versions expand to the range npm means", () => {
    expect(matches("1.2.9", "1.2")).toBe(true);
    expect(matches("1.3.0", "1.2")).toBe(false);
    expect(matches("1.9.9", "1.x")).toBe(true);
    expect(matches("2.0.0", "1.x")).toBe(false);
    expect(matches("9.9.9", "*")).toBe(true);
    expect(parseRange("1.x.2")).toBeNull();
    expect(parseRange("<1.x.2")).toBeNull();
    expect(matches("1.4.0", "^1.x.2")).toBe(true);
    expect(matches("2.0.0", "^1.x.2")).toBe(false);
    expect(matches("1.2.0", "1.2.x-beta")).toBe(true);
    expect(matches("1.2.0-beta", "1.2.x-beta")).toBe(false);
    expect(parseRange("1.2-beta")).toBeNull();
    expect(maxSatisfyingVersion(["1.1.3", "1.2.0-a", "1.2.0-beta"], "1.2.x-beta")).toBeNull();
    expect(maxSatisfyingVersion(["1.1.3", "1.2.0-a", "1.2.0-beta"], "<1.2.x-beta")).toBe("1.1.3");
  });

  test("strict major wildcards match nothing while inclusive ones match anything", () => {
    expect(matches("9.9.9", ">x")).toBe(false);
    expect(matches("9.9.9", "<*")).toBe(false);
    expect(matches("9.9.9", ">=x")).toBe(true);
    expect(matches("9.9.9", "<=*")).toBe(true);
  });

  test("comparator sets intersect and unions branch", () => {
    expect(matches("2.5.0", ">=2.0.0 <3.0.0")).toBe(true);
    expect(matches("3.0.0", ">=2.0.0 <3.0.0")).toBe(false);
    expect(matches("3.1.0", "^1.0.0 || ^3.0.0")).toBe(true);
    expect(matches("2.0.0", "^1.0.0 || ^3.0.0")).toBe(false);
  });

  test("accepts npm comparator whitespace", () => {
    expect(matches("1.2.3", ">= 1.2.3")).toBe(true);
    expect(matches("2.0.0", "^ 1.2.3")).toBe(false);
    expect(matches("1.2.3", "= 1.2.3")).toBe(true);
    expect(matches("1.9.0", ">= 1.2.3 < 2.0.0")).toBe(true);
  });

  test("hyphen ranges include partial upper bounds", () => {
    expect(matches("2.3.4", "1.2.3 - 2.3.4")).toBe(true);
    expect(matches("2.3.5", "1.2.3 - 2.3.4")).toBe(false);
    expect(matches("2.9.9", "1.2.3 - 2")).toBe(true);
    expect(matches("3.0.0", "1.2.3 - 2")).toBe(false);
  });

  test("a prerelease only satisfies a range that names one on the same tuple", () => {
    // Without this rule `^1.0.0` would resolve to an unreleased 2.0.0-rc.1 and
    // the review would report a version no consumer would ever install.
    expect(matches("2.0.0-rc.1", "^1.0.0")).toBe(false);
    expect(matches("1.5.0-rc.1", "^1.0.0")).toBe(false);
    expect(matches("1.5.0-rc.2", ">=1.5.0-rc.1 <2.0.0")).toBe(true);
  });

  test("specs the parser cannot represent are unresolvable, not unmatched", () => {
    // Returning an empty range here would silently mean "matches nothing",
    // which reads as a clean dependency. Null makes the caller record a gap.
    expect(parseRange("github:owner/repo")).toBeNull();
    expect(parseRange("workspace:*")).toBeNull();
    expect(parseRange("latest")).toBeNull();
  });

  test("rejects numeric identifiers npm SemVer does not accept", () => {
    expect(parseRange("^01.2.3")).toBeNull();
    expect(parseRange(">=9007199254740992.0.0")).toBeNull();
    expect(parseRange("1.0.0-alpha.01")).toBeNull();
    expect(parseRange("1.0.0-9007199254740992")).toBeNull();
    expect(parseRange("1.2.3 - 9007199254740992")).toBeNull();
  });

  test("bounds package-controlled range structure before synchronous matching", () => {
    const allowedBranches = Array.from(
      { length: MAX_SEMVER_RANGE_BRANCHES },
      (_, index) => `1.0.${index}`,
    ).join(" || ");
    expect(parseRange(allowedBranches)).not.toBeNull();
    expect(
      parseRange(Array.from({ length: MAX_SEMVER_RANGE_BRANCHES + 1 }, () => "1.0.0").join(" || ")),
    ).toBeNull();
    expect(
      parseRange(
        Array.from({ length: MAX_SEMVER_COMPARATORS_PER_BRANCH + 1 }, () => ">=1.0.0").join(" "),
      ),
    ).toBeNull();
    const comparatorHeavyBranches = [
      Array.from({ length: MAX_SEMVER_COMPARATORS_TOTAL / 2 }, () => "^1.0.0").join(" "),
      "^1.0.0",
    ].join(" || ");
    expect(parseRange(comparatorHeavyBranches)).toBeNull();
    expect(parseRange(`1.0.0${" ".repeat(MAX_SEMVER_RANGE_LENGTH)}`)).toBeNull();
  });
});

describe("maxSatisfyingVersion", () => {
  const published = ["1.0.0", "1.2.0", "1.4.7", "2.0.0", "2.1.0-beta.1"];

  test("picks the highest published version the range admits", () => {
    expect(maxSatisfyingVersion(published, "^1.0.0")).toBe("1.4.7");
    expect(maxSatisfyingVersion(published, ">=1.2.0")).toBe("2.0.0");
    expect(maxSatisfyingVersion(published, "1.0.0")).toBe("1.0.0");
  });

  test("returns null when nothing satisfies or the spec is not a range", () => {
    expect(maxSatisfyingVersion(published, "^9.0.0")).toBeNull();
    expect(maxSatisfyingVersion(published, "file:../local")).toBeNull();
    expect(maxSatisfyingVersion([], "^1.0.0")).toBeNull();
  });

  test("ignores unparseable published version keys", () => {
    expect(maxSatisfyingVersion(["1.0.0", "not-a-version"], "*")).toBe("1.0.0");
  });

  test("ignores non-canonical and unsafe published version keys", () => {
    expect(
      maxSatisfyingVersion(["01.2.3", "9007199254740992.0.0", "1.2.3-alpha.01", "1.2.3"], "*"),
    ).toBe("1.2.3");
    expect(parseSemver("01.2.3")).toBeNull();
    expect(parseSemver("9007199254740992.0.0")).toBeNull();
    expect(parseSemver("1.2.3-9007199254740992")).toBeNull();
  });

  test("orders non-numeric prerelease identifiers by ASCII code point", () => {
    expect(maxSatisfyingVersion(["1.0.0-A", "1.0.0-a"], ">=1.0.0-0 <1.0.0")).toBe("1.0.0-a");
  });
});
