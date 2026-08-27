/**
 * The docs table of contents.
 *
 * Section ids double as the scroll-spy targets and the in-page anchors, so
 * the order here is the order on the page.
 */

export const TOC: Array<{
  id: string;
  label: string;
  children: Array<{ id: string; label: string }>;
}> = [
  {
    id: "start-here",
    label: "Start here",
    children: [
      { id: "artifact-gap", label: "The artifact gap" },
      { id: "review-loop", label: "The review loop" },
      { id: "inside-report", label: "Inside a report" },
      { id: "safety-model", label: "Safety model" },
    ],
  },
  {
    id: "choose-path",
    label: "Choose a release path",
    children: [{ id: "path-comparison", label: "Compare the paths" }],
  },
  {
    id: "staged-publishing",
    label: "Stage Watchtower — advisory",
    children: [
      { id: "staged-setup", label: "Connect npm" },
      { id: "staged-lifecycle", label: "Run a review" },
      { id: "staged-enforcement", label: "Narrow CI to staging" },
    ],
  },
  {
    id: "workflow-gating",
    label: "Workflow Gate — enforced",
    children: [
      { id: "gate-setup", label: "Connect GitHub" },
      { id: "gate-bundle", label: "Prepare the artifacts" },
      { id: "gate-workflow", label: "Workflow examples" },
      { id: "gate-decision", label: "Approve or reject" },
    ],
  },
  {
    id: "dependency-updates",
    label: "Diffs in dependency PRs",
    children: [
      { id: "renovate-diff-links", label: "Renovate" },
      { id: "dependabot-diff-links", label: "Dependabot" },
      { id: "diff-capabilities", label: "Capabilities" },
      { id: "diff-verdict-api", label: "Verdict API" },
    ],
  },
];

export const TOC_IDS = TOC.flatMap((section) => [section.id, ...section.children.map((c) => c.id)]);
