/**
 * Keep small text on the `docs/design.md` size scale.
 *
 * The system has three small sizes with fixed roles: 10px is scanning-only
 * glyphs and structural metadata, 11px is the floor for anything the user reads
 * as a label, 12px is compact helper copy. Below 11px, 10px is the only size
 * with a role. Anything else under 11px — `text-[9px]`, or a `text-[10.5px]`
 * that sits between the two roles — is how off-scale text appears: it looks
 * fine in a dense row on a retina display and fails the reader on everything
 * else.
 *
 *   <span class="text-[9px]">…</span>      // flagged
 *   <span class="text-[10.5px]">…</span>   // flagged (between the 10px and 11px roles)
 *   <span class="text-[0.75rem]">…</span>  // flagged (10.5px)
 *   <span class="text-[9px]/3">…</span>    // flagged (line-height shorthand)
 *   <span class="[font-size:9px]">…</span> // flagged (arbitrary property)
 *   <span class="text-[10px]">▸</span>     // ok (scanning glyph; the role is reviewed, not linted)
 *   <span class="text-[11px]">Label</span> // ok
 *   <span class="text-xs">…</span>         // flagged: 0.75rem is 10.5px here, not 12px
 *
 * Whether a 10px string is a glyph or a label is a judgement design.md leaves to
 * review; this rule only closes the scale. `rem`, `em`, and `%` are converted at
 * 14px: `src/style.css` sets the root (and body) to 14px, so Tailwind's rem-based
 * named sizes run small — `text-xs` is 10.5px, which reads as the 12px helper
 * size in code and lands under the 11px label floor on screen. `em` and `%`
 * resolve against the parent, which is the 14px body unless something nearer
 * overrides it. Values that need layout to resolve (`calc()`, `vw`, `var()`,
 * keywords) are not evaluated.
 */

import { classTokens, staticStrings, utilityWithoutVariants } from "./class-tokens.mjs";

const SCANNING_PX = 10;
const LABEL_FLOOR_PX = 11;
const ROOT_PX = 14;
// CSS absolute units in px; relative units resolve against the 14px root/body.
const PX_PER_UNIT = {
  px: 1,
  pt: 4 / 3,
  pc: 16,
  in: 96,
  cm: 96 / 2.54,
  mm: 96 / 25.4,
  q: 96 / 101.6,
  rem: ROOT_PX,
  em: ROOT_PX,
  "%": ROOT_PX / 100,
};
// `text-[9px]`, `text-[length:9px]`, and the arbitrary property `[font-size:9px]`,
// each with an optional `/leading` modifier after the bracket. CSS numbers may
// carry a `+` sign and an exponent, and units are case-insensitive, so
// `[font-size:10.5PX]` still emits a 10.5px font size.
const ARBITRARY_TEXT_SIZE =
  /^(?:text-\[(?:length:)?|\[font-size:)(\+?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(px|pt|pc|in|cm|mm|q|rem|em|%)\](?:\/.*)?$/i;

function pixels(value, unit) {
  return Number(value) * PX_PER_UNIT[unit.toLowerCase()];
}

// 11px is 0.785714…rem at a 14px root, so a hand-written rem size only ever
// lands near a boundary; within a hundredth of a pixel counts as on it.
const TOLERANCE_PX = 0.01;

function isOffScale(px) {
  return px < LABEL_FLOOR_PX - TOLERANCE_PX && Math.abs(px - SCANNING_PX) > TOLERANCE_PX;
}

function formatPx(px) {
  return String(Math.round(px * 100) / 100);
}

/** @type {import("eslint").Rule.RuleModule} */
const rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "No text size under the docs/design.md 11px label floor except the 10px scanning size",
      recommended: true,
    },
    messages: {
      offScale:
        "`{{token}}` sets text at {{px}}px, off the docs/design.md small-text scale: 10px is for scanning-only glyphs and structural metadata, 11px is the floor for anything read as a label — see “Minimum size + contrast rules”.",
      remNamedSize:
        "`{{token}}` is 0.75rem, which is 10.5px on Drydock's 14px root — not 12px, and under the 11px label floor. Use `text-[12px]` for compact helper copy or `text-[11px]` for a label.",
    },
    schema: [],
  },

  create(context) {
    function check(node) {
      for (const text of staticStrings(node)) {
        for (const token of classTokens(text)) {
          const utility = utilityWithoutVariants(token);
          if (utility === "text-xs" || utility.startsWith("text-xs/")) {
            context.report({ node, messageId: "remNamedSize", data: { token } });
            continue;
          }
          const match = utility.match(ARBITRARY_TEXT_SIZE);
          if (!match) continue;
          const px = pixels(match[1], match[2]);
          if (isOffScale(px)) {
            context.report({ node, messageId: "offScale", data: { token, px: formatPx(px) } });
          }
        }
      }
    }

    return { Literal: check, TemplateLiteral: check };
  },
};

export default rule;
