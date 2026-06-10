/**
 * Local oxlint JS plugin for project-specific signal conventions.
 *
 * Loaded via `jsPlugins` in `.oxlintrc.json` under the `signals-local` alias.
 * Rules:
 *   - signals-local/no-signal-conditional-jsx
 */

import noSignalConditionalJsx from "./no-signal-conditional-jsx.mjs";

const plugin = {
  meta: {
    name: "signals-local",
    version: "0.1.0",
  },
  rules: {
    "no-signal-conditional-jsx": noSignalConditionalJsx,
  },
};

export default plugin;
