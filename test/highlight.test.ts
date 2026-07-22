import { describe, expect, test } from "vitest";
import {
  canHighlight,
  ensureHighlighter,
  HIGHLIGHT_MAX_CHARS,
  HIGHLIGHT_MAX_LINES,
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
    expect(langForPath("Dockerfile")).toBe("docker");
    expect(langForPath("pkg/script.py")).toBe("python");
    expect(langForPath("Component.jsx")).toBe("jsx");
    expect(langForPath("index.js")).toBe("javascript");
    expect(langForPath("a.mjs")).toBe("javascript");
    expect(langForPath("common.cjs")).toBe("javascript");
    expect(langForPath("server/index.ts")).toBe("typescript");
    expect(langForPath("App.tsx")).toBe("tsx");
    expect(langForPath("package.json")).toBe("json");
    expect(langForPath("pyproject.toml")).toBe("toml");
    expect(langForPath("README.md")).toBe("markdown");
    expect(langForPath("pnpm-lock.yaml")).toBe("yaml");
    expect(langForPath("scripts/postinstall.sh")).toBe("bash");
    expect(langForPath("src/App.vue")).toBe("vue");
  });

  test("returns undefined for unsupported, extension-less, and dotfile paths", () => {
    expect(langForPath("LICENSE")).toBeUndefined();
    expect(langForPath(".gitignore")).toBeUndefined();
  });
});

describe("canHighlight", () => {
  test("caps synchronous tokenization by line count", () => {
    // Tokenizing costs ~0.6ms per line of bundled JS on the main thread; a
    // 36k-line sample would freeze the tab for ~25s (issue observed on vite's
    // dist/node/chunks/node.js).
    expect(canHighlight("x\n".repeat(HIGHLIGHT_MAX_LINES - 1))).toBe(true);
    // repeat(N) yields N newlines → N+1 lines, one over the cap.
    expect(canHighlight("x\n".repeat(HIGHLIGHT_MAX_LINES))).toBe(false);
    expect(canHighlight("")).toBe(true);
  });

  test("still rejects few-enormous-lines samples the line cap would miss", () => {
    // A minified one-liner is "1 line" but tokenizes in ~0.9s per 512 KiB, so
    // total size stays bounded independently of line count.
    expect(canHighlight("x".repeat(HIGHLIGHT_MAX_CHARS))).toBe(true);
    expect(canHighlight("x".repeat(HIGHLIGHT_MAX_CHARS + 1))).toBe(false);
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
