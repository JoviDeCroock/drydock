/**
 * Keep text at or above the 10px floor from `docs/design.md`.
 *
 * The system has three small sizes with fixed roles: 10px is scanning-only
 * glyphs and structural metadata, 11px is the floor for anything the user reads
 * as a label, 12px is compact helper copy. Nothing below 10px has a role, and
 * an arbitrary `text-[9px]` is how one appears — it looks fine in a dense row on
 * a retina display and fails the reader on everything else.
 *
 *   <span class="text-[9px]">…</span>      // flagged
 *   <span class="text-[0.5rem]">…</span>   // flagged (8px)
 *   <span class="text-[10px]">▸</span>     // ok (scanning glyph; the role is reviewed, not linted)
 *   <span class="text-[11px]">Label</span> // ok
 *
 * Whether a 10px string is a glyph or a label is a judgement design.md leaves to
 * review; this rule only closes the floor.
 */

import { classTokens, staticStrings, utilityWithoutVariants } from "./class-tokens.mjs";

const FLOOR_PX = 10;
const ARBITRARY_TEXT_SIZE = /^text-\[(\d*\.?\d+)(px|rem|em)\]$/;

function pixels(value, unit) {
  const number = Number(value);
  return unit === "px" ? number : number * 16;
}

/** @type {import("eslint").Rule.RuleModule} */
const rule = {
  meta: {
    type: "problem",
    docs: {
      description: "No text size below the docs/design.md 10px floor",
      recommended: true,
    },
    messages: {
      belowFloor:
        "`{{token}}` sets text below the 10px floor. docs/design.md has no role for it: 10px is scanning-only glyphs, 11px is the floor for anything read as a label — see “Minimum size + contrast rules”.",
    },
    schema: [],
  },

  create(context) {
    function check(node) {
      for (const text of staticStrings(node)) {
        for (const token of classTokens(text)) {
          const match = utilityWithoutVariants(token).match(ARBITRARY_TEXT_SIZE);
          if (match && pixels(match[1], match[2]) < FLOOR_PX) {
            context.report({ node, messageId: "belowFloor", data: { token } });
          }
        }
      }
    }

    return { Literal: check, TemplateLiteral: check };
  },
};

export default rule;
