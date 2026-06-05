import { npmWorkflowGateAdapter } from "./npm";
import { pypiWorkflowGateAdapter } from "./pypi";
import type { ArchiveContents, WorkflowGateAdapter } from "./types";

/**
 * Sentinel ecosystem assigned to a kept bundle entry whose extension more than
 * one ecosystem claims (an npm `.tgz` vs a PyPI sdist `.tar.gz`). The shared
 * router resolves the real ecosystem by parsing the bytes and asking each
 * adapter's `detectArtifact`; the sentinel never reaches an adapter.
 */
export const AMBIGUOUS_ARCHIVE_ECOSYSTEM = "archive";

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
  [npmWorkflowGateAdapter.ecosystem]: npmWorkflowGateAdapter,
};

/** Resolve the workflow-gate adapter for a release target's ecosystem. */
export function getWorkflowGateAdapter(ecosystem: string): WorkflowGateAdapter {
  const adapter = WORKFLOW_GATE_ADAPTERS[ecosystem];
  if (!adapter) throw new UnsupportedEcosystemError(ecosystem);
  return adapter;
}

/**
 * Classify a bundle entry across every registered ecosystem for an auto-detect
 * release target (one that does not pin an ecosystem). Entries no adapter claims
 * are dropped; an entry exactly one adapter claims is tagged with that
 * ecosystem.
 *
 * When more than one ecosystem claims the same path — an npm `.tgz` is byte- and
 * name-indistinguishable from a PyPI sdist `.tar.gz` — the entry is kept but
 * tagged with the `AMBIGUOUS_ARCHIVE_ECOSYSTEM` sentinel. The shared router then
 * parses the bytes and resolves the real ecosystem by content
 * (`detectArchiveEcosystem`), so we never have to make people declare which
 * ecosystem they are publishing.
 */
export function classifyBundleArtifact(path: string): { ecosystem: string; kind: string } | null {
  const claims: { ecosystem: string; kind: string }[] = [];
  for (const adapter of Object.values(WORKFLOW_GATE_ADAPTERS)) {
    const kind = adapter.classifyArtifact(path);
    if (kind) claims.push({ ecosystem: adapter.ecosystem, kind });
  }
  if (claims.length === 0) return null;
  if (claims.length === 1) return claims[0];
  return { ecosystem: AMBIGUOUS_ARCHIVE_ECOSYSTEM, kind: "archive" };
}

/**
 * Resolve an ambiguous archive's ecosystem from its parsed contents. The first
 * adapter whose `detectArtifact` claims the contents wins; npm claims an archive
 * with a root `package.json`, PyPI an sdist with a `PKG-INFO`. Returns `null`
 * when no ecosystem recognizes the archive (the runner fail-closes the gate).
 */
export function detectArchiveEcosystem(
  contents: ArchiveContents,
): { ecosystem: string; kind: string } | null {
  for (const adapter of Object.values(WORKFLOW_GATE_ADAPTERS)) {
    const kind = adapter.detectArtifact(contents);
    if (kind) return { ecosystem: adapter.ecosystem, kind };
  }
  return null;
}

/** Ecosystems that currently have a registered workflow-gate adapter. */
export function supportedWorkflowGateEcosystems(): string[] {
  return Object.keys(WORKFLOW_GATE_ADAPTERS);
}
