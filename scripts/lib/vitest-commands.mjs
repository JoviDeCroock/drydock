// The one place that knows how the two Vitest projects are spawned. Both
// scripts/test.mjs and scripts/verify.mjs build their check lists from these,
// so a project rename or a new flag changes in one file.
//
// Every builder returns `{ name, args }` entries for `spawn("pnpm", args)`.

const VITEST_PROJECTS = ["node", "workers"];

function vitestRunArgs(project, ...extra) {
  return ["exec", "vitest", "run", "--project", project, ...extra];
}

// One `vitest run` per project, so the fast node suite overlaps with the slow
// Cloudflare-worker pool instead of running after it. The workers project
// parallelizes internally (reused pool workers, see vitest.config.ts) and needs
// no external sharding; one process keeps a single shared Vite transform cache.
export function vitestProjectChecks({ prefix = "", suffix = "", extra = [] } = {}) {
  return VITEST_PROJECTS.map((project) => ({
    name: `${prefix}${project}${suffix}`,
    args: vitestRunArgs(project, ...extra),
  }));
}

// `related` resolves importers through Vite's module graph, so a change to a
// widely imported helper still fans out to every suite that depends on it; a
// leaf file runs only its own tests. `--passWithNoTests` keeps a file with no
// importers in one project (UI code and the workers project) green.
export function vitestRelatedChecks(files) {
  return VITEST_PROJECTS.map((project) => ({
    name: `test:${project}:related`,
    args: [
      "exec",
      "vitest",
      "related",
      ...files,
      "--run",
      "--project",
      project,
      "--passWithNoTests",
    ],
  }));
}

// Markdown is read, not imported, so `related` cannot see the prose checks
// (path and command references, the agent context budget).
export function vitestProseCheck() {
  return {
    name: "test:prose",
    args: vitestRunArgs("node", "test/prose-", "test/agent-context-budget"),
  };
}
