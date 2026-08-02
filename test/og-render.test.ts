import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import {
  renderOgCardSvg,
  OG_CARD_HEIGHT,
  OG_CARD_WIDTH,
  OG_FONT_ASSETS,
} from "../server/lib/public-diff/card";

// Rasterization coverage for the share card. The Worker route composes the same
// SVG and hands it to the same renderer, but wasm + font loading is the part
// that silently degrades (missing glyphs render as blanks, not errors), so it is
// exercised against the real font files that ship in public/.
//
// Runs in the node project rather than the workers pool because the workers pool
// virtualizes the filesystem and cannot read public/ directly.

const require = createRequire(import.meta.url);

let fontBuffers: Uint8Array[];

async function renderPng(svg: string) {
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: OG_CARD_WIDTH },
    font: { fontBuffers, loadSystemFonts: false, defaultFontFamily: "Geist" },
  });
  return resvg.render();
}

beforeAll(async () => {
  // Resolve via package.json: resolving the .wasm specifier directly makes the
  // module runner try to instantiate it as an ES module and fail on wasm-bindgen's
  // "wbg" import namespace.
  const packageRoot = path.dirname(require.resolve("@resvg/resvg-wasm"));
  await initWasm(await readFile(path.join(packageRoot, "index_bg.wasm")));
  fontBuffers = await Promise.all(
    Object.values(OG_FONT_ASSETS).map(
      async (assetPath) => new Uint8Array(await readFile(`public${assetPath}`)),
    ),
  );
});

describe("og card rasterization", () => {
  it("ships the fonts the renderer asks for", () => {
    for (const buffer of fontBuffers) expect(buffer.byteLength).toBeGreaterThan(1000);
  });

  it("renders a real PNG at the declared card size", async () => {
    const rendered = await renderPng(
      renderOgCardSvg({
        ecosystem: "npm",
        packageName: "@apollo/client",
        fromVersion: "3.11.8",
        toVersion: "3.11.9",
        stats: {
          filesChanged: 12,
          added: 3,
          removed: 1,
          modified: 8,
          findingCount: 2,
          risk: "high",
        },
      }),
    );
    expect(rendered.width).toBe(OG_CARD_WIDTH);
    expect(rendered.height).toBe(OG_CARD_HEIGHT);
    const png = rendered.asPng();
    expect(Array.from(png.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
    // A card that rendered no text at all still encodes to a valid but tiny
    // PNG, so size is the cheap proxy for "glyphs actually landed".
    expect(png.byteLength).toBeGreaterThan(10_000);
  });

  it("renders text-bearing cards larger than an empty background", async () => {
    const withText = await renderPng(
      renderOgCardSvg({
        ecosystem: "npm",
        packageName: "@apollo/client",
        fromVersion: "3.11.8",
        toVersion: "3.11.9",
      }),
    );
    const blank = await renderPng(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${OG_CARD_WIDTH}" height="${OG_CARD_HEIGHT}"><rect width="${OG_CARD_WIDTH}" height="${OG_CARD_HEIGHT}" fill="#fafaf9"/></svg>`,
    );
    expect(withText.asPng().byteLength).toBeGreaterThan(blank.asPng().byteLength * 2);
  });

  it("renders the arrow separator rather than dropping it", async () => {
    // The version pair reads "1.0.0 → 1.0.1"; if Geist Mono lacked U+2192 the
    // card would silently lose the only glyph that says which way the diff goes.
    const withArrow = await renderPng(
      `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="120"><rect width="400" height="120" fill="#ffffff"/><text x="10" y="70" font-family="Geist Mono" font-size="40" fill="#18181b">→</text></svg>`,
    );
    const withoutArrow = await renderPng(
      `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="120"><rect width="400" height="120" fill="#ffffff"/></svg>`,
    );
    expect(withArrow.asPng().byteLength).toBeGreaterThan(withoutArrow.asPng().byteLength);
  });

  it("rasterizes a hostile package name without failing", async () => {
    const rendered = await renderPng(
      renderOgCardSvg({
        ecosystem: "npm",
        packageName: `<script>alert(1)</script>&"'`,
        fromVersion: "0.0.1",
        toVersion: "0.0.2",
      }),
    );
    expect(rendered.width).toBe(OG_CARD_WIDTH);
  });
});
