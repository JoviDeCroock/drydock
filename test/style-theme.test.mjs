import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

// Guards the theming invariants from the 2026-06-10 design-review pass. The
// light-mode bug these protect against was invisible in normal development
// (the site renders fine in dark mode), so it needs a source-level guard.
const css = readFileSync(fileURLToPath(new URL("../src/style.css", import.meta.url)), "utf8");
const loading = readFileSync(
  fileURLToPath(new URL("../src/components/Loading.tsx", import.meta.url)),
  "utf8",
);

/** Return the body of the first `@media (prefers-color-scheme: dark)` block. */
function darkMediaBlock(source) {
  const marker = source.match(/@media[^{]*prefers-color-scheme:\s*dark[^{]*\{/);
  if (!marker) return null;
  let depth = 0;
  const start = marker.index + marker[0].length;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      if (depth === 0) return source.slice(start, i);
      depth--;
    }
  }
  return null;
}

/** WCAG relative luminance for a #rrggbb string. */
function luminance(hex) {
  const channels = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function tokenInBlock(block, name) {
  const match = block.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`));
  return match ? match[1] : null;
}

describe("theme tokens", () => {
  const dark = darkMediaBlock(css);

  test("dark tokens are NOT inside a nested @theme", () => {
    // Tailwind v4 hoists every `@theme` to one unconditional top-level `:root`
    // and drops the surrounding @media. A dark `@theme` therefore overrides the
    // light default for everyone and strands the site in dark mode.
    expect(dark).not.toContain("@theme");
  });

  test("light and dark define distinct --color-bg (both modes reachable)", () => {
    // Light value lives in the top-level @theme; dark value lives in the media block.
    const lightBg = css.match(/--color-bg:\s*(#[0-9a-fA-F]{6})/)?.[1];
    const darkBg = tokenInBlock(dark, "--color-bg");
    expect(lightBg?.toLowerCase()).toBe("#fafaf9");
    expect(darkBg?.toLowerCase()).toBe("#0a0a0a");
  });

  test("dark --color-ink-subtle passes WCAG AA on every dark surface", () => {
    const subtle = tokenInBlock(dark, "--color-ink-subtle");
    const surfaces = ["--color-bg", "--color-surface", "--color-surface-2"]
      .map((name) => tokenInBlock(dark, name))
      .filter(Boolean);
    expect(subtle).toBeTruthy();
    expect(surfaces.length).toBe(3);
    for (const surface of surfaces) {
      // 4.5:1 is the AA floor for the 11px mono labels / detail line.
      expect(contrast(subtle, surface)).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("loading progress animation", () => {
  test("the indeterminate bar always uses the left-to-right sweep", () => {
    expect(loading).toContain("animate-progress-sweep");
    expect(loading).not.toContain("motion-safe:animate-progress-sweep");
    expect(css).toContain("--animate-progress-sweep");
    expect(css).toMatch(/@keyframes\s+progress-sweep/);
  });
});
