import { execFileSync } from "node:child_process";

const REUSABLE_WORKFLOW = ".github/workflows/drydock-diff-link.yml";

// The Docs snippet pins adopters to the last commit that changed the reusable
// workflow, not HEAD, so the published hash only moves when the workflow does.
// A shallow clone answers with its one commit, which still contains the file.
export function diffLinkWorkflowRef() {
  const sha = execFileSync("git", ["log", "-1", "--format=%H", "--", REUSABLE_WORKFLOW], {
    encoding: "utf8",
  }).trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`No commit found for ${REUSABLE_WORKFLOW}; the Docs snippet needs one.`);
  }
  return sha;
}
