import { initWasm, Resvg } from "@resvg/resvg-wasm";
// The wasm module is compiled by the runtime at module-resolution time and only
// instantiated on the first render, so importing it does not cost every request
// that never asks for a card.
// @ts-expect-error the wasm import has no type declaration
import resvgWasm from "@resvg/resvg-wasm/index_bg.wasm";
import { OG_CARD_WIDTH, OG_FONT_ASSETS, OG_FONT_SANS } from "./card";

// Fonts ship as static assets rather than bundled bytes: the Worker fetches
// them through the ASSETS binding once per isolate and keeps them in module
// scope. Bundling ~270KB of TTF into the Worker would tax every request path,
// including the scan pipeline, for a marketing surface.

class OgRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OgRenderError";
  }
}

let wasmReady: Promise<void> | null = null;
let fontsReady: Promise<Uint8Array[]> | null = null;

function ensureWasm(): Promise<void> {
  // initWasm() throws if called twice, so the promise itself is the latch.
  wasmReady ??= initWasm(resvgWasm as WebAssembly.Module);
  return wasmReady;
}

async function loadFonts(env: Cloudflare.Env, origin: string): Promise<Uint8Array[]> {
  const assets = env.ASSETS;
  if (!assets) throw new OgRenderError("assets binding unavailable");
  const buffers = await Promise.all(
    Object.values(OG_FONT_ASSETS).map(async (path) => {
      const response = await assets.fetch(new URL(path, origin));
      if (!response.ok) throw new OgRenderError(`font asset ${path} returned ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    }),
  );
  if (buffers.some((buffer) => buffer.byteLength === 0)) {
    throw new OgRenderError("font asset was empty");
  }
  return buffers;
}

function ensureFonts(env: Cloudflare.Env, origin: string): Promise<Uint8Array[]> {
  // A failed load must not poison the isolate for the lifetime of the Worker,
  // so only a resolved promise is memoized.
  fontsReady ??= loadFonts(env, origin).catch((err) => {
    fontsReady = null;
    throw err;
  });
  return fontsReady;
}

export async function renderSvgToPng(
  env: Cloudflare.Env,
  origin: string,
  svg: string,
): Promise<Uint8Array> {
  const [, fontBuffers] = await Promise.all([ensureWasm(), ensureFonts(env, origin)]);
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: OG_CARD_WIDTH },
    font: {
      fontBuffers,
      loadSystemFonts: false,
      defaultFontFamily: OG_FONT_SANS,
    },
  });
  return resvg.render().asPng();
}

// Test seam: the module-scope memos survive between tests in a reused isolate.
export function resetOgFontCacheForTests() {
  fontsReady = null;
}
