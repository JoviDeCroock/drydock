import { atpmAdapter } from "./atpm";
import { atpmPublicDiff } from "./atpm/public-diff";
import { atpmWorkflowGateAdapter } from "./atpm/workflow-gate";
import { npmAdapter } from "./npm";
import { npmPublicDiff } from "./npm/public-diff";
import { npmWorkflowGateAdapter } from "./npm/workflow-gate";
import { pypiPublicDiff } from "./pypi/public-diff";
import { pypiWorkflowGateAdapter } from "./pypi/workflow-gate";
import { vscodeWorkflowGateAdapter } from "./vscode/workflow-gate";
import type { AdapterBroker, PackageAdapter } from "./package-adapter";
import { ECOSYSTEM_LABELS } from "./labels";
import type { EcosystemId, EcosystemModule } from "./types";
import type { ArchiveContents, WorkflowGateAdapter } from "../workflow-gates/types";
import type { PublicDiffAdapter } from "../public-diff/types";

/**
 * The single registry of ecosystems and what each one supports.
 *
 * Read the capability fields as the answer to "how can a release of this kind
 * reach Drydock?":
 *
 *  - npm has all three — the registry stages candidates, Actions can gate a
 *    publish, and published versions diff anonymously on /diff.
 *  - PyPI cannot stage a candidate in the registry, so it has no `staged`
 *    adapter; releases reach review through a workflow gate.
 *  - VS Code is gate-only today: the Marketplace has no staging concept and the
 *    public diff surface does not cover extensions.
 *  - atpm has all three, and reaches every one of them without a credential:
 *    its staged candidates and published releases are both public records in
 *    the publisher's own AT Protocol repository, and its gate holds the
 *    *approval* job rather than the publish job.
 */
const ECOSYSTEM_MODULES: Record<EcosystemId, EcosystemModule> = {
  npm: {
    id: "npm",
    label: ECOSYSTEM_LABELS.npm,
    staged: npmAdapter as unknown as PackageAdapter<never, AdapterBroker>,
    gate: npmWorkflowGateAdapter,
    publicDiff: npmPublicDiff,
  },
  pypi: {
    id: "pypi",
    label: ECOSYSTEM_LABELS.pypi,
    gate: pypiWorkflowGateAdapter,
    publicDiff: pypiPublicDiff,
  },
  vscode: {
    id: "vscode",
    label: ECOSYSTEM_LABELS.vscode,
    gate: vscodeWorkflowGateAdapter,
  },
  atpm: {
    id: "atpm",
    label: ECOSYSTEM_LABELS.atpm,
    staged: atpmAdapter as unknown as PackageAdapter<never, AdapterBroker>,
    gate: atpmWorkflowGateAdapter,
    publicDiff: atpmPublicDiff,
  },
};

/** Every registered ecosystem, in registration order. */
export const ECOSYSTEMS: readonly EcosystemModule[] = Object.values(ECOSYSTEM_MODULES);

export function getEcosystem(id: string): EcosystemModule | undefined {
  return ECOSYSTEM_MODULES[id as EcosystemId];
}

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

/** Resolve the workflow-gate adapter for a release target's ecosystem. */
export function getWorkflowGateAdapter(ecosystem: string): WorkflowGateAdapter {
  const adapter = getEcosystem(ecosystem)?.gate;
  if (!adapter) throw new UnsupportedEcosystemError(ecosystem);
  return adapter;
}

/** Resolve the public-diff adapter for an ecosystem, or undefined if it has none. */
export function getPublicDiffAdapter(ecosystem: string): PublicDiffAdapter | undefined {
  return getEcosystem(ecosystem)?.publicDiff;
}

/**
 * Resolve the staged-review adapter for an ecosystem — the one that reviews a
 * release candidate the registry is holding, before its publisher approves it.
 * npm and atpm can both do that; PyPI and the Marketplace have no staging
 * concept, so their releases reach review through a workflow gate.
 */
export function getStagedAdapter(ecosystem: string): PackageAdapter<never, AdapterBroker> {
  const adapter = getEcosystem(ecosystem)?.staged;
  if (!adapter) throw new UnsupportedEcosystemError(ecosystem);
  return adapter;
}

/** Ecosystems whose registry can stage a release candidate for review. */
export function supportedStagedEcosystems(): string[] {
  return ECOSYSTEMS.filter((eco) => eco.staged).map((eco) => eco.id);
}

/** Ecosystems that currently have a registered workflow-gate adapter. */
export function supportedWorkflowGateEcosystems(): string[] {
  return ECOSYSTEMS.filter((eco) => eco.gate).map((eco) => eco.id);
}

/** Ecosystems the anonymous /diff surface can serve. */
export function supportedPublicDiffEcosystems(): string[] {
  return ECOSYSTEMS.filter((eco) => eco.publicDiff).map((eco) => eco.id);
}

function gateAdapters(): WorkflowGateAdapter[] {
  return ECOSYSTEMS.flatMap((eco) => (eco.gate ? [eco.gate] : []));
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
  for (const adapter of gateAdapters()) {
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
  for (const adapter of gateAdapters()) {
    const kind = adapter.detectArtifact(contents);
    if (kind) claims.push({ ecosystem: adapter.ecosystem, kind });
  }
  return claims;
}

// The id set itself lives in ./labels (dependency-free, importable from the UI).
export { isEcosystemId } from "./labels";
export type { EcosystemModule } from "./types";
