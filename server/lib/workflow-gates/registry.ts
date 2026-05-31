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

/** Ecosystems that currently have a registered workflow-gate adapter. */
export function supportedWorkflowGateEcosystems(): string[] {
  return Object.keys(WORKFLOW_GATE_ADAPTERS);
}
