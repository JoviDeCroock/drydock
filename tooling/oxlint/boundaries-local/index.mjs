/**
 * Local oxlint JS plugin for project structure boundaries.
 *
 * Loaded via `jsPlugins` in `.oxlintrc.json` under the `boundaries-local` alias.
 * Rules:
 *   - boundaries-local/no-cross-page-import
 *   - boundaries-local/no-platform-domain-import
 */

import noCrossPageImport from "./no-cross-page-import.mjs";
import noPlatformDomainImport from "./no-platform-domain-import.mjs";

const plugin = {
  meta: {
    name: "boundaries-local",
    version: "0.1.0",
  },
  rules: {
    "no-cross-page-import": noCrossPageImport,
    "no-platform-domain-import": noPlatformDomainImport,
  },
};

export default plugin;
