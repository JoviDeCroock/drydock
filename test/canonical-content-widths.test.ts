import { readdirSync, readFileSync, statSync } from "node:fs";
import { describe, expect, test } from "vitest";

// docs/design.md, "Canonical widths": public reading surfaces may only use the
// declared width set. A one-off cap on one block is invisible in isolation and
// reads as a ragged edge next to its neighbours, which is how the docs page
// accumulated a 560px CTA beside 680px prose inside an 880px column.
const CANONICAL = new Set([620, 680, 760, 880, 1160]);

// Components that size themselves rather than a column of content. SeverityBar
// has its own documented cap (docs/design.md, "Severity bar"), so its width is
// not a content width and does not belong to the canonical set.
const SELF_SIZING = new Set(["SeverityBar"]);

// Every surface that renders public long-form content on the marketing shell.
const SURFACES = [
  "src/pages/Docs",
  "src/pages/Landing",
  "src/pages/Privacy",
  "src/pages/Diff",
  "src/pages/Guides",
  "src/pages/Incidents",
  "src/pages/PublicReport",
  "src/features/public-content",
  "src/features/dependency-pr-integrations",
];

function sourceFiles(relativeDir: string): string[] {
  const root = new URL(`../${relativeDir}/`, import.meta.url);
  const walk = (dir: URL): string[] =>
    readdirSync(dir).flatMap((entry) => {
      const child = new URL(
        `${entry}${statSync(new URL(entry, dir)).isDirectory() ? "/" : ""}`,
        dir,
      );
      if (child.pathname.endsWith("/")) return walk(child);
      return child.pathname.endsWith(".tsx") ? [child.pathname] : [];
    });
  return walk(root);
}

const files = SURFACES.flatMap(sourceFiles);

describe("canonical content widths", () => {
  test("covers every public content surface", () => {
    expect(files.length).toBeGreaterThan(6);
  });

  test("public content surfaces only use declared pixel widths", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/max-w-\[(\d+)px\]/g)) {
        const width = Number(match[1]);
        if (CANONICAL.has(width)) continue;
        const openingTag = source.slice(0, match.index).match(/<([A-Za-z][\w.]*)[^<]*$/);
        if (openingTag && SELF_SIZING.has(openingTag[1])) continue;
        const line = source.slice(0, match.index).split("\n").length;
        // Slice from the last "/src/" so a checkout path that itself contains
        // one still labels the offender by its repo-relative path.
        const relative = file.slice(file.lastIndexOf("/src/") + 1);
        offenders.push(`${relative}:${line} max-w-[${width}px]`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
