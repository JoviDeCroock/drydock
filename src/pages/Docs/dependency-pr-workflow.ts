import repositoryCaller from "../../../.github/workflows/dependency-pr-diff.yml?raw";

export const REUSABLE_WORKFLOW = "JoviDeCroock/drydock/.github/workflows/drydock-diff-link.yml";

// The documented snippet is the caller this repository runs on its own
// dependency PRs, so the published copy cannot drift from the exercised one.
// The only difference is the reference: adopters reach the reusable workflow
// in this repository instead of a local path.
export function publishedDependencyPrWorkflow(source: string): string {
  const local = /^(\s*uses: )\.\/\.github\/workflows\/drydock-diff-link\.yml$/m;
  if (!local.test(source)) throw new Error("dependency PR caller lost its local uses: line");
  return source.replace(local, `$1${REUSABLE_WORKFLOW}@main`).trimEnd();
}

export const DEPENDENCY_PR_WORKFLOW = publishedDependencyPrWorkflow(repositoryCaller);
