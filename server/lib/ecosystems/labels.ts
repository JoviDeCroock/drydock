/**
 * Human-facing ecosystem names, in a dependency-free module.
 *
 * The registry in `./index.ts` is the authority on ecosystems, but it imports
 * every adapter — brokers, registry fetch code, the sandbox client — so the
 * browser bundle must not reach for it just to render a name. Both the registry
 * and the UI read labels from here instead, so "PyPI" and "VS Code" are spelled
 * in one place without dragging server code into the client.
 */
export const ECOSYSTEM_LABELS = {
  npm: "npm",
  pypi: "PyPI",
  vscode: "VS Code",
  browser: "Browser extension",
  atpm: "atpm",
} as const;

export type EcosystemId = keyof typeof ECOSYSTEM_LABELS;

/** Narrow an arbitrary string to a known ecosystem id. */
export function isEcosystemId(id: string): id is EcosystemId {
  return id in ECOSYSTEM_LABELS;
}

/** Label for an ecosystem id, falling back to the id itself if unrecognized. */
export function ecosystemLabel(id: string): string {
  return ECOSYSTEM_LABELS[id as EcosystemId] ?? id;
}
