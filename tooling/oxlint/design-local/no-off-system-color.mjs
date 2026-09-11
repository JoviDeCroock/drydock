/**
 * Keep every color on the `docs/design.md` token system.
 *
 * The palette in `src/style.css` is the whole color vocabulary: `--color-ink`,
 * `--color-accent`, the severity pairs, and their `-soft`/`-text` variants, each
 * with a light and a dark value. Three things bypass it and each has shipped or
 * nearly shipped by eye:
 *
 *   - A Tailwind default-palette utility (`text-red-500`, `bg-zinc-100`). It has
 *     no dark-mode value, and severity hues outside the token pairs break the
 *     "color = signal" rule.
 *   - A raw color in an arbitrary value or a `style` prop (`bg-[#fff]`,
 *     `shadow-[0_0_0_1px_rgba(0,0,0,.2)]`, `style={{ color: "#c2410c" }}`,
 *     `style={{ border: "1px solid #ccc" }}`). Same dark-mode problem, and the
 *     contrast work in design.md never sees it. Named CSS colors (`"red"`) are
 *     not recognized; nothing in the design uses them.
 *   - A saturated severity token as a text color (`text-warn`, `text-ok`). Those
 *     fail WCAG AA on white (3.8:1 and 3.0:1); design.md reserves them for shapes
 *     and provides `text-warn-text` / `text-ok-text` for text.
 *
 *   <span class="text-red-600">…</span>                    // flagged (palette)
 *   <div class="bg-[#fafafa]">…</div>                      // flagged (raw color)
 *   <div style={{ borderColor: "#e4e4e7" }}>…</div>        // flagged (raw color)
 *   <span class="text-warn">…</span>                       // flagged (use text-warn-text)
 *   <span class="text-warn-text bg-warn-soft">…</span>     // ok
 *   <div class="border-warn">…</div>                       // ok (shape)
 *   <div class="shadow-[0_0_0_3px_var(--color-accent-soft)]">…</div> // ok (token via var)
 *   <div class="bg-black/40 text-white">…</div>            // ok (structural, not palette)
 *
 * Scope and limitations: every static string literal and template quasi in
 * `src/` is scanned token by token, so class maps in plain objects
 * (`const tones = { warn: "text-warn-text" }`) are covered, not just `class=`.
 * Tokens assembled at runtime are not resolved. `white`/`black` are allowed:
 * the design uses them for overlays and white-on-accent, which design.md sizes
 * explicitly.
 */

import { classTokens, staticStrings, utilityWithoutVariants } from "./class-tokens.mjs";

const COLOR_UTILITY =
  "(?:text|bg|border(?:-[trblxyse])?|ring|ring-offset|inset-ring|outline|decoration|fill|stroke|from|via|to|accent|caret|divide|placeholder|shadow|inset-shadow)";
const PALETTE_HUE =
  "(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone)";

const PALETTE_UTILITY = new RegExp(`^${COLOR_UTILITY}-${PALETTE_HUE}-\\d{2,3}$`);
// Arbitrary values join parts with `_`, which is a word character, so a plain
// `\b` would miss `shadow-[0_0_0_1px_rgba(…)]`.
const RAW_COLOR_INSIDE =
  /#[0-9a-f]{3,8}(?![0-9a-f])|(?<![A-Za-z0-9-])(?:rgba?|hsla?|oklch|oklab|color)\(/i;
const RAW_COLOR_LITERAL = /^\s*(?:#[0-9a-f]{3,8}|(?:rgba?|hsla?|oklch|oklab|color)\([^)]*\))\s*$/i;
const SATURATED_SEVERITY_TEXT = /^text-(danger|warn|info|ok)$/;
// Object keys whose string value is CSS that can carry a color (camelCase or
// kebab-case): color, background, borderColor, boxShadow, fill, outline, …
const CSS_COLOR_PROPERTY =
  /color|background|border|shadow|fill|stroke|outline|caret|accent|decoration/i;

/** `bg-[#fff]`, `shadow-[0_0_0_1px_rgba(0,0,0,.2)]`: an arbitrary value carrying a raw color. */
function arbitraryRawColor(utility) {
  const open = utility.indexOf("[");
  if (open === -1 || !utility.endsWith("]")) return false;
  return RAW_COLOR_INSIDE.test(utility.slice(open + 1, -1));
}

/** Drop a trailing opacity modifier (`text-warn/50`). */
function withoutOpacity(utility) {
  return utility.replace(/\/\d{1,3}$/, "").replace(/\/\[[^\]]*\]$/, "");
}

/** @type {import("eslint").Rule.RuleModule} */
const rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Use docs/design.md color tokens: no Tailwind palette colors, raw color values, or saturated severity tokens as text",
      recommended: true,
    },
    messages: {
      palette:
        "`{{token}}` is a Tailwind default-palette color. It has no dark-mode value and sits outside the docs/design.md token system; use an ink, accent, or severity token from src/style.css.",
      rawColor:
        "`{{token}}` carries a raw color value. Colors come from the src/style.css tokens (a `bg-…`/`text-…` utility, or `var(--color-…)` inside an arbitrary value) so light and dark mode both resolve — see docs/design.md, “Color”.",
      rawLiteral:
        "Raw CSS color `{{token}}`. Use a token class or `var(--color-…)` so light and dark mode both resolve — see docs/design.md, “Color”.",
      saturatedText:
        "`{{token}}` is the saturated severity token, which fails WCAG AA as text on white. Use `{{token}}-text` for text; the saturated token is for shapes (borders, discs, chart segments) — see docs/design.md, “Severity”.",
    },
    schema: [],
  },

  create(context) {
    // A string that is the value of a color-carrying CSS property
    // (`style={{ color: … }}`, `const styles = { boxShadow: "0 0 0 1px #e4e4e7" }`)
    // is CSS, not a class list, so a color anywhere inside it is raw. Elsewhere
    // only a string that *is* a color counts: prose and hrefs legitimately
    // contain `#1234`.
    function isStyleValue(node) {
      const parent = node.parent;
      if (parent?.type !== "Property" || parent.value !== node) return false;
      const key = parent.key?.name ?? parent.key?.value;
      return typeof key === "string" && CSS_COLOR_PROPERTY.test(key);
    }

    function check(node) {
      for (const text of staticStrings(node)) {
        const raw =
          RAW_COLOR_LITERAL.test(text) || (isStyleValue(node) && RAW_COLOR_INSIDE.test(text));
        if (raw) {
          context.report({ node, messageId: "rawLiteral", data: { token: text.trim() } });
          continue;
        }
        for (const token of classTokens(text)) {
          const utility = withoutOpacity(utilityWithoutVariants(token));
          if (PALETTE_UTILITY.test(utility)) {
            context.report({ node, messageId: "palette", data: { token } });
          } else if (arbitraryRawColor(utility)) {
            context.report({ node, messageId: "rawColor", data: { token } });
          } else if (SATURATED_SEVERITY_TEXT.test(utility)) {
            context.report({ node, messageId: "saturatedText", data: { token: utility } });
          }
        }
      }
    }

    return { Literal: check, TemplateLiteral: check };
  },
};

export default rule;
