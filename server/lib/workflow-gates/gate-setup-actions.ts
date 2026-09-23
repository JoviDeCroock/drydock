/**
 * The GitHub Actions every generated gate workflow uses, pinned to full commit
 * SHAs with the release in a trailing comment.
 *
 * These steps run next to the publish credential — `id-token: write`, or a
 * Marketplace PAT — and whoever controls an action's repository can move a tag
 * to new code; they cannot move a commit. The trailing `# vX.Y.Z` is the shape
 * Dependabot's `github-actions` updates recognize, so a maintainer who enables
 * them gets reviewable bumps instead of silent drift.
 *
 * Bumping a pin here changes every workflow the wizard generates from then on.
 * Resolve the tag to its commit (`gh api repos/<owner>/<repo>/git/ref/tags/<tag>`,
 * then dereference an annotated tag) rather than copying a SHA from a README.
 */
export const GATE_SETUP_ACTIONS = {
  checkout: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1",
  setupNode: "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0",
  setupPython: "actions/setup-python@5fda3b95a4ea91299a34e894583c3862153e4b97 # v7.0.0",
  uploadArtifact: "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1",
  downloadArtifact: "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1",
} as const;

/**
 * The npm CLI a generated publish job installs before it touches the registry
 * or the lockfile. npm's OIDC trusted publishing needs >= 11.5.1, newer than
 * the npm bundled with Node 22, and `--allow-git` (which keeps a git
 * dependency's prepare scripts from running beside a credential) is npm 11
 * only. These jobs hold `id-token: write` or a Marketplace PAT, so it is an
 * exact version, bumped deliberately, never a range a compromised release
 * could satisfy. npm bundles its own dependencies, so the version pins
 * everything it loads.
 */
export const GATE_SETUP_NPM_CLI_VERSION = "11.19.1";

/** The hardening note every template carries about the pins above. */
export const GATE_SETUP_PINNING_NOTE =
  "Every action is pinned to a full commit SHA, with its release in the trailing comment: a tag can be moved to new code, a commit cannot. Let Dependabot's `github-actions` updates move the pins, and review those bumps like any other change to the release path.";
