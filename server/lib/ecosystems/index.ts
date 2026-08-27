import { atpmPublicDiff } from "./atpm/public-diff";
import { npmAdapter } from "./npm";
import { npmPublicDiff } from "./npm/public-diff";
import { npmWorkflowGateAdapter } from "./npm/workflow-gate";
import { pypiPublicDiff } from "./pypi/public-diff";
import { pypiWorkflowGateAdapter } from "./pypi/workflow-gate";
import { vscodeWorkflowGateAdapter } from "./vscode/workflow-gate";
import type { AdapterBroker, PackageAdapter } from "./package-adapter";
import { publishedPairAdapter, type PublishedPairAdapter } from "./published-pair";
import { ECOSYSTEM_LABELS } from "./labels";
import type { EcosystemId, EcosystemModule } from "./types";
import type { ArchiveContents, WorkflowGateAdapter } from "../workflow-gates/types";
import type { PublicDiffAdapter } from "../public-diff/types";

const ECOSYSTEM_MODULES: Record<EcosystemId, EcosystemModule> = {
  npm: {
    id: "npm",
    label: ECOSYSTEM_LABELS.npm,
    staged: npmAdapter as unknown as PackageAdapter<never, AdapterBroker>,
    gate: npmWorkflowGateAdapter,
    publicDiff: npmPublicDiff,
    published: publishedPairAdapter(npmPublicDiff),
  },
  pypi: {
    id: "pypi",
    label: ECOSYSTEM_LABELS.pypi,
    gate: pypiWorkflowGateAdapter,
    publicDiff: pypiPublicDiff,
    published: publishedPairAdapter(pypiPublicDiff),
  },
  vscode: {
    id: "vscode",
    label: ECOSYSTEM_LABELS.vscode,
    gate: vscodeWorkflowGateAdapter,
  },
  atpm: {
    id: "atpm",
    label: ECOSYSTEM_LABELS.atpm,
    publicDiff: atpmPublicDiff,
  },
};

export const ECOSYSTEMS: readonly EcosystemModule[] = Object.values(ECOSYSTEM_MODULES);

export function getEcosystem(id: string): EcosystemModule | undefined {
  return ECOSYSTEM_MODULES[id as EcosystemId];
}

export const AMBIGUOUS_ARCHIVE_ECOSYSTEM = "archive";

export class UnsupportedEcosystemError extends Error {
  constructor(public ecosystem: string) {
    super(`no workflow-gate adapter registered for ecosystem ${ecosystem}`);
    this.name = "UnsupportedEcosystemError";
  }
}

export function getWorkflowGateAdapter(ecosystem: string): WorkflowGateAdapter {
  const adapter = getEcosystem(ecosystem)?.gate;
  if (!adapter) throw new UnsupportedEcosystemError(ecosystem);
  return adapter;
}

export function getPublicDiffAdapter(ecosystem: string): PublicDiffAdapter | undefined {
  return getEcosystem(ecosystem)?.publicDiff;
}

export function getPublishedAdapter(ecosystem: string): PublishedPairAdapter | undefined {
  return getEcosystem(ecosystem)?.published;
}

export function getStagedAdapter(ecosystem: string): PackageAdapter<never, AdapterBroker> {
  const adapter = getEcosystem(ecosystem)?.staged;
  if (!adapter) throw new UnsupportedEcosystemError(ecosystem);
  return adapter;
}

export function supportedStagedEcosystems(): string[] {
  return ECOSYSTEMS.filter((eco) => eco.staged).map((eco) => eco.id);
}

export function supportedWorkflowGateEcosystems(): string[] {
  return ECOSYSTEMS.filter((eco) => eco.gate).map((eco) => eco.id);
}

export function gateSetupEcosystemOptions(): Array<{ id: string; label: string }> {
  return ECOSYSTEMS.filter((eco) => eco.gate?.gateSetupTemplate).map((eco) => ({
    id: eco.id,
    label: eco.label,
  }));
}

export function supportedPublicDiffEcosystems(): string[] {
  return ECOSYSTEMS.filter((eco) => eco.publicDiff).map((eco) => eco.id);
}

export function supportedPublishedEcosystems(): string[] {
  return ECOSYSTEMS.filter((eco) => eco.published).map((eco) => eco.id);
}

function gateAdapters(): WorkflowGateAdapter[] {
  return ECOSYSTEMS.flatMap((eco) => (eco.gate ? [eco.gate] : []));
}

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

// Return every claim so ambiguous hostile archives fail closed at the caller.
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

export { isEcosystemId } from "./labels";
export type { EcosystemModule } from "./types";
