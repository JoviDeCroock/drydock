import type { HoldReason, UnreviewedReason } from "./types";

// One phrase per reason, read by the check run and the dashboard alike, so a
// reviewer sees the same words on GitHub and in Drydock. Plain text: the check
// run embeds them in markdown and the UI renders them as text.
export const HOLD_REASON_TEXT: Record<HoldReason, string> = {
  "install-script-added": "adds an install script",
  "install-script-changed": "changes an install script",
  "native-binary-added": "adds a native binary",
  "dependency-added": "adds a dependency",
  "bin-command-added": "adds a bin command",
  "release-risk": "release risk at or above the hold threshold",
  "uninspected-files": "changes files or artifacts Drydock could not read",
  unreviewed: "no Drydock verdict",
  "new-package": "new package with no previous version to compare",
};

export const UNREVIEWED_TEXT: Record<UnreviewedReason, string> = {
  "over-cap": "over the per-PR review limit",
  "not-found": "not found on the public registry",
  unsupported: "Drydock can't diff this version",
  failed: "the diff failed",
  "timed-out": "the diff timed out",
  "private-source": "comes from a registry Drydock can't read",
};
