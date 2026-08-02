import { describe, expect, it } from "vitest";
import {
  escapeXml,
  estimateTextWidth,
  fitText,
  renderOgCardSvg,
  sanitizeCardText,
  OG_CARD_HEIGHT,
  OG_CARD_WIDTH,
  type OgCardStats,
} from "../server/lib/public-diff/card";

const STATS: OgCardStats = {
  filesChanged: 12,
  added: 3,
  removed: 1,
  modified: 8,
  findingCount: 2,
  risk: "high",
};

describe("escapeXml", () => {
  it("escapes every character that can break out of a text node", () => {
    expect(escapeXml(`<a href="x">&'`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&apos;");
  });
});

describe("sanitizeCardText", () => {
  it("strips control characters and bidi overrides", () => {
    // A right-to-left override could render "evil-gnp.js" as "evil-sj.png" on a
    // card whose whole job is telling people what they are looking at.
    expect(sanitizeCardText("a\u0000b\u200bc\u202ed")).toBe("abcd");
  });

  it("leaves ordinary package names untouched", () => {
    expect(sanitizeCardText("@apollo/client")).toBe("@apollo/client");
  });
});

describe("fitText", () => {
  it("keeps the largest size that fits", () => {
    const fitted = fitText("tape", 1056, [72, 60, 48], false);
    expect(fitted.fontSize).toBe(72);
    expect(fitted.text).toBe("tape");
  });

  it("steps down before truncating", () => {
    const long = "@some-organization/a-fairly-long-package-name-here";
    const fitted = fitText(long, 1056, [72, 60, 48, 36], false);
    expect(fitted.fontSize).toBeLessThan(72);
    expect(fitted.text).toBe(long);
  });

  it("ellipsizes when even the smallest size overflows", () => {
    const fitted = fitText("x".repeat(400), 1056, [72, 36], false);
    expect(fitted.text.endsWith("…")).toBe(true);
    expect(estimateTextWidth(fitted.text, fitted.fontSize, false)).toBeLessThanOrEqual(1056);
  });

  it("never returns a line wider than the budget", () => {
    const names = [
      "a",
      "@scope/name",
      "@a-very-long-scope-indeed/and-an-equally-long-package-name",
      "WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW",
      "iiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiii",
      "x".repeat(214),
    ];
    for (const name of names) {
      const fitted = fitText(name, 1056, [72, 60, 52, 44, 36], false);
      expect(estimateTextWidth(fitted.text, fitted.fontSize, false)).toBeLessThanOrEqual(1056);
    }
  });
});

describe("renderOgCardSvg", () => {
  const base = {
    ecosystem: "npm" as const,
    packageName: "@apollo/client",
    fromVersion: "3.11.8",
    toVersion: "3.11.9",
  };

  it("renders the package and version pair at the standard card size", () => {
    const svg = renderOgCardSvg({ ...base, stats: STATS });
    expect(svg).toContain(`width="${OG_CARD_WIDTH}"`);
    expect(svg).toContain(`height="${OG_CARD_HEIGHT}"`);
    expect(svg).toContain("@apollo/client");
    expect(svg).toContain("3.11.8 → 3.11.9");
    expect(svg).toContain("NPM PACKAGE DIFF");
  });

  it("labels the ecosystem for PyPI", () => {
    const svg = renderOgCardSvg({ ...base, ecosystem: "pypi", packageName: "requests" });
    expect(svg).toContain("PYPI PACKAGE DIFF");
  });

  it("summarizes the release delta when stats are known", () => {
    const svg = renderOgCardSvg({ ...base, stats: STATS });
    expect(svg).toContain("FILES CHANGED");
    expect(svg).toContain(">12<");
    expect(svg).toContain("+3 ~8 -1");
    expect(svg).toContain("2 findings");
  });

  it("shows a clean release in the ok color, not a severity color", () => {
    const svg = renderOgCardSvg({
      ...base,
      stats: { ...STATS, findingCount: 0, risk: "low" },
    });
    expect(svg).toContain("none");
    expect(svg).toContain("#15803d");
    expect(svg).not.toContain("#dc2626");
  });

  it("colors the finding count by release risk", () => {
    const high = renderOgCardSvg({ ...base, stats: { ...STATS, risk: "high" } });
    const medium = renderOgCardSvg({ ...base, stats: { ...STATS, risk: "medium" } });
    expect(high).toContain("#dc2626");
    expect(medium).toContain("#b45309");
  });

  it("still names the package when no stats are cached", () => {
    const svg = renderOgCardSvg(base);
    expect(svg).toContain("@apollo/client");
    expect(svg).toContain("3.11.8 → 3.11.9");
    expect(svg).not.toContain("FILES CHANGED");
    expect(svg).toContain("deterministic supply-chain findings");
  });

  it("escapes package names that would otherwise inject markup", () => {
    // Registry names cannot contain these today; the card must not be the thing
    // that assumes so.
    const svg = renderOgCardSvg({
      ...base,
      packageName: `</text><script>x</script>`,
    });
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;");
  });

  it("produces a single well-formed svg root", () => {
    const svg = renderOgCardSvg({ ...base, stats: STATS });
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg.endsWith("</svg>")).toBe(true);
    expect(svg.match(/<svg/g)).toHaveLength(1);
  });
});
