import { describe, expect, test } from "vitest";
import {
  ensureHighlighter,
  highlighterReady,
  langForPath,
  tokenizeLines,
} from "../src/components/highlight";

async function whenReady(): Promise<void> {
  ensureHighlighter();
  const start = Date.now();
  while (!highlighterReady.value) {
    if (Date.now() - start > 15000) throw new Error("highlighter did not load");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("langForPath", () => {
  test("maps the supported extensions", () => {
    expect(langForPath("pkg/script.py")).toBe("python");
    expect(langForPath("Component.jsx")).toBe("jsx");
    expect(langForPath("index.js")).toBe("jsx");
    expect(langForPath("a.mjs")).toBe("jsx");
    expect(langForPath("server/index.ts")).toBe("typescript");
    expect(langForPath("App.tsx")).toBe("tsx");
    expect(langForPath("package.json")).toBe("json");
    expect(langForPath("pyproject.toml")).toBe("toml");
  });

  test("returns undefined for unsupported, extension-less, and dotfile paths", () => {
    expect(langForPath("README.md")).toBeUndefined();
    expect(langForPath("LICENSE")).toBeUndefined();
    expect(langForPath(".gitignore")).toBeUndefined();
  });
});

describe("tokenizeLines", () => {
  test("returns null (never throws) for a language the bundle did not load", () => {
    // Unknown languages never reach this path (langForPath gates it), but the
    // guard must stay graceful if asked for something we didn't bundle.
    expect(tokenizeLines("x = 1", "ruby")).toBeNull();
  });

  test("yields one token line per source line, reconstructing each line exactly", async () => {
    await whenReady();
    const code = 'const x = "hi"  \n// comment\n  function f() {}';
    const lines = tokenizeLines(code, "typescript");
    expect(lines).not.toBeNull();
    const sourceLines = code.split("\n");
    expect(lines!.length).toBe(sourceLines.length);
    // This alignment is what lets DiffView index tokens by diff line number.
    sourceLines.forEach((source, index) => {
      expect(lines![index].map((token) => token.content).join("")).toBe(source);
    });
  });

  test("emits css-variable colors so the palette lives in CSS, not JS", async () => {
    await whenReady();
    const colors = tokenizeLines('const x = "hi"', "typescript")!
      .flat()
      .map((token) => token.color);
    expect(colors).toContain("var(--sh-token-keyword)");
    expect(colors).toContain("var(--sh-token-string-expression)");
  });
});
