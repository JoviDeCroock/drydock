import { signal } from "@preact/signals";
import type { HighlighterCore } from "shiki/core";

export interface Token {
  content: string;
  color?: string;
  className?: string;
}

export type TokenLine = Token[];

// Diff bytes are untrusted package contents. We only ever tokenize languages we
// explicitly bundle a grammar for; anything else falls back to plain text.
const EXT_TO_LANG: Record<string, string> = {
  py: "python",
  pyi: "python",
  js: "jsx",
  jsx: "jsx",
  mjs: "jsx",
  cjs: "jsx",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  json: "json",
  toml: "toml",
};

export function langForPath(path: string): string | undefined {
  const base = path.split("/").pop() ?? path;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return undefined;
  return EXT_TO_LANG[base.slice(dot + 1).toLowerCase()];
}

let highlighter: HighlighterCore | null = null;
let loading: Promise<void> | null = null;

// Flips to true once the highlighter finishes loading. Reading it inside a
// component subscribes that component to re-render and re-tokenize.
export const highlighterReady = signal(false);

const tokenClassByCssVariable: Record<string, string> = {
  "--sh-foreground": "sh-token-foreground",
  "--sh-token-keyword": "sh-token-keyword",
  "--sh-token-constant": "sh-token-constant",
  "--sh-token-number": "sh-token-number",
  "--sh-token-function": "sh-token-function",
  "--sh-token-parameter": "sh-token-parameter",
  "--sh-token-punctuation": "sh-token-punctuation",
  "--sh-token-comment": "sh-token-comment",
  "--sh-token-string": "sh-token-string",
  "--sh-token-string-expression": "sh-token-string-expression",
  "--sh-token-link": "sh-token-link",
};

function tokenClassName(color: string | undefined): string | undefined {
  const variableName = color?.match(/^var\((--sh-[a-z-]+)\)$/)?.[1];
  return variableName ? tokenClassByCssVariable[variableName] : undefined;
}

export function ensureHighlighter(): void {
  if (highlighter || loading) return;
  // Everything shiki — the core, the JavaScript regex engine (keeps us off the
  // WASM/Oniguruma path), and the grammars — is imported dynamically so the
  // whole payload code-splits out and only loads when a diff is actually shown.
  loading = (async () => {
    const [{ createCssVariablesTheme, createHighlighterCore }, { createJavaScriptRegexEngine }] =
      await Promise.all([import("shiki/core"), import("shiki/engine/javascript")]);
    // Token colors resolve to the `--sh-*` CSS variables declared in
    // src/style.css, so the palette lives with the rest of the design tokens.
    const theme = createCssVariablesTheme({ name: "css-variables", variablePrefix: "--sh-" });
    highlighter = await createHighlighterCore({
      themes: [theme],
      langs: [
        import("shiki/langs/python.mjs"),
        import("shiki/langs/jsx.mjs"),
        import("shiki/langs/typescript.mjs"),
        import("shiki/langs/tsx.mjs"),
        import("shiki/langs/json.mjs"),
        import("shiki/langs/toml.mjs"),
      ],
      engine: createJavaScriptRegexEngine({ forgiving: true }),
    });
    highlighterReady.value = true;
  })().catch(() => {
    // Highlighting is best-effort decoration; on failure we keep plain text.
    loading = null;
  });
}

// Returns one token array per line, aligned with `text.split("\n")`, or null
// when the highlighter isn't ready or the grammar can't tokenize the input.
export function tokenizeLines(text: string, lang: string): TokenLine[] | null {
  if (!highlighter) return null;
  try {
    const { tokens } = highlighter.codeToTokens(text, { lang, theme: "css-variables" });
    return tokens.map((line) =>
      line.map((token) => ({
        content: token.content,
        color: token.color,
        className: tokenClassName(token.color),
      })),
    );
  } catch {
    return null;
  }
}
