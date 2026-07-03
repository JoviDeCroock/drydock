import { npmWorkflowGateAdapter } from "./npm";
import { pypiWorkflowGateAdapter } from "./pypi";
import { rubygemsWorkflowGateAdapter } from "./rubygems";
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
  [rubygemsWorkflowGateAdapter.ecosystem]: rubygemsWorkflowGateAdapter,
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
 * (`detectArchiveEcosystems`), so we never have to make people declare which
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
 * Collect every ecosystem whose content detector claims a parsed archive: npm
 * claims an archive with a root `package.json`, PyPI an sdist with a root
 * `PKG-INFO`.
 *
 * A clean release artifact belongs to exactly one ecosystem, but npm tarballs
 * can ship arbitrary files — including a decoy `PKG-INFO` at the package root —
 * so an archive can present as more than one ecosystem. We must not resolve that
 * by registration order (it would silently route the npm publish through the
 * PyPI adapter and skip every npm lifecycle/`package.json` finding). The caller
 * therefore inspects the full claim set and fail-closes a multi-ecosystem match;
 * a maintainer resolves it by pinning the release target's ecosystem, which
 * bypasses content detection entirely.
 */
export function detectArchiveEcosystems(
  contents: ArchiveContents,
): { ecosystem: string; kind: string }[] {
  const claims: { ecosystem: string; kind: string }[] = [];
  for (const adapter of Object.values(WORKFLOW_GATE_ADAPTERS)) {
    const kind = adapter.detectArtifact(contents);
    if (kind) claims.push({ ecosystem: adapter.ecosystem, kind });
  }
  return claims;
}

/** Ecosystems that currently have a registered workflow-gate adapter. */
export function supportedWorkflowGateEcosystems(): string[] {
  return Object.keys(WORKFLOW_GATE_ADAPTERS);
}
