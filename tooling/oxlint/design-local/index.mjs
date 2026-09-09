/**
 * Local oxlint JS plugin for project-specific design-system invariants that
 * `docs/design.md` states in prose and reviewers keep having to catch by eye.
 *
 * Loaded via `jsPlugins` in `.oxlintrc.json` under the `design-local` alias.
 * Rules:
 *   - design-local/no-stacked-section-rule
 *   - design-local/no-off-system-color
 *   - design-local/no-sub-floor-text
 */

import noOffSystemColor from "./no-off-system-color.mjs";
import noStackedSectionRule from "./no-stacked-section-rule.mjs";
import noSubFloorText from "./no-sub-floor-text.mjs";

const plugin = {
  meta: {
    name: "design-local",
    version: "0.1.0",
  },
  rules: {
    "no-stacked-section-rule": noStackedSectionRule,
    "no-off-system-color": noOffSystemColor,
    "no-sub-floor-text": noSubFloorText,
  },
};

export default plugin;
