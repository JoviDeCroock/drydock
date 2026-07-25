import { describe, expect, test } from "vitest";
import {
  comparePyPiVersions,
  parsePyPiVersion,
  pyPiVersionsEquivalent,
} from "../server/lib/ecosystems/pypi/version";

describe("pyPiVersionsEquivalent", () => {
  test("treats PEP 440 spelling variants as the same version", () => {
    for (const [a, b] of [
      ["1.0-1", "1.0.post1"],
      ["0.5dev0", "0.5.dev0"],
      ["1.0alpha1", "1.0a1"],
      ["1.0-preview2", "1.0rc2"],
      ["1.0.0", "1.0"],
      ["v1.0", "1.0"],
      ["0!1.0", "1.0"],
      // Legacy setuptools release markers: "-final" is the release itself
      // (the CherryPy "2.0.0-final" release key vs its PKG-INFO "2.0.0").
      ["2.0.0-final", "2.0.0"],
      ["1.0_beta", "1.0-beta"],
    ]) {
      expect(pyPiVersionsEquivalent(a, b), `${a} ≡ ${b}`).toBe(true);
    }
  });

  test("keeps genuinely different versions distinct", () => {
    for (const [a, b] of [
      ["1.2.0", "1.3.0"],
      ["1!1.0", "1.0"],
      ["1.0", "1.0.post0"],
      ["1.0rc1", "1.0"],
      ["1.0+local", "1.0"],
      ["1.0.dev1", "1.0"],
    ]) {
      expect(pyPiVersionsEquivalent(a, b), `${a} ≢ ${b}`).toBe(false);
    }
  });
});

describe("comparePyPiVersions", () => {
  test("orders per PEP 440: dev < a < b < rc < release < post", () => {
    const ascending = ["1.0.dev1", "1.0a1", "1.0a2", "1.0b1", "1.0rc1", "1.0", "1.0.post1"];
    for (let i = 1; i < ascending.length; i++) {
      const [lower, higher] = [ascending[i - 1], ascending[i]];
      expect(comparePyPiVersions(lower, higher), `${lower} < ${higher}`).toBeLessThan(0);
    }
  });

  test("compares release segments numerically, not lexicographically", () => {
    expect(comparePyPiVersions("10.0", "9.0")).toBeGreaterThan(0);
    expect(comparePyPiVersions("2.0.0", "1.26.9")).toBeGreaterThan(0);
    expect(comparePyPiVersions("1.0", "1.0.0")).toBe(0);
    expect(comparePyPiVersions("2!1.0", "1!9.0")).toBeGreaterThan(0);
  });

  test("returns null for unparseable legacy versions", () => {
    expect(comparePyPiVersions("2004-06-18", "1.0")).toBeNull();
    expect(parsePyPiVersion("not a version")).toBeNull();
  });
});
