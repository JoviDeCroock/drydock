import { pypiWorkflowGateAdapter } from "./pypi";
import type { WorkflowGateAdapter } from "./types";

/**
 * Thrown when a release target names an ecosystem that has no registered
 * workflow-gate adapter. The runner treats this as an internal review error
 * (the gate stays pending, never auto-approved) rather than an artifact
 * verification failure, since it is a configuration/data problem.
 */
export class UnsupportedEcosystemError extends Error {
  constructor(public ecosystem: string) {
    super(`no workflow-gate adapter registered for ecosystem ${ecosystem}`);
    this.name = "UnsupportedEcosystemError";
  }
}

const WORKFLOW_GATE_ADAPTERS: Record<string, WorkflowGateAdapter> = {
  [pypiWorkflowGateAdapter.ecosystem]: pypiWorkflowGateAdapter,
};

/** Resolve the workflow-gate adapter for a release target's ecosystem. */
export function getWorkflowGateAdapter(ecosystem: string): WorkflowGateAdapter {
  const adapter = WORKFLOW_GATE_ADAPTERS[ecosystem];
  if (!adapter) throw new UnsupportedEcosystemError(ecosystem);
  return adapter;
}

/**
 * Classify a bundle entry across every registered ecosystem for an auto-detect
 * release target (one that does not pin an ecosystem). The first adapter whose
 * `classifyArtifact` claims the path wins; entries no adapter claims are dropped.
 *
 * A path can in principle look like two ecosystems' artifacts, but in practice
 * the suffixes are disjoint (`.whl`/`.tar.gz` vs other ecosystems'), so order
 * only matters for genuinely ambiguous names — which we treat as the first
 * registered match deterministically rather than erroring.
 */
export function classifyBundleArtifact(path: string): { ecosystem: string; kind: string } | null {
  for (const adapter of Object.values(WORKFLOW_GATE_ADAPTERS)) {
    const kind = adapter.classifyArtifact(path);
    if (kind) return { ecosystem: adapter.ecosystem, kind };
  }
  return null;
}

/** Ecosystems that currently have a registered workflow-gate adapter. */
export function supportedWorkflowGateEcosystems(): string[] {
  return Object.keys(WORKFLOW_GATE_ADAPTERS);
}
