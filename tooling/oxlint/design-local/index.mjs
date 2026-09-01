/**
 * Local oxlint JS plugin for project-specific design-system invariants that
 * `docs/design.md` states in prose and reviewers keep having to catch by eye.
 *
 * Loaded via `jsPlugins` in `.oxlintrc.json` under the `design-local` alias.
 * Rules:
 *   - design-local/no-stacked-section-rule
 */

import noStackedSectionRule from "./no-stacked-section-rule.mjs";

const plugin = {
  meta: {
    name: "design-local",
    version: "0.1.0",
  },
  rules: {
    "no-stacked-section-rule": noStackedSectionRule,
  },
};

export default plugin;
