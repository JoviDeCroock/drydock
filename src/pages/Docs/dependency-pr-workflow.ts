import repositoryWorkflow from "../../../.github/workflows/drydock-diff-link.yml?raw";

// The documented snippet is the workflow this repository runs on its own
// dependency PRs, so the published copy cannot drift from the exercised one.
// Two differences are intended: the header comment that addresses this
// repository is dropped, and actions pinned to a commit (the ci.yml
// convention) float on their major tag for adopters.
export function publishedDependencyPrWorkflow(source: string): string {
  const [nameLine, blank, ...rest] = source.split("\n");
  let start = 0;
  while (rest[start]?.startsWith("#")) start += 1;
  if (rest[start] === "") start += 1;
  return [nameLine, blank, ...rest.slice(start)]
    .join("\n")
    .replace(/^(\s*(?:- )?uses: [^@\s]+)@[0-9a-f]{40} # (v\d+)\S*$/gm, "$1@$2")
    .trimEnd();
}

export const DEPENDENCY_PR_WORKFLOW = publishedDependencyPrWorkflow(repositoryWorkflow);
